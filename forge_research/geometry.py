"""Dimension-driven wristband assembly and mechanical review."""

from math import asin, cos, pi, sqrt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from . import glb
from .models import Finding, ResearchReport

ESP32 = "esp32-devkitc-32e"
MYOWARE = "myoware-2-dev-27924"
ESP32_DRAWING = "https://dl.espressif.com/dl/schematics/esp32_devkitc_v4_dimensions.pdf"
MYOWARE_DRAWING = (
    "https://cdn.sparkfun.com/assets/learn_tutorials/1/9/5/6/"
    "MyoWare_v2_Muscle_Sensor_Board_Dimensions.png"
)
Vector = tuple[float, float, float]
Material = Literal["shell", "strap", "pcb", "metal", "chip", "contact", "lid"]


class GeometryError(ValueError):
    """The requested assembly cannot be generated from the available mechanical evidence."""


class AssemblyParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    wrist_circumference_mm: float | None = Field(default=None, ge=120, le=240)
    wall_mm: float = Field(default=2.0, ge=1.2, le=4)
    clearance_mm: float = Field(default=1.5, ge=0.8, le=4)


class Shape(BaseModel):
    kind: Literal["rounded_box", "rounded_frame", "sensor_outline", "cylinder", "curved_strap"]
    size_mm: Vector
    radius_mm: float = 0.0
    wall_mm: float = 0.0
    bend_radii_mm: tuple[float, float] | None = None
    start_angle_rad: float = 0.0


class AssemblyNode(BaseModel):
    id: str
    label: str
    part_instance_id: str | None = None
    catalog_id: str | None = None
    position_mm: Vector
    geometry: Shape
    material: Material
    fidelity: Literal["parametric", "dimensioned_proxy", "estimated_detail"]
    source: str | None = None


class AssemblyManifest(BaseModel):
    schema_version: Literal[1] = 1
    units: Literal["mm"] = "mm"
    parameters: AssemblyParameters
    nodes: list[AssemblyNode]
    findings: list[Finding]


def build_assembly(
    report: ResearchReport, parameters: AssemblyParameters | None = None
) -> AssemblyManifest:
    """Fit the two researched boards into a parametric enclosure and wrist strap."""
    if report.review.status != "candidate":
        raise GeometryError("Only candidate research reports can produce a prototype.")
    reviewed = {part.id: part for part in report.review.selected_parts}
    if len(report.review.selected_parts) != 2 or reviewed.keys() != {ESP32, MYOWARE}:
        raise GeometryError("Mechanical geometry is available for the ESP32 and MyoWare pair.")
    if any(report.catalog_snapshot.get(key) != part for key, part in reviewed.items()):
        raise GeometryError("The reviewed parts do not match the research catalog snapshot.")

    parameters = parameters or AssemblyParameters()
    wrist = parameters.wrist_circumference_mm
    wrist_source = "edited"
    if wrist is None:
        wrist = report.requirements.wrist_circumference_mm
        wrist_source = "brief"
    if wrist is None:
        wrist = 170.0
        wrist_source = "preview default"
    if not 120 <= wrist <= 240:
        raise GeometryError("Wrist circumference must be between 120 and 240 mm.")
    parameters = AssemblyParameters(
        wrist_circumference_mm=wrist,
        wall_mm=parameters.wall_mm,
        clearance_mm=parameters.clearance_mm,
    )

    wall, gap = parameters.wall_mm, parameters.clearance_mm
    pcb = 1.6  # Thickness and populated heights are prototype assumptions.
    sensor_y = wall + gap + pcb / 2
    sensor_top = sensor_y + pcb / 2 + 3.3
    board_y = sensor_top + gap + pcb / 2
    board_top = board_y + pcb / 2 + 3.5
    board_z = -1.25  # Center the USB extension within the enclosure.
    inner_x = 37.57 + 2 * gap
    inner_z = 48.26 + 2.5 + 2 * gap
    outer_x, outer_z = inner_x + 2 * wall, inner_z + 2 * wall
    lid_floor = board_top + gap
    frame_y = lid_floor - wall
    radius = wall + 1.5
    nodes: list[AssemblyNode] = []

    def box(
        node_id: str,
        label: str,
        position: Vector,
        size: Vector,
        material: Material,
        *,
        radius_mm: float = 0.2,
        group: Literal["board", "sensor-1"] | None = None,
        kind: Literal[
            "rounded_box", "rounded_frame", "sensor_outline", "cylinder"
        ] = "rounded_box",
        frame_wall: float = 0.0,
    ) -> None:
        root = group == node_id
        catalog = ESP32 if group == "board" else MYOWARE if group == "sensor-1" else None
        source = ESP32_DRAWING if group == "board" else MYOWARE_DRAWING if group else None
        nodes.append(
            AssemblyNode(
                id=node_id,
                label=label,
                part_instance_id=group,
                catalog_id=catalog,
                position_mm=position,
                geometry=Shape(
                    kind=kind, size_mm=size, radius_mm=radius_mm, wall_mm=frame_wall
                ),
                material=material,
                fidelity="dimensioned_proxy"
                if root
                else "estimated_detail"
                if group
                else "parametric",
                source=source,
            )
        )

    box(
        "enclosure-base",
        "Enclosure base",
        (0, wall / 2, 0),
        (outer_x, wall, outer_z),
        "shell",
        radius_mm=radius,
    )
    box(
        "enclosure-frame",
        "Enclosure frame",
        (0, wall + frame_y / 2, 0),
        (outer_x, frame_y, outer_z),
        "shell",
        radius_mm=radius,
        kind="rounded_frame",
        frame_wall=wall,
    )
    box(
        "enclosure-lid",
        "Lift-off lid",
        (0, lid_floor + wall / 2, 0),
        (outer_x, wall, outer_z),
        "lid",
        radius_mm=radius,
    )
    box(
        "sensor-1",
        "MyoWare 2 sensor",
        (0, sensor_y, 0),
        (37.57, pcb, 35.90),
        "pcb",
        group="sensor-1",
        kind="sensor_outline",
    )
    for name, x, z in (("ref", 0, -11.81), ("end", -12.70, 11.81), ("mid", 12.70, 11.81)):
        box(
            f"sensor-{name}",
            f"{name.upper()} electrode snap",
            (x, sensor_top - 1.72, z),
            (10, 3.16, 10),
            "metal",
            group="sensor-1",
            kind="cylinder",
        )
        box(
            f"sensor-{name}-center",
            "Electrode snap center",
            (x, sensor_top - 0.07, z),
            (4.6, 0.14, 4.6),
            "chip",
            group="sensor-1",
            kind="cylinder",
        )
    for index, z in enumerate((-3, 3, 8), start=1):
        box(
            f"sensor-ic-{index}",
            "Sensor IC",
            (0, sensor_y + 1.3, z),
            (4.7, 1, 3.7),
            "chip",
            group="sensor-1",
        )

    box(
        "board",
        "ESP32 DevKitC V4",
        (0, board_y, board_z),
        (27.94, pcb, 48.26),
        "pcb",
        group="board",
        radius_mm=0.8,
    )
    box(
        "board-radio",
        "WROOM-32E shield",
        (0, board_y + 2, board_z - 9),
        (16, 2.4, 18),
        "metal",
        group="board",
        radius_mm=0.7,
    )
    box(
        "board-antenna",
        "Antenna region",
        (0, board_y + 1.05, board_z - 20),
        (18, 0.5, 6.2),
        "chip",
        group="board",
    )
    box(
        "board-usb",
        "Micro USB connector",
        (0, board_y + 2.55, board_z + 22.4),
        (7.7, 3.5, 8.46),
        "metal",
        group="board",
        radius_mm=0.5,
    )
    for side, x in (("left", -11.3), ("right", 11.3)):
        box(
            f"board-{side}-header",
            "Pin header",
            (x, board_y + 1.8, board_z),
            (2.65, 2, 46.7),
            "chip",
            group="board",
        )
        for index in range(19):
            z = board_z + (index - 9) * 2.54
            box(
                f"board-{side}-pin-{index + 1}",
                "Header pin",
                (x, board_y + 2.95, z),
                (0.95, 0.3, 0.95),
                "contact",
                group="board",
            )
    for name, x in (("boot", -7.5), ("enable", 7.5)):
        box(
            f"board-{name}",
            f"{name.title()} switch",
            (x, board_y + 1.65, board_z + 19),
            (3, 1.7, 3.4),
            "chip",
            group="board",
        )

    # Scale an oval to the inner circumference using Ramanujan's ellipse approximation.
    vertical_ratio, longitudinal_ratio = 0.82, 1.16
    h = ((longitudinal_ratio - vertical_ratio) / (longitudinal_ratio + vertical_ratio)) ** 2
    factor = pi * (vertical_ratio + longitudinal_ratio) * (1 + 3 * h / (10 + sqrt(4 - 3 * h)))
    ry, rz = wrist * vertical_ratio / factor, wrist * longitudinal_ratio / factor
    angle = asin(min(outer_z / 2 - 2, 0.86 * rz) / rz)
    nodes.append(
        AssemblyNode(
            id="strap",
            label="Adjustable oval strap",
            position_mm=(0, -(ry + 2.4) * cos(angle), 0),
            geometry=Shape(
                kind="curved_strap",
                size_mm=(29, 2.4, 2 * rz),
                bend_radii_mm=(ry, rz),
                start_angle_rad=angle,
            ),
            material="strap",
            fidelity="parametric",
        )
    )

    verify_clearance(nodes, inner_x, inner_z, wall, lid_floor, gap)
    return AssemblyManifest(
        parameters=parameters,
        nodes=nodes,
        findings=[
            Finding(
                check="enclosure_clearance",
                status="pass",
                detail=f"Board envelopes clear the inner walls, floor and lid by at least {gap:g} mm.",
            ),
            Finding(
                check="board_separation",
                status="pass",
                detail=f"The board envelopes have at least {gap:g} mm of vertical separation.",
            ),
            Finding(
                check="wrist_size",
                status="unknown" if wrist_source == "preview default" else "pass",
                detail=f"{wrist:g} mm inner wrist circumference ({wrist_source}).",
            ),
            Finding(
                check="physical_fit",
                status="unknown",
                detail=(
                    "PCB outlines use published drawings. Populated heights, snap positions in "
                    "the enclosure, connector access, fastening and contact fit need verification."
                ),
            ),
        ],
    )


def verify_clearance(
    nodes: list[AssemblyNode],
    inner_x: float,
    inner_z: float,
    floor: float,
    lid: float,
    gap: float,
) -> None:
    """Check the proxy geometry against the enclosure and adjacent component envelope."""
    tolerance = 1e-6
    bounds: dict[str, tuple[float, float]] = {}
    for group in ("sensor-1", "board"):
        parts = [node for node in nodes if node.part_instance_id == group]
        bottom = min(node.position_mm[1] - node.geometry.size_mm[1] / 2 for node in parts)
        top = max(node.position_mm[1] + node.geometry.size_mm[1] / 2 for node in parts)
        bounds[group] = bottom, top
        if bottom < floor + gap - tolerance or top > lid - gap + tolerance:
            raise GeometryError(f"The {group} proxy exceeds the vertical clearance.")
        for node in parts:
            x = abs(node.position_mm[0]) + node.geometry.size_mm[0] / 2
            z = abs(node.position_mm[2]) + node.geometry.size_mm[2] / 2
            if x + gap > inner_x / 2 + tolerance or z + gap > inner_z / 2 + tolerance:
                raise GeometryError(f"The {group} proxy exceeds the enclosure footprint.")
            # The signed distance to the rounded inner corner also guards diagonal clipping.
            corner_x = x - (inner_x / 2 - 1.5)
            corner_z = z - (inner_z / 2 - 1.5)
            if corner_x > 0 and corner_z > 0:
                distance = sqrt(corner_x**2 + corner_z**2) - 1.5
                if distance + gap > tolerance:
                    raise GeometryError(f"The {group} proxy clips a rounded corner.")

    if bounds["board"][0] - bounds["sensor-1"][1] < gap - tolerance:
        raise GeometryError("The board and sensor proxies overlap their clearance zones.")


def export_glb(manifest: AssemblyManifest) -> bytes:
    """Return a glTF 2.0 binary model with named, independently pickable components."""
    return glb.export(manifest)
