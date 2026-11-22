"""Whole-product 3D build: chassis + AI-designed structure + real device models.

Input is the studio's ``SystemDesign`` (mm, Y up, the same JSON the System view
renders). The chassis and every structure primitive are built as CadQuery
solids with filleted edges, tessellated, and assembled with the catalog's
device GLBs into one glTF scene. Every part is a named node so the browser can
select, hide and explode it. Output is in metres, Y up (glTF convention).

No Blender. CPU only. Runs locally or inside the Modal worker.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
from pathlib import Path
from typing import Any

GENERATOR = "forge-product/1"

# PBR looks matching the System view materials (pcb-studio/src/scene/System.tsx).
MATERIALS: dict[str, dict[str, Any]] = {
    "anodized": {"color": (0x24, 0x27, 0x2B, 255), "metallic": 0.75, "roughness": 0.42},
    "metal": {"color": (0x9A, 0xA0, 0xA8, 255), "metallic": 1.0, "roughness": 0.3},
    "plastic": {"color": (0x2A, 0x2D, 0x31, 255), "metallic": 0.1, "roughness": 0.6},
    "rubber": {"color": (0x10, 0x11, 0x13, 255), "metallic": 0.0, "roughness": 0.95},
    "carbon": {"color": (0x15, 0x17, 0x1A, 255), "metallic": 0.4, "roughness": 0.35},
    "clear": {"color": (0xCF, 0xD6, 0xDD, 70), "metallic": 0.0, "roughness": 0.2},
    "fr4": {"color": (0x1F, 0x5C, 0x3A, 255), "metallic": 0.1, "roughness": 0.55},
    "hub": {"color": (0xD9, 0xD9, 0xD2, 255), "metallic": 0.1, "roughness": 0.5},
    "glass": {"color": (0x1A, 0x1E, 0x24, 235), "metallic": 0.2, "roughness": 0.05},
    "fabric": {"color": (0x3A, 0x3D, 0x42, 255), "metallic": 0.0, "roughness": 0.9},
    "wood": {"color": (0x8A, 0x62, 0x3E, 255), "metallic": 0.0, "roughness": 0.7},
    "brass": {"color": (0xB8, 0x9B, 0x5E, 255), "metallic": 1.0, "roughness": 0.32},
}


def spec_hash(system: dict[str, Any], devices: list[str]) -> str:
    payload = json.dumps({"g": GENERATOR, "s": system, "d": sorted(devices)}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:20]


def _hex(color: Any, alpha: int) -> tuple[int, int, int, int] | None:
    if isinstance(color, str) and len(color.strip().lstrip("#")) == 6:
        try:
            v = int(color.strip().lstrip("#"), 16)
            return (v >> 16 & 255, v >> 8 & 255, v & 255, alpha)
        except ValueError:
            return None
    return None


def _material(name: str, color: Any = None):
    from trimesh.visual.material import PBRMaterial

    m = MATERIALS.get(name, MATERIALS["plastic"])
    rgba = _hex(color, m["color"][3]) or m["color"]
    return PBRMaterial(
        name=f"{name}-{rgba[0]:02x}{rgba[1]:02x}{rgba[2]:02x}",
        baseColorFactor=rgba,
        metallicFactor=m["metallic"],
        roughnessFactor=m["roughness"],
        alphaMode="BLEND" if m["color"][3] < 255 else "OPAQUE",
        doubleSided=m["color"][3] < 255,
    )


def _mesh(shape, material: str, tolerance: float = 0.08, color: Any = None):
    """Tessellate a CadQuery shape (mm) into a trimesh with a PBR material."""
    import numpy as np
    import trimesh
    from trimesh.visual import TextureVisuals

    verts, tris = shape.tessellate(tolerance, 0.2)
    mesh = trimesh.Trimesh(
        vertices=np.array([(v.x, v.y, v.z) for v in verts], dtype=float),
        faces=np.array(tris, dtype=np.int64),
        process=True,
    )
    mesh.visual = TextureVisuals(material=_material(material, color))
    return mesh


def body_meshes(parts: list[dict[str, Any]]):
    """AI-written CadQuery parts (Z-up) -> (name, Y-up mesh) pairs."""
    out = []
    for p in parts:
        shape = p["shape"].rotate((0, 0, 0), (1, 0, 0), -90)  # (x, y, z) -> (x, z, -y)
        bb = shape.BoundingBox()
        tol = max(0.05, min(0.4, max(bb.xlen, bb.ylen, bb.zlen) / 600))
        out.append((p["name"], _mesh(shape, p.get("mat") or "plastic", tol, p.get("color"))))
    return out


def _try_fillet(solid, radius: float):
    if radius <= 0.05:
        return solid
    try:
        return solid.edges().fillet(radius)
    except Exception:
        return solid


# ------------------------------------------------------------------ chassis


def _chassis(system: dict[str, Any]):
    import cadquery as cq

    c = system["chassis"]
    w, d, t = float(c["w"]), float(c["d"]), float(c["t"])
    band = system.get("form") == "band"
    r = min(w / 2 - 0.5, d / 2 - 0.5) if band else 10.0
    # Sketch on XZ (Y up): plate lies flat, top face at y = 0 like the browser.
    plate = cq.Workplane("XZ").rect(w, d).extrude(t)  # extrudes toward -Y
    plate = plate.edges("|Y").fillet(r)
    plate = _try_fillet(plate.faces(">Y or <Y"), 0.6)
    if band:
        holes = [(0.0, z) for z in _frange(d / 2 - 30, d / 2 - 90, -12)]
        plate = plate.faces(">Y").workplane().pushPoints(holes).hole(4.4)
    else:
        slots = []
        for sx in (-1, 1):
            for i in range(4):
                slots.append((sx * (w / 2 - 14), -d / 2 + 52 + i * ((d - 104) / 3)))
        plate = plate.faces(">Y").workplane().pushPoints(slots).hole(8.4)
        grid = [
            (x, z)
            for x in _frange(-w / 2 + 26, w / 2 - 26 + 0.01, 10)
            for z in _frange(-d / 2 + 14, d / 2 - 14 + 0.01, 10)
            if not (abs(x) < 46 and abs(z) < 36) and not (48 < abs(z) < 108 and abs(x) > 18)
        ]
        if grid:
            plate = plate.faces(">Y").workplane().pushPoints(grid).hole(3.2)
    return plate.val()


def _frange(start: float, stop: float, step: float):
    v = start
    while (v < stop) if step > 0 else (v > stop):
        yield v
        v += step


# ---------------------------------------------------------------- structure


def _prim(p: dict[str, Any]):
    import cadquery as cq

    shape = p.get("shape", "box")
    size = [float(s) for s in p.get("size", [10, 10, 10])]
    if shape == "box":
        sx, sy, sz = (size + [10, 10, 10])[:3]
        solid = cq.Workplane("XY").box(sx, sy, sz)
        solid = _try_fillet(solid, min(sx, sy, sz) * 0.12)
    elif shape == "cyl":
        radius, height = (size + [5, 10])[:2]
        solid = cq.Workplane("XZ").circle(radius).extrude(height / 2, both=True)
        solid = _try_fillet(solid.faces(">Y or <Y"), min(radius, height) * 0.1)
    elif shape == "ring":
        ring, tube = (size + [10, 1])[:2]
        solid = cq.Workplane("XY").add(cq.Solid.makeTorus(ring, tube, pnt=cq.Vector(0, 0, 0), dir=cq.Vector(0, 0, 1)))
    elif shape == "sphere":
        solid = cq.Workplane("XY").sphere(size[0])
    else:
        return None
    return solid.val()


def _place_matrix(pos, rot_deg=None, yaw_deg=None, order="XYZ"):
    """4x4 transform for three.js-style Euler rotation then translation."""
    import numpy as np
    from trimesh.transformations import euler_matrix

    rx, ry, rz = (math.radians(a) for a in (rot_deg or [0, yaw_deg or 0, 0]))
    # three.js 'XYZ' intrinsic == static 'rxyz' in transformations notation.
    m = euler_matrix(rx, ry, rz, "rxyz") if order == "XYZ" else euler_matrix(ry, rx, rz, "ryxz")
    m[:3, 3] = np.array(pos, dtype=float)
    return m


# ------------------------------------------------------------------ devices


def _device_scene(glb: bytes, d: dict[str, Any]):
    """Load a catalog GLB (metres) as mm meshes positioned like the System view."""
    import numpy as np
    import trimesh

    scene = trimesh.load(io.BytesIO(glb), file_type="glb", force="scene")
    meshes = []
    for name, geom in _named(scene):
        geom.apply_scale(1000.0)
        meshes.append((name, geom))
    if not meshes:
        return []
    lo = np.min([g.bounds[0] for _, g in meshes], axis=0)
    hi = np.max([g.bounds[1] for _, g in meshes], axis=0)
    limit = float(d.get("_fit_mm") or 0)
    span = float(max(hi - lo))
    if limit and span > limit:
        k = limit / span
        for _, g in meshes:
            g.apply_scale(k)
        lo, hi = lo * k, hi * k
    base_shift = np.eye(4)
    base_shift[:3, 3] = [-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2]
    stand = bool(d.get("stand"))
    lift = (hi[2] - lo[2]) / 2 if stand else 0.0
    rot = [-90.0 if stand else 0.0, float(d.get("rot", 0)), 0.0]
    place = _place_matrix([d.get("x", 0), float(d.get("y", 0)) + lift, d.get("z", 0)], rot, order="YXZ")
    out = []
    for name, geom in meshes:
        geom.apply_transform(place @ base_shift)
        out.append((name, geom))
    if d.get("bus") == "motor":
        for name, geom in _wheel(float(hi[0] - lo[0]), float(hi[1] - lo[1])):
            geom.apply_transform(place)
            out.append((name, geom))
    return out


def _wheel(length: float, height: float):
    """Tyre + hub on the motor's -X shaft, as the System view draws it."""
    import cadquery as cq

    radius = max(16.0, height * 1.45)
    cx, cy = -length / 2 - 13.0, height / 2
    tyre = cq.Workplane("YZ").circle(radius).circle(radius * 0.62).extrude(13, both=True)
    tyre = _try_fillet(tyre.faces("<X or >X").edges(), 3.0)
    tread = cq.Workplane("YZ").pushPoints(
        [(math.sin(2 * math.pi * i / 24) * radius, math.cos(2 * math.pi * i / 24) * radius) for i in range(24)]
    ).rect(2.6, 2.6).extrude(11, both=True)
    hub = cq.Workplane("YZ").polygon(6, radius * 1.24).extrude(13.5, both=True)
    hub = hub.faces(">X").workplane().hole(4)
    move = (cx, cy, 0)
    return [
        ("tyre", _mesh(tyre.translate(move).val(), "rubber", 0.15)),
        ("tread", _mesh(tread.translate(move).val(), "rubber", 0.3)),
        ("hub", _mesh(hub.translate(move).val(), "hub", 0.15)),
    ]


def _named(scene):
    """(node name, world-space geometry copy) for each mesh node in a scene."""
    out = []
    for node in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node]
        geom = scene.geometry[geom_name].copy()
        geom.apply_transform(transform)
        out.append((str(node), geom))
    return out


# ------------------------------------------------------------------ build


def build_product(
    system: dict[str, Any],
    device_glbs: dict[str, bytes],
    *,
    board: dict[str, float] | None = None,
    body: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the full product GLB. Returns {glb, parts, findings, bounds_mm}."""
    import numpy as np
    import trimesh

    scene = trimesh.Scene()
    parts: list[dict[str, Any]] = []
    findings: list[dict[str, str]] = []

    def add(node: str, mesh, kind: str, label: str):
        scene.add_geometry(mesh, node_name=node, geom_name=node)
        parts.append({"node": node, "kind": kind, "label": label, "triangles": int(len(mesh.faces))})

    form = system.get("form") or "plate"
    if form != "none" and system.get("chassis", {}).get("t", 0) > 0:
        try:
            mat = "rubber" if form == "band" else "anodized"
            add("chassis", _mesh(_chassis(system), mat, tolerance=0.3), "chassis", "Wrist band" if form == "band" else "Chassis plate")
        except Exception as error:  # keep building the rest
            findings.append({"check": "chassis", "status": "fail", "detail": f"{type(error).__name__}: {error}"})

    # PCB on standoffs at pcbHeight (the browser swaps in the routed board).
    import cadquery as cq

    band = form == "band"
    bw, bd = (board or {}).get("w", 64.0), (board or {}).get("d", 48.0)
    h = float(system.get("pcbHeight", 12))
    if band:
        cw = float(system["chassis"]["w"])
        bw, bd = min(bw, cw - 8), min(bd, 40.0)
        shell = (
            cq.Workplane("XZ").rect(cw + 4, bd + 14).extrude(-(h + 6)).edges("|Y").fillet(8)
            .faces(">Y").edges().fillet(3).faces("<Y").shell(-1.6)
        )
        add("housing", _mesh(shell.val(), "clear", 0.15), "enclosure", "Pod housing")
    pcb = cq.Workplane("XZ").rect(bw, bd).extrude(-1.6).edges("|Y").fillet(2.5).translate((0, h, 0))
    add("pcb", _mesh(pcb.val(), "fr4"), "pcb", "Custom PCB")
    for i, (sx, sz) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        post = cq.Workplane("XZ").polygon(6, 5.5).extrude(-h).translate((sx * (bw / 2 - 3.5), h, sz * (bd / 2 - 3.5)))
        add(f"standoff-{i + 1}", _mesh(post.val(), "brass"), "hardware", "M3 standoff")

    for i, (name, mesh) in enumerate(body_meshes(body or [])):
        add(f"body-{i + 1}", mesh, "body", name)

    for i, p in enumerate([] if body else system.get("structure") or []):
        try:
            solid = _prim(p)
            if solid is None:
                continue
            mesh = _mesh(solid, p.get("mat", "plastic"))
            mesh.apply_transform(_place_matrix(p.get("pos", [0, 0, 0]), p.get("rot"), p.get("yaw")))
            add(f"structure-{i + 1}", mesh, "structure", p.get("shape", "part"))
        except Exception as error:
            findings.append({"check": f"structure-{i + 1}", "status": "fail", "detail": f"{type(error).__name__}: {error}"})

    c = system.get("chassis") or {}
    fit = max(float(c.get("w", 0)), float(c.get("d", 0))) * 0.9 or 200.0
    for d in system.get("devices") or []:
        glb = device_glbs.get(d.get("catalogId", ""))
        if not glb:
            # Labeled stand-in sized from catalog dimensions when provided.
            dims = d.get("dims") or {"w": 26.0, "h": 18.0, "thickness": 3.0}
            block = cq.Workplane("XZ").rect(float(dims["w"]), float(dims["h"])).extrude(-max(1.6, float(dims.get("thickness", 3)))).edges("|Y").fillet(1.2)
            mesh = _mesh(block.val(), "fr4")
            mesh.apply_transform(_place_matrix([d.get("x", 0), d.get("y", 0), d.get("z", 0)], [0, float(d.get("rot", 0)), 0]))
            add(f"device-{d['id']}-1", mesh, "placeholder", d.get("label") or d.get("catalogId"))
            findings.append({"check": f"device:{d.get('id')}", "status": "unknown", "detail": f"No catalog model for {d.get('catalogId')}; placeholder block shown."})
            continue
        for j, (name, mesh) in enumerate(_device_scene(glb, {**d, "_fit_mm": fit})):
            add(f"device-{d['id']}-{j + 1}", mesh, "device", d.get("label") or d.get("catalogId"))

    if not parts:
        raise ValueError("Nothing to build.")
    if band:
        _wrap(scene, float(system["chassis"]["d"]))
    lo, hi = scene.bounds
    size = (hi - lo).round(2).tolist()
    findings.append({"check": "bounds", "status": "pass" if all(s > 0 for s in size) else "fail", "detail": f"{size[0]} × {size[1]} × {size[2]} mm"})
    findings.append({"check": "parts", "status": "pass", "detail": f"{len(parts)} named nodes, {sum(p['triangles'] for p in parts)} triangles"})

    scene.apply_scale(0.001)  # glTF is metres
    glb = scene.export(file_type="glb")
    return {"glb": glb, "parts": parts, "findings": findings, "bounds_mm": size, "generator": GENERATOR}


def _wrap(scene, strap_mm: float) -> None:
    """Bend the flat strap layout into a closed loop around the forearm (X axis).

    Strap coordinate z becomes arc length; y becomes height above the skin. The
    top of the loop (z = 0) keeps its position, so the electronics pod stays put.
    """
    import numpy as np
    import trimesh

    radius = strap_mm / (2 * math.pi)
    for node in list(scene.graph.nodes_geometry):
        transform, name = scene.graph[node]
        mesh = scene.geometry[name]
        mesh.apply_transform(transform)
        scene.graph.update(node, matrix=np.eye(4))
        if float(np.ptp(mesh.vertices[:, 2])) > 30:
            v, f = trimesh.remesh.subdivide_to_size(mesh.vertices, mesh.faces, max_edge=7.0, max_iter=10)
            visual = mesh.visual
            mesh = trimesh.Trimesh(v, f, process=False)
            mesh.visual = trimesh.visual.TextureVisuals(material=visual.material)
            scene.geometry[name] = mesh
        x, y, z = mesh.vertices.T
        theta = z / radius
        rho = radius + y
        mesh.vertices = np.column_stack([x, rho * np.cos(theta) - radius, rho * np.sin(theta)])


def load_local_devices(system: dict[str, Any], root: Path, *, flat: bool = False) -> dict[str, bytes]:
    """Catalog GLBs for the system's devices. ``flat``: root holds the GLBs directly."""
    folder = root if flat else root / "assets" / "models" / "glb"
    out = {}
    for d in system.get("devices") or []:
        cid = d.get("catalogId", "")
        if "/" in cid or ".." in cid:
            continue
        path = folder / f"{cid}.glb"
        if cid and path.is_file():
            out[cid] = path.read_bytes()
    return out
