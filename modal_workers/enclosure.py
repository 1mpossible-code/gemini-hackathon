"""Parametric enclosure generator (CadQuery / OpenCascade). No Blender.

Pure function of a JSON-serializable spec, so the same code runs in the Modal
worker and, when CadQuery is installed, locally in the studio process.

Spec (all millimetres):
{
  "id": "emg-wristband-pod",
  "board": {"length": 48.26, "width": 27.94, "thickness": 1.6, "component_height": 8.0},
  "wall": 2.0, "clearance": 1.5, "floor": 2.0, "lid": 1.6, "corner_radius": 3.0,
  "standoff": {"height": 3.0, "outer_d": 5.0, "hole_d": 2.2, "inset": 3.5},
  "cutouts": [{"id": "usb", "face": "-x", "width": 12.0, "height": 7.0, "offset_z": 0.0}],
  "strap_slots": {"width": 22.0, "height": 3.0}
}
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

GENERATOR_VERSION = "enclosure-cq-1"


def spec_hash(spec: dict[str, Any]) -> str:
    payload = json.dumps({"spec": spec, "generator": GENERATOR_VERSION}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def derived_dimensions(spec: dict[str, Any]) -> dict[str, float]:
    board = spec["board"]
    wall = float(spec.get("wall", 2.0))
    clear = float(spec.get("clearance", 1.5))
    floor = float(spec.get("floor", 2.0))
    lid = float(spec.get("lid", 1.6))
    standoff = float((spec.get("standoff") or {}).get("height", 3.0))
    inner_l = board["length"] + 2 * clear
    inner_w = board["width"] + 2 * clear
    inner_h = standoff + board["thickness"] + board.get("component_height", 8.0) + clear
    return {
        "inner_length": inner_l,
        "inner_width": inner_w,
        "inner_height": inner_h,
        "outer_length": inner_l + 2 * wall,
        "outer_width": inner_w + 2 * wall,
        "outer_height": inner_h + floor + lid,
        "wall": wall,
        "floor": floor,
        "lid": lid,
        "standoff": standoff,
    }


def build(spec: dict[str, Any]):
    """Return (base, lid, dims) CadQuery workplanes. Z-up, origin at base centre."""
    import cadquery as cq

    d = derived_dimensions(spec)
    radius = min(float(spec.get("corner_radius", 3.0)), d["outer_width"] / 2 - 0.5)
    body_h = d["floor"] + d["inner_height"]

    base = (
        cq.Workplane("XY")
        .box(d["outer_length"], d["outer_width"], body_h, centered=(True, True, False))
        .edges("|Z").fillet(radius)
    )
    cavity = (
        cq.Workplane("XY", origin=(0, 0, d["floor"]))
        .box(d["inner_length"], d["inner_width"], d["inner_height"] + 1, centered=(True, True, False))
        .edges("|Z").fillet(max(radius - d["wall"], 0.4))
    )
    base = base.cut(cavity)

    so = spec.get("standoff") or {}
    inset = float(so.get("inset", 3.5))
    board = spec["board"]
    hx = board["length"] / 2 - inset
    hy = board["width"] / 2 - inset
    points = [(sx * hx, sy * hy) for sx in (-1, 1) for sy in (-1, 1)]
    posts = (
        cq.Workplane("XY", origin=(0, 0, d["floor"]))
        .pushPoints(points)
        .circle(float(so.get("outer_d", 5.0)) / 2)
        .circle(float(so.get("hole_d", 2.2)) / 2)
        .extrude(d["standoff"])
    )
    base = base.union(posts)

    for cut in spec.get("cutouts") or []:
        face = cut.get("face", "-x")
        w, h = float(cut["width"]), float(cut["height"])
        z = d["floor"] + d["standoff"] + board["thickness"] + float(cut.get("offset_z", 0.0)) + h / 2
        depth = d["wall"] * 3
        if face in ("-x", "+x"):
            x = (-1 if face == "-x" else 1) * (d["outer_length"] / 2)
            tool = cq.Workplane("XY").box(depth, w, h).translate((x, float(cut.get("offset_y", 0.0)), z))
        else:
            y = (-1 if face == "-y" else 1) * (d["outer_width"] / 2)
            tool = cq.Workplane("XY").box(w, depth, h).translate((float(cut.get("offset_x", 0.0)), y, z))
        base = base.cut(tool)

    slots = spec.get("strap_slots")
    if slots:
        sw, sh = float(slots["width"]), float(slots["height"])
        lug_l = sh + 4.0
        for sign in (-1, 1):
            lug = (
                cq.Workplane("XY")
                .box(lug_l, min(sw + 6.0, d["outer_width"]), 4.0, centered=(True, True, False))
                .translate((sign * (d["outer_length"] / 2 + lug_l / 2 - 0.5), 0, 0))
            )
            hole = cq.Workplane("XY").box(sh, sw, 10).translate((sign * (d["outer_length"] / 2 + lug_l / 2), 0, 0))
            base = base.union(lug.cut(hole))

    lid = (
        cq.Workplane("XY", origin=(0, 0, body_h))
        .box(d["outer_length"], d["outer_width"], d["lid"], centered=(True, True, False))
        .edges("|Z").fillet(radius)
    )
    # Locating lip: a 0.8 mm ring that drops into the cavity.
    lip = (
        cq.Workplane("XY", origin=(0, 0, body_h - 1.2))
        .rect(d["inner_length"] - 0.4, d["inner_width"] - 0.4)
        .rect(d["inner_length"] - 2.0, d["inner_width"] - 2.0)
        .extrude(1.2)
    )
    lid = lid.union(lip)
    return base, lid, d


def validate(base, lid, dims: dict[str, float]) -> list[dict[str, str]]:
    """Geometry QA. These checks do not establish printability or fit on hardware."""
    findings: list[dict[str, str]] = []
    for name, part in (("base", base), ("lid", lid)):
        solid = part.val()
        valid = bool(solid.isValid())
        findings.append({"check": f"{name}_brep_valid", "status": "pass" if valid else "fail",
                         "detail": f"OpenCascade BRep check for the {name}."})
        volume = float(solid.Volume())
        findings.append({"check": f"{name}_volume", "status": "pass" if volume > 0 else "fail",
                         "detail": f"{name} volume {volume:.1f} mm³."})
    bb = base.union(lid).val().BoundingBox()
    expected = (dims["outer_length"], dims["outer_width"], dims["outer_height"])
    # Strap lugs extend X beyond the shell, so only Y and Z are strict.
    ok = abs(bb.ylen - expected[1]) < 0.05 and abs(bb.zlen - expected[2]) < 0.05 and bb.xlen >= expected[0] - 0.05
    findings.append({
        "check": "envelope_matches_spec",
        "status": "pass" if ok else "fail",
        "detail": f"Bounding box {bb.xlen:.2f} × {bb.ylen:.2f} × {bb.zlen:.2f} mm vs shell {expected[0]:.2f} × {expected[1]:.2f} × {expected[2]:.2f} mm.",
    })
    cavity_ok = dims["inner_height"] > dims["standoff"] + 1.6
    findings.append({"check": "board_fits_cavity", "status": "pass" if cavity_ok else "fail",
                     "detail": f"Cavity height {dims['inner_height']:.2f} mm above the floor."})
    return findings


def generate(spec: dict[str, Any], workdir: str) -> dict[str, Any]:
    """Build, validate and export. Returns file paths and metadata."""
    import cadquery as cq
    from pathlib import Path

    out = Path(workdir)
    out.mkdir(parents=True, exist_ok=True)
    base, lid, dims = build(spec)
    findings = validate(base, lid, dims)

    assembly = cq.Assembly(name=spec.get("id", "enclosure"))
    assembly.add(base, name="enclosure_base", color=cq.Color(0.16, 0.17, 0.2, 1))
    assembly.add(lid, name="enclosure_lid", color=cq.Color(0.32, 0.34, 0.38, 1))

    step_path = out / "enclosure.step"
    stl_path = out / "enclosure.stl"
    assembly.export(str(step_path))
    cq.exporters.export(base.union(lid), str(stl_path), tolerance=0.05, angularTolerance=0.2)
    return {
        "generator": GENERATOR_VERSION,
        "dimensions_mm": dims,
        "findings": findings,
        "files": {"step": str(step_path), "stl": str(stl_path)},
    }
