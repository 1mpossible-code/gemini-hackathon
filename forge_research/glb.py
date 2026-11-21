"""Small glTF serializer for FORGE's bounded set of parametric primitives."""

from __future__ import annotations

import json
from itertools import pairwise
from math import cos, hypot, pi, sin, tau
from struct import pack
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .geometry import AssemblyManifest, Shape, Vector

MATERIALS = {
    "shell": ((0.075, 0.082, 0.09, 1.0), 0.55, 0.34),
    "strap": ((0.025, 0.03, 0.035, 1.0), 0.03, 0.81),
    "pcb": ((0.075, 0.12, 0.13, 1.0), 0.16, 0.48),
    "metal": ((0.57, 0.60, 0.63, 1.0), 0.79, 0.32),
    "chip": ((0.04, 0.043, 0.047, 1.0), 0.08, 0.49),
    "contact": ((0.64, 0.54, 0.34, 1.0), 0.71, 0.36),
    "lid": ((0.14, 0.158, 0.18, 1.0), 0.63, 0.3),
}


class Mesh:
    """Accumulate planar faces with normals suitable for hard mechanical edges."""

    def __init__(self) -> None:
        self.positions: list[Vector] = []
        self.normals: list[Vector] = []
        self.indices: list[int] = []

    def face(self, vertices: tuple[Vector, ...]) -> None:
        a, b, c, *_ = vertices
        ux, uy, uz = (bv - av for av, bv in zip(a, b))
        vx, vy, vz = (cv - av for av, cv in zip(a, c))
        normal = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        length = hypot(*normal)
        if length == 0:
            raise ValueError("Cannot serialize a degenerate face.")
        start = len(self.positions)
        self.positions.extend(vertices)
        unit_normal = tuple(coordinate / length for coordinate in normal)
        self.normals.extend([unit_normal] * len(vertices))
        for index in range(1, len(vertices) - 1):
            self.indices.extend((start, start + index, start + index + 1))


def rounded_rectangle(width: float, depth: float, radius: float) -> list[tuple[float, float]]:
    half_x, half_z = width / 2, depth / 2
    radius = min(radius, half_x * 0.999, half_z * 0.999)
    return [
        (cx + radius * cos(angle), cz + radius * sin(angle))
        for corner, (cx, cz) in enumerate(
            (
                (half_x - radius, half_z - radius),
                (-half_x + radius, half_z - radius),
                (-half_x + radius, -half_z + radius),
                (half_x - radius, -half_z + radius),
            )
        )
        for index in range(7)
        for angle in (pi / 2 * (corner + index / 6),)
    ]


def sensor_outline(width: float, depth: float) -> list[tuple[float, float]]:
    """Fit a rounded triangular outline to the published overall PCB dimensions."""
    radius = (width - 25.4) / 2
    z = depth / 2 - radius
    circles = ((12.7, z), (-12.7, z), (0, -z))
    points = sorted(
        {
            (x + radius * cos(angle), center_z + radius * sin(angle))
            for x, center_z in circles
            for index in range(36)
            for angle in (tau * index / 36,)
        }
    )

    def half_hull(ordered):
        hull = []
        for point in ordered:
            while len(hull) >= 2:
                ax, az = hull[-2]
                bx, bz = hull[-1]
                px, pz = point
                if (bx - ax) * (pz - az) > (bz - az) * (px - ax):
                    break
                hull.pop()
            hull.append(point)
        return hull[:-1]

    return half_hull(points) + half_hull(reversed(points))


def plate(shape: Shape) -> Mesh:
    width, height, depth = shape.size_mm
    if shape.kind == "cylinder":
        profile = [
            (width / 2 * cos(tau * n / 32), depth / 2 * sin(tau * n / 32)) for n in range(32)
        ]
    elif shape.kind == "sensor_outline":
        profile = sensor_outline(width, depth)
    else:
        profile = rounded_rectangle(width, depth, shape.radius_mm)
    bottom = [(x, -height / 2, z) for x, z in profile]
    top = [(x, height / 2, z) for x, z in profile]
    mesh = Mesh()
    for i in range(len(profile)):
        j = (i + 1) % len(profile)
        mesh.face((bottom[i], top[i], top[j], bottom[j]))
    if shape.kind == "rounded_frame":
        wall = shape.wall_mm
        inner = rounded_rectangle(width - 2 * wall, depth - 2 * wall, shape.radius_mm - wall)
        inner_bottom = [(x, -height / 2, z) for x, z in inner]
        inner_top = [(x, height / 2, z) for x, z in inner]
        for i in range(len(profile)):
            j = (i + 1) % len(profile)
            mesh.face((inner_bottom[i], inner_bottom[j], inner_top[j], inner_top[i]))
            mesh.face((inner_top[i], inner_top[j], top[j], top[i]))
            mesh.face((inner_bottom[i], bottom[i], bottom[j], inner_bottom[j]))
    else:
        for i in range(len(profile)):
            j = (i + 1) % len(profile)
            mesh.face(((0, -height / 2, 0), bottom[i], bottom[j]))
            mesh.face(((0, height / 2, 0), top[j], top[i]))
    return mesh


def strap(shape: Shape) -> Mesh:
    width, thickness, _ = shape.size_mm
    if shape.bend_radii_mm is None:
        raise ValueError("A curved strap requires two bend radii.")
    ry, rz = shape.bend_radii_mm
    start = shape.start_angle_rad
    sweep = tau - 2 * start
    stations = 96
    profiles = [
        tuple(
            (x, (ry + offset) * cos(angle), (rz + offset) * sin(angle))
            for x, offset in (
                (-width / 2, 0),
                (-width / 2, thickness),
                (width / 2, thickness),
                (width / 2, 0),
            )
        )
        for i in range(stations + 1)
        for angle in (start + sweep * i / stations,)
    ]
    mesh = Mesh()
    mesh.face(profiles[0])
    for row, next_row in pairwise(profiles):
        for i in range(4):
            j = (i + 1) % 4
            mesh.face((row[i], next_row[i], next_row[j], row[j]))
    mesh.face(profiles[-1][::-1])
    return mesh


def export(manifest: AssemblyManifest) -> bytes:
    data = bytearray()
    accessors = []
    views = []
    nodes = []
    meshes = []

    def add_accessor(values: bytes, target: int, **accessor) -> int:
        data.extend(b"\0" * (-len(data) % 4))
        views.append(
            {"buffer": 0, "byteOffset": len(data), "byteLength": len(values), "target": target}
        )
        data.extend(values)
        accessors.append({"bufferView": len(views) - 1, **accessor})
        return len(accessors) - 1

    materials = [
        {
            "name": name,
            "pbrMetallicRoughness": {
                "baseColorFactor": color,
                "metallicFactor": metal,
                "roughnessFactor": roughness,
            },
        }
        for name, (color, metal, roughness) in MATERIALS.items()
    ]
    material_ids = {name: i for i, name in enumerate(MATERIALS)}
    mesh_ids: dict[tuple[str, str], int] = {}
    for node in manifest.nodes:
        shape = node.geometry
        key = (shape.model_dump_json(), node.material)
        if key not in mesh_ids:
            mesh = strap(shape) if shape.kind == "curved_strap" else plate(shape)
            coordinates = [
                tuple(value / 1000 for value in vector) for vector in mesh.positions
            ]
            axes = tuple(zip(*coordinates))
            position_accessor = add_accessor(
                b"".join(pack("<3f", *vector) for vector in coordinates),
                34962,
                componentType=5126,
                count=len(coordinates),
                type="VEC3",
                min=[min(axis) for axis in axes],
                max=[max(axis) for axis in axes],
            )
            normal_accessor = add_accessor(
                b"".join(pack("<3f", *vector) for vector in mesh.normals),
                34962,
                componentType=5126,
                count=len(mesh.normals),
                type="VEC3",
            )
            index_accessor = add_accessor(
                pack(f"<{len(mesh.indices)}H", *mesh.indices),
                34963,
                componentType=5123,
                count=len(mesh.indices),
                type="SCALAR",
            )
            mesh_ids[key] = len(meshes)
            meshes.append(
                {
                    "primitives": [
                        {
                            "attributes": {
                                "POSITION": position_accessor,
                                "NORMAL": normal_accessor,
                            },
                            "indices": index_accessor,
                            "material": material_ids[node.material],
                        }
                    ]
                }
            )
        nodes.append(
            {
                "name": node.id,
                "mesh": mesh_ids[key],
                "translation": [value / 1000 for value in node.position_mm],
                "extras": {
                    "label": node.label,
                    "part_instance_id": node.part_instance_id,
                    "catalog_id": node.catalog_id,
                    "fidelity": node.fidelity,
                },
            }
        )

    data.extend(b"\0" * (-len(data) % 4))
    document = json.dumps(
        {
            "asset": {"version": "2.0", "generator": "FORGE mechanical preview"},
            "scene": 0,
            "scenes": [{"nodes": list(range(len(nodes)))}],
            "nodes": nodes,
            "meshes": meshes,
            "materials": materials,
            "accessors": accessors,
            "bufferViews": views,
            "buffers": [{"byteLength": len(data)}],
        },
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    document += b" " * (-len(document) % 4)
    length = 12 + 8 + len(document) + 8 + len(data)
    return b"".join(
        (
            pack("<4sII", b"glTF", 2, length),
            pack("<I4s", len(document), b"JSON"),
            document,
            pack("<I4s", len(data), b"BIN\0"),
            data,
        )
    )
