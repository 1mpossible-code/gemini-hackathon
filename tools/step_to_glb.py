#!/usr/bin/env python3
"""Convert a vendor STEP assembly to a glTF binary (GLB) in metres.

CadQuery is imported only when a conversion runs. Install it in a temporary
environment. This repository does not depend on it.

The STEP reader targets millimetres. Open CASCADE scales a declared length
unit to that target, and this tool then writes glTF coordinates in metres
(the glTF 2.0 unit). STEP is Z-up. glTF is Y-up. Vertex positions, normals,
and node matrices are rotated by -90 degrees about X, which sends
(x, y, z) to (x, z, -y).

Assembly and component names from the STEP document are kept as glTF node
names when the reader returns them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any

MM_TO_M = 0.001
# Column-major Rx(-90°): STEP Z-up to glTF Y-up. det = 1.
_S = ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, -1.0, 0.0))
_S_INV = ((1.0, 0.0, 0.0), (0.0, 0.0, -1.0), (0.0, 1.0, 0.0))
_IDENTITY = (
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
)

GLTF_MAGIC = b"glTF"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
FLOAT = 5126
UNSIGNED_SHORT = 5123
UNSIGNED_INT = 5125


def _matvec(
    matrix: tuple[tuple[float, float, float], ...],
    vector: tuple[float, float, float],
) -> tuple[float, float, float]:
    return tuple(
        matrix[row][0] * vector[0] + matrix[row][1] * vector[1] + matrix[row][2] * vector[2]
        for row in range(3)
    )


def _matmul(
    left: tuple[tuple[float, float, float], ...],
    right: tuple[tuple[float, float, float], ...],
) -> tuple[tuple[float, float, float], ...]:
    return tuple(
        tuple(sum(left[i][k] * right[k][j] for k in range(3)) for j in range(3))
        for i in range(3)
    )


def _step_point_to_gltf(x: float, y: float, z: float) -> tuple[float, float, float]:
    return (x * MM_TO_M, z * MM_TO_M, -y * MM_TO_M)


def _normalize(x: float, y: float, z: float) -> tuple[float, float, float]:
    length = math.sqrt(x * x + y * y + z * z)
    if length == 0.0:
        return (0.0, 1.0, 0.0)
    return (x / length, y / length, z / length)


def _trsf_to_gltf_matrix(trsf: Any) -> list[float]:
    """Conjugate a STEP gp_Trsf into the glTF frame, with translation in metres."""
    linear = tuple(tuple(trsf.Value(row, col) for col in range(1, 4)) for row in range(1, 4))
    translation = tuple(trsf.Value(row, 4) * MM_TO_M for row in range(1, 4))
    conjugated = _matmul(_S, _matmul(linear, _S_INV))
    moved = _matvec(_S, translation)
    return [
        conjugated[0][0], conjugated[1][0], conjugated[2][0], 0.0,
        conjugated[0][1], conjugated[1][1], conjugated[2][1], 0.0,
        conjugated[0][2], conjugated[1][2], conjugated[2][2], 0.0,
        moved[0], moved[1], moved[2], 1.0,
    ]


def _is_identity(matrix: list[float] | tuple[float, ...], eps: float = 1e-8) -> bool:
    return all(abs(value - expected) <= eps for value, expected in zip(matrix, _IDENTITY))


def _multiply_matrix(
    parent: list[float] | tuple[float, ...],
    local: list[float] | tuple[float, ...],
) -> list[float]:
    out = [0.0] * 16
    for col in range(4):
        for row in range(4):
            out[col * 4 + row] = sum(
                parent[k * 4 + row] * local[col * 4 + k] for k in range(4)
            )
    return out


def _transform_point(
    matrix: list[float] | tuple[float, ...],
    point: tuple[float, float, float],
) -> tuple[float, float, float]:
    x, y, z = point
    return (
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    )


def _triangulate(
    shape: Any, linear_mm: float, angular_rad: float
) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    """Mesh in absolute millimetres and return vertices in the shape's local STEP frame."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopAbs import TopAbs_Orientation
    from OCP.TopLoc import TopLoc_Location

    # relative=False keeps linear_mm as an absolute deflection. Shape.tessellate
    # remeshes with a relative deflection, which is the wrong unit for this tool.
    BRepMesh_IncrementalMesh(shape.wrapped, linear_mm, False, angular_rad, True)
    vertices: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []
    for face in shape.Faces():
        location = TopLoc_Location()
        poly = BRep_Tool.Triangulation_s(face.wrapped, location)
        if poly is None:
            continue
        trsf = location.Transformation()
        nodes = [
            poly.Node(index).Transformed(trsf).Coord()
            for index in range(1, poly.NbNodes() + 1)
        ]
        base = len(vertices)
        vertices.extend(nodes)
        reverse = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
        for index in range(1, poly.NbTriangles() + 1):
            i1, i2, i3 = poly.Triangle(index).Get()
            if reverse:
                i1, i2, i3 = i1, i3, i2
            a, b, c = nodes[i1 - 1], nodes[i2 - 1], nodes[i3 - 1]
            if a == b or b == c or a == c:
                continue
            triangles.append((base + i1 - 1, base + i2 - 1, base + i3 - 1))
    return vertices, triangles


def _as_shape(obj: Any) -> Any | None:
    if obj is None:
        return None
    if hasattr(obj, "wrapped") and hasattr(obj, "Faces"):
        return obj
    if hasattr(obj, "val"):
        return obj.val()
    raise TypeError(f"Unsupported assembly object {type(obj).__name__}")


def _color_tuple(color: Any) -> tuple[float, float, float, float] | None:
    if color is None:
        return None
    if hasattr(color, "toTuple"):
        values = tuple(float(channel) for channel in color.toTuple())
    else:
        wrapped = color.wrapped
        values = (wrapped.Red(), wrapped.Green(), wrapped.Blue(), wrapped.Alpha())
    if len(values) == 3:
        values = (*values, 1.0)
    return values


MeshArrays = tuple[
    list[tuple[float, float, float]],
    list[tuple[float, float, float]],
    list[tuple[int, int, int]],
]


def _mesh_from_shape(shape: Any, linear_mm: float, angular_rad: float) -> MeshArrays | None:
    step_vertices, triangles = _triangulate(shape, linear_mm, angular_rad)
    if not triangles:
        return None
    positions = [_step_point_to_gltf(*vertex) for vertex in step_vertices]
    volume = 0.0
    for i, j, k in triangles:
        ax, ay, az = positions[i]
        bx, by, bz = positions[j]
        cx, cy, cz = positions[k]
        volume += (
            ax * (by * cz - bz * cy)
            + ay * (bz * cx - bx * cz)
            + az * (bx * cy - by * cx)
        )
    if volume < 0.0:
        triangles = [(i, k, j) for i, j, k in triangles]
    normals = [[0.0, 0.0, 0.0] for _ in positions]
    kept: list[tuple[int, int, int]] = []
    for i, j, k in triangles:
        ax, ay, az = positions[i]
        bx, by, bz = positions[j]
        cx, cy, cz = positions[k]
        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        if nx == 0.0 and ny == 0.0 and nz == 0.0:
            continue
        kept.append((i, j, k))
        for index in (i, j, k):
            normals[index][0] += nx
            normals[index][1] += ny
            normals[index][2] += nz
    if not kept:
        return None
    unit_normals = [_normalize(*normal) for normal in normals]
    return positions, unit_normals, kept


class _Glb:
    def __init__(self) -> None:
        self.buffer = bytearray()
        self.views: list[dict[str, int]] = []
        self.accessors: list[dict[str, Any]] = []
        self.materials: list[dict[str, Any]] = []
        self.meshes: list[dict[str, Any]] = []
        self.nodes: list[dict[str, Any]] = []
        self._material_ids: dict[tuple[float, float, float, float] | None, int] = {}
        self._mesh_ids: dict[str, int] = {}

    def _align(self) -> None:
        while len(self.buffer) % 4:
            self.buffer.append(0)

    def _view(self, data: bytes, target: int) -> int:
        self._align()
        view = {
            "buffer": 0,
            "byteOffset": len(self.buffer),
            "byteLength": len(data),
            "target": target,
        }
        self.buffer.extend(data)
        self.views.append(view)
        return len(self.views) - 1

    def _accessor(self, view: int, **fields: Any) -> int:
        self.accessors.append({"bufferView": view, **fields})
        return len(self.accessors) - 1

    def material(self, color: tuple[float, float, float, float] | None) -> int:
        key = None if color is None else tuple(round(channel, 5) for channel in color)
        if key in self._material_ids:
            return self._material_ids[key]
        if color is None:
            factor = [0.62, 0.62, 0.64, 1.0]
            name = "uncolored"
        else:
            factor = [color[0], color[1], color[2], color[3]]
            channels = [round(channel * 255) for channel in color[:3]]
            name = "step-color-" + "-".join(str(channel) for channel in channels)
        self.materials.append(
            {
                "name": name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": factor,
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.55,
                },
            }
        )
        self._material_ids[key] = len(self.materials) - 1
        return self._material_ids[key]

    def mesh(
        self,
        name: str,
        positions: list[tuple[float, float, float]],
        normals: list[tuple[float, float, float]],
        triangles: list[tuple[int, int, int]],
        material: int,
    ) -> int:
        position_blob = b"".join(struct.pack("<3f", *point) for point in positions)
        normal_blob = b"".join(struct.pack("<3f", *normal) for normal in normals)
        flat = [index for triangle in triangles for index in triangle]
        if max(flat) > 65535:
            index_blob = b"".join(struct.pack("<I", index) for index in flat)
            index_type = UNSIGNED_INT
        else:
            index_blob = b"".join(struct.pack("<H", index) for index in flat)
            index_type = UNSIGNED_SHORT
        digest = hashlib.sha256(
            position_blob + b"\0" + index_blob + bytes([material])
        ).hexdigest()
        cached = self._mesh_ids.get(digest)
        if cached is not None:
            return cached
        axes = list(zip(*positions))
        position_view = self._view(position_blob, ARRAY_BUFFER)
        normal_view = self._view(normal_blob, ARRAY_BUFFER)
        index_view = self._view(index_blob, ELEMENT_ARRAY_BUFFER)
        position_accessor = self._accessor(
            position_view,
            componentType=FLOAT,
            count=len(positions),
            type="VEC3",
            min=[min(axis) for axis in axes],
            max=[max(axis) for axis in axes],
        )
        normal_accessor = self._accessor(
            normal_view, componentType=FLOAT, count=len(normals), type="VEC3"
        )
        index_accessor = self._accessor(
            index_view, componentType=index_type, count=len(flat), type="SCALAR"
        )
        self.meshes.append(
            {
                "name": name,
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": position_accessor,
                            "NORMAL": normal_accessor,
                        },
                        "indices": index_accessor,
                        "material": material,
                    }
                ],
            }
        )
        self._mesh_ids[digest] = len(self.meshes) - 1
        return self._mesh_ids[digest]

    def add_node(
        self,
        name: str,
        matrix: list[float] | None,
        mesh: int | None,
        children: list[int],
    ) -> int:
        node: dict[str, Any] = {"name": name}
        if matrix is not None and not _is_identity(matrix):
            node["matrix"] = matrix
        if mesh is not None:
            node["mesh"] = mesh
        if children:
            node["children"] = children
        self.nodes.append(node)
        return len(self.nodes) - 1

    def pack(self, asset_extra: dict[str, Any], scene_name: str, root: int) -> bytes:
        self._align()
        document: dict[str, Any] = {
            "asset": asset_extra,
            "scene": 0,
            "scenes": [{"name": scene_name, "nodes": [root]}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.views,
            "buffers": [{"byteLength": len(self.buffer)}],
        }
        # Trailing space keeps the JSON chunk from ending inside a number if padded.
        payload = json.dumps(document, separators=(",", ":")).encode("utf-8")
        while (len(payload) + 0) % 4:
            payload += b" "
        while len(self.buffer) % 4:
            self.buffer.append(0)
        chunks = b"".join(
            (
                struct.pack("<II", len(payload), JSON_CHUNK),
                payload,
                struct.pack("<II", len(self.buffer), BIN_CHUNK),
                bytes(self.buffer),
            )
        )
        header = struct.pack("<4sII", GLTF_MAGIC, 2, 12 + len(chunks))
        return header + chunks


def _walk(
    assembly: Any,
    builder: _Glb,
    linear_mm: float,
    angular_rad: float,
    unnamed: list[int],
) -> int:
    shape = _as_shape(assembly.obj)
    mesh_id = None
    name = assembly.name or ""
    if not name:
        unnamed[0] += 1
        name = f"unnamed-{unnamed[0]}"
    if shape is not None:
        meshed = _mesh_from_shape(shape, linear_mm, angular_rad)
        if meshed is not None:
            positions, normals, triangles = meshed
            mesh_id = builder.mesh(
                name,
                positions,
                normals,
                triangles,
                builder.material(_color_tuple(assembly.color)),
            )
    children = [
        _walk(child, builder, linear_mm, angular_rad, unnamed) for child in assembly.children
    ]
    matrix = _trsf_to_gltf_matrix(assembly.loc.wrapped.Transformation())
    return builder.add_node(name, matrix, mesh_id, children)


def _load_assembly(step_path: Path):
    try:
        import cadquery as cq
    except ImportError as exc:
        raise SystemExit(
            "CadQuery is not installed. Install it in a temporary environment. "
            "Do not add it to the project dependencies.\n"
            "  uv venv /tmp/forge-step-to-glb --python 3.12\n"
            "  uv pip install --python /tmp/forge-step-to-glb/bin/python cadquery\n"
            "  /tmp/forge-step-to-glb/bin/python tools/step_to_glb.py INPUT.step OUTPUT.glb"
        ) from exc
    try:
        return cq.Assembly.importStep(str(step_path))
    except ValueError as exc:
        if "does not contain an assembly" not in str(exc):
            raise
        shape = cq.Shape.importStep(str(step_path))
        return cq.Assembly(shape, name=step_path.stem)


def _step_bounds(assembly: Any) -> dict[str, list[float]]:
    box = assembly.toCompound().BoundingBox()
    minimum = [box.xmin, box.ymin, box.zmin]
    maximum = [box.xmax, box.ymax, box.zmax]
    size = [hi - lo for lo, hi in zip(minimum, maximum)]
    return {"min_mm": minimum, "max_mm": maximum, "size_mm": size}


def _expected_gltf_bounds(step_bounds: dict[str, list[float]]) -> dict[str, list[float]]:
    xmin, ymin, zmin = step_bounds["min_mm"]
    xmax, ymax, zmax = step_bounds["max_mm"]
    minimum = [xmin * MM_TO_M, zmin * MM_TO_M, -ymax * MM_TO_M]
    maximum = [xmax * MM_TO_M, zmax * MM_TO_M, -ymin * MM_TO_M]
    size = [hi - lo for lo, hi in zip(minimum, maximum)]
    return {"min_m": minimum, "max_m": maximum, "size_m": size}


def convert_step(
    step_path: Path,
    glb_path: Path,
    *,
    linear_mm: float,
    angular_rad: float,
    copyright_text: str | None,
    license_notice: str | None,
    source_url: str | None,
) -> dict[str, Any]:
    assembly = _load_assembly(step_path)
    step_bounds = _step_bounds(assembly)
    builder = _Glb()
    root = _walk(assembly, builder, linear_mm, angular_rad, [0])
    if not builder.meshes:
        raise SystemExit(f"No triangles were produced from {step_path}.")
    extras: dict[str, Any] = {
        "units": "m",
        "sourceLengthTarget": "mm",
        "millimetersPerMeter": 1000,
        "coordinateSystem": "glTF Y-up, right-handed",
        "stepCoordinateSystem": "Z-up, right-handed",
        "axisMap": "(x, y, z)_step_mm -> (x, z, -y)_gltf_m",
        "linearDeflectionMm": linear_mm,
        "angularDeflectionRad": angular_rad,
    }
    if source_url:
        extras["sourceUrl"] = source_url
    if license_notice:
        extras["licenseNotice"] = license_notice
    asset: dict[str, Any] = {
        "version": "2.0",
        "generator": "forge/tools/step_to_glb.py",
        "extras": extras,
    }
    if copyright_text:
        asset["copyright"] = copyright_text
    scene_name = assembly.name or step_path.stem
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    blob = builder.pack(asset, scene_name, root)
    glb_path.write_bytes(blob)
    report = inspect_glb(glb_path)
    report["stepBounds"] = step_bounds
    report["expectedFromStep"] = _expected_gltf_bounds(step_bounds)
    report["sha256"] = hashlib.sha256(blob).hexdigest()
    report["sourceSha256"] = hashlib.sha256(step_path.read_bytes()).hexdigest()
    _check_units(report, linear_mm)
    return report


def _check_units(report: dict[str, Any], linear_mm: float) -> None:
    expected = report["expectedFromStep"]
    actual = report["bounds"]
    tolerance_m = max(linear_mm, 0.05) * MM_TO_M * 2.0
    deltas = []
    for label, exp, got in (
        ("min", expected["min_m"], actual["min_m"]),
        ("max", expected["max_m"], actual["max_m"]),
    ):
        for axis, left, right in zip("xyz", exp, got):
            delta = abs(left - right)
            deltas.append(delta)
            if delta > tolerance_m:
                raise SystemExit(
                    f"GLB {label} {axis} is {right:.6f} m; STEP implies {left:.6f} m "
                    f"(delta {delta * 1000:.3f} mm, tolerance {tolerance_m * 1000:.3f} mm)."
                )
    report["boundDeltaMm"] = max(deltas) * 1000.0


def read_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    data = path.read_bytes()
    if len(data) < 20 or data[:4] != GLTF_MAGIC:
        raise SystemExit(f"{path} is not a GLB file.")
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if version != 2 or length != len(data):
        raise SystemExit(f"{path} has GLB version {version} and declared length {length}.")
    offset = 12
    document = None
    binary = b""
    while offset + 8 <= len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + chunk_length]
        offset += chunk_length
        if chunk_type == JSON_CHUNK:
            document = json.loads(chunk.decode("utf-8"))
        elif chunk_type == BIN_CHUNK:
            binary = chunk
    if document is None:
        raise SystemExit(f"{path} has no JSON chunk.")
    return document, binary


def _accessor_array(
    document: dict[str, Any], binary: bytes, index: int
) -> list[tuple[float, ...] | int]:
    accessor = document["accessors"][index]
    view = document["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]
    component = accessor["componentType"]
    kind = accessor["type"]
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[kind]
    if component == FLOAT:
        fmt = "<" + "f" * width
    elif component == UNSIGNED_SHORT:
        fmt = "<" + "H" * width
    elif component == UNSIGNED_INT:
        fmt = "<" + "I" * width
    else:
        raise SystemExit(f"Unsupported accessor component {component}.")
    size = struct.calcsize(fmt)
    values = []
    for item in range(count):
        unpacked = struct.unpack_from(fmt, binary, start + item * size)
        values.append(unpacked[0] if width == 1 else unpacked)
    return values


def inspect_glb(path: Path) -> dict[str, Any]:
    document, binary = read_glb(path)
    asset = document.get("asset", {})
    if asset.get("version") != "2.0":
        raise SystemExit(f"{path} asset version is {asset.get('version')!r}.")
    nodes = document.get("nodes", [])
    meshes = document.get("meshes", [])
    world = [_IDENTITY] * len(nodes)
    pending = list(document["scenes"][document.get("scene", 0)]["nodes"])
    for index in pending:
        world[index] = list(nodes[index].get("matrix", _IDENTITY))
    cursor = 0
    while cursor < len(pending):
        parent = pending[cursor]
        cursor += 1
        for child in nodes[parent].get("children", []):
            world[child] = _multiply_matrix(
                world[parent], nodes[child].get("matrix", _IDENTITY)
            )
            pending.append(child)
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    triangles = 0
    named = []
    for index, node in enumerate(nodes):
        named.append(node.get("name", ""))
        mesh_index = node.get("mesh")
        if mesh_index is None:
            continue
        primitive = meshes[mesh_index]["primitives"][0]
        positions = _accessor_array(document, binary, primitive["attributes"]["POSITION"])
        indices = _accessor_array(document, binary, primitive["indices"])
        triangles += len(indices) // 3
        for position in positions:
            point = _transform_point(world[index], position)  # type: ignore[arg-type]
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
    if triangles == 0:
        raise SystemExit(f"{path} contains no triangles.")
    size = [hi - lo for lo, hi in zip(minimum, maximum)]
    extras = asset.get("extras") or {}
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "assetVersion": asset.get("version"),
        "generator": asset.get("generator"),
        "copyright": asset.get("copyright"),
        "units": extras.get("units"),
        "licenseNoticeEmbedded": bool(extras.get("licenseNotice")),
        "nodes": named,
        "meshCount": len(meshes),
        "triangles": triangles,
        "bounds": {"min_m": minimum, "max_m": maximum, "size_m": size},
        "size_mm": [value * 1000.0 for value in size],
    }


def _print_report(report: dict[str, Any]) -> None:
    bounds = report["bounds"]
    print(f"file: {report['path']}")
    print(f"bytes: {report['bytes']}")
    print(f"asset: glTF {report['assetVersion']} generator={report['generator']}")
    print(f"units: {report['units']}")
    print(f"copyright: {report['copyright']}")
    print(f"license notice embedded: {report['licenseNoticeEmbedded']}")
    print(
        f"nodes: {len(report['nodes'])} meshes: {report['meshCount']} "
        f"triangles: {report['triangles']}"
    )
    print("node names:")
    for name in report["nodes"]:
        print(f"  {name}")
    size = report["size_mm"]
    print(
        "glb size mm (X, Y, Z after Y-up map): "
        f"{size[0]:.4f} x {size[1]:.4f} x {size[2]:.4f}"
    )
    print(
        "glb min m: "
        + " ".join(f"{value:.6f}" for value in bounds["min_m"])
    )
    print(
        "glb max m: "
        + " ".join(f"{value:.6f}" for value in bounds["max_m"])
    )
    if "stepBounds" in report:
        step = report["stepBounds"]["size_mm"]
        print(
            "step size mm (X, Y, Z, Z-up): "
            f"{step[0]:.4f} x {step[1]:.4f} x {step[2]:.4f}"
        )
        print(f"max bound delta mm: {report['boundDeltaMm']:.4f}")
        print(f"source sha256: {report['sourceSha256']}")
        print(f"glb sha256: {report['sha256']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert a vendor STEP file to a metre-unit GLB."
    )
    parser.add_argument("step", nargs="?", type=Path, help="Input STEP file")
    parser.add_argument("glb", nargs="?", type=Path, help="Output GLB file")
    parser.add_argument(
        "--inspect", type=Path, help="Print units, names, and bounds for a GLB"
    )
    parser.add_argument(
        "--linear-deflection",
        type=float,
        default=0.15,
        help="Absolute mesh deflection in millimetres",
    )
    parser.add_argument(
        "--angular-deflection",
        type=float,
        default=0.4,
        help="Angular mesh deflection in radians",
    )
    parser.add_argument("--copyright", help="Value for asset.copyright")
    parser.add_argument(
        "--license-notice-file",
        type=Path,
        help="Text copied into asset.extras.licenseNotice",
    )
    parser.add_argument("--source-url", help="Recorded in asset.extras.sourceUrl")
    args = parser.parse_args(argv)
    if args.inspect:
        _print_report(inspect_glb(args.inspect))
        return 0
    if args.step is None or args.glb is None:
        parser.error("STEP and GLB paths are required unless --inspect is set")
    notice = None
    if args.license_notice_file:
        notice = args.license_notice_file.read_text(encoding="utf-8")
    report = convert_step(
        args.step,
        args.glb,
        linear_mm=args.linear_deflection,
        angular_rad=args.angular_deflection,
        copyright_text=args.copyright,
        license_notice=notice,
        source_url=args.source_url,
    )
    _print_report(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
