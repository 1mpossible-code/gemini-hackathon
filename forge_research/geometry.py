"""Dimension-driven wristband assembly and mechanical review."""

from math import asin, cos, pi, sqrt
from typing import Literal

from pydantic import BaseModel

from . import glb
from .models import (
    AssemblyParameters,
    ComponentInstance,
    DeviceSpecification,
    Finding,
    Part,
    ResearchReport,
)

ESP32 = "esp32-devkitc-32e"
UNO = "arduino-uno-r3"
MYOWARE = "myoware-2-dev-27924"
ESP32_DRAWING = "https://dl.espressif.com/dl/schematics/esp32_devkitc_v4_dimensions.pdf"
UNO_DRAWING = "https://docs.arduino.cc/hardware/uno-rev3/"
MYOWARE_DRAWING = (
    "https://cdn.sparkfun.com/assets/learn_tutorials/1/9/5/6/"
    "MyoWare_v2_Muscle_Sensor_Board_Dimensions.png"
)
Vector = tuple[float, float, float]
Material = Literal["shell", "strap", "pcb", "metal", "chip", "contact", "lid"]


class GeometryError(ValueError):
    """The requested assembly cannot be generated from the available mechanical evidence."""


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
    envelope_mm: Vector | None = None
    nodes: list[AssemblyNode]
    findings: list[Finding]


def _resolve_wrist(
    parameters: AssemblyParameters | None, req_wrist_mm: int | None
) -> tuple[AssemblyParameters, float, str]:
    parameters = parameters or AssemblyParameters()
    wrist = parameters.wrist_circumference_mm
    wrist_source = "edited"
    if wrist is None:
        wrist = req_wrist_mm
        wrist_source = "brief"
    if wrist is None:
        wrist = 170.0
        wrist_source = "preview default"
    if not 120 <= wrist <= 240:
        raise GeometryError("Wrist circumference must be between 120 and 240 mm.")
    resolved = AssemblyParameters(
        wrist_circumference_mm=wrist,
        wall_mm=parameters.wall_mm,
        clearance_mm=parameters.clearance_mm,
    )
    return resolved, float(wrist), wrist_source


def _append_sensor_nodes(
    box_fn,
    group_id: str,
    label: str,
    cx: float,
    sensor_y: float,
    sensor_top: float,
    pcb: float,
) -> None:
    box_fn(
        group_id,
        label,
        (cx, sensor_y, 0),
        (37.57, pcb, 35.90),
        "pcb",
        group=group_id,
        catalog_id=MYOWARE,
        source_url=MYOWARE_DRAWING,
        kind="sensor_outline",
    )
    prefix = "sensor" if group_id == "sensor-1" else group_id
    for name, dx, z in (("ref", 0, -11.81), ("end", -12.70, 11.81), ("mid", 12.70, 11.81)):
        box_fn(
            f"{prefix}-{name}",
            f"{name.upper()} electrode snap",
            (cx + dx, sensor_top - 1.72, z),
            (10, 3.16, 10),
            "metal",
            group=group_id,
            catalog_id=MYOWARE,
            source_url=MYOWARE_DRAWING,
            kind="cylinder",
        )
        box_fn(
            f"{prefix}-{name}-center",
            "Electrode snap center",
            (cx + dx, sensor_top - 0.07, z),
            (4.6, 0.14, 4.6),
            "chip",
            group=group_id,
            catalog_id=MYOWARE,
            source_url=MYOWARE_DRAWING,
            kind="cylinder",
        )
    for index, z in enumerate((-3, 3, 8), start=1):
        box_fn(
            f"{prefix}-ic-{index}",
            "Sensor IC",
            (cx, sensor_y + 1.3, z),
            (4.7, 1, 3.7),
            "chip",
            group=group_id,
            catalog_id=MYOWARE,
            source_url=MYOWARE_DRAWING,
        )


def _append_controller_nodes(box_fn, controller_id: str, board_y: float, pcb: float) -> float:
    if controller_id == ESP32:
        board_z = -1.25  # Center the USB extension within the enclosure.
        box_fn(
            "board",
            "ESP32 DevKitC V4",
            (0, board_y, board_z),
            (27.94, pcb, 48.26),
            "pcb",
            group="board",
            catalog_id=ESP32,
            source_url=ESP32_DRAWING,
            radius_mm=0.8,
        )
        box_fn(
            "board-radio",
            "WROOM-32E shield",
            (0, board_y + 2, board_z - 9),
            (16, 2.4, 18),
            "metal",
            group="board",
            catalog_id=ESP32,
            source_url=ESP32_DRAWING,
            radius_mm=0.7,
        )
        box_fn(
            "board-antenna",
            "Antenna region",
            (0, board_y + 1.05, board_z - 20),
            (18, 0.5, 6.2),
            "chip",
            group="board",
            catalog_id=ESP32,
            source_url=ESP32_DRAWING,
        )
        box_fn(
            "board-usb",
            "Micro USB connector",
            (0, board_y + 2.55, board_z + 22.4),
            (7.7, 3.5, 8.46),
            "metal",
            group="board",
            catalog_id=ESP32,
            source_url=ESP32_DRAWING,
            radius_mm=0.5,
        )
        for side, x in (("left", -11.3), ("right", 11.3)):
            box_fn(
                f"board-{side}-header",
                "Pin header",
                (x, board_y + 1.8, board_z),
                (2.65, 2, 46.7),
                "chip",
                group="board",
                catalog_id=ESP32,
                source_url=ESP32_DRAWING,
            )
            for index in range(19):
                z = board_z + (index - 9) * 2.54
                box_fn(
                    f"board-{side}-pin-{index + 1}",
                    "Header pin",
                    (x, board_y + 2.95, z),
                    (0.95, 0.3, 0.95),
                    "contact",
                    group="board",
                    catalog_id=ESP32,
                    source_url=ESP32_DRAWING,
                )
        for name, x in (("boot", -7.5), ("enable", 7.5)):
            box_fn(
                f"board-{name}",
                f"{name.title()} switch",
                (x, board_y + 1.65, board_z + 19),
                (3, 1.7, 3.4),
                "chip",
                group="board",
                catalog_id=ESP32,
                source_url=ESP32_DRAWING,
            )
        return board_y + pcb / 2 + 3.5

    if controller_id == UNO:
        box_fn(
            "board",
            "Arduino UNO Rev3",
            (0, board_y, 0),
            (53.4, pcb, 68.6),
            "pcb",
            group="board",
            catalog_id=UNO,
            source_url=UNO_DRAWING,
            radius_mm=1.0,
        )
        box_fn(
            "board-mcu",
            "ATmega328P DIP-28",
            (4.0, board_y + 2.3, -6.0),
            (8.8, 3.0, 35.0),
            "chip",
            group="board",
            catalog_id=UNO,
            source_url=UNO_DRAWING,
        )
        box_fn(
            "board-usb",
            "USB Type-B receptacle",
            (-15.5, board_y + 5.8, 26.5),
            (12.0, 10.0, 15.0),
            "metal",
            group="board",
            catalog_id=UNO,
            source_url=UNO_DRAWING,
            radius_mm=0.6,
        )
        box_fn(
            "board-barrel",
            "DC barrel jack",
            (17.5, board_y + 5.8, 27.0),
            (9.0, 10.0, 13.5),
            "chip",
            group="board",
            catalog_id=UNO,
            source_url=UNO_DRAWING,
        )
        for side, x in (("left", -24.1), ("right", 24.1)):
            box_fn(
                f"board-{side}-header",
                "Female header bank",
                (x, board_y + 4.8, -4.0),
                (2.54, 8.0, 44.0),
                "chip",
                group="board",
                catalog_id=UNO,
                source_url=UNO_DRAWING,
            )
        return board_y + pcb / 2 + 10.2

    raise GeometryError(f"Mechanical geometry is not available for controller '{controller_id}'.")


def _build_manifest(
    controller_id: str,
    sensor_id: str,
    sensor_qty: int,
    parameters: AssemblyParameters | None,
    req_wrist_mm: int | None,
) -> AssemblyManifest:
    if sensor_id != MYOWARE or controller_id not in {ESP32, UNO}:
        raise GeometryError(
            "Mechanical geometry is available for ESP32 or Arduino UNO with MyoWare 2."
        )
    if not 1 <= sensor_qty <= 2:
        raise GeometryError("Mechanical enclosure supports 1 or 2 EMG sensors.")

    parameters, wrist, wrist_source = _resolve_wrist(parameters, req_wrist_mm)
    wall, gap = parameters.wall_mm, parameters.clearance_mm
    pcb = 1.6
    sensor_y = wall + gap + pcb / 2
    sensor_top = sensor_y + pcb / 2 + 3.3
    board_y = sensor_top + gap + pcb / 2
    board_top = board_y + pcb / 2 + (3.5 if controller_id == ESP32 else 10.2)

    sensor_span_x = 37.57 if sensor_qty == 1 else (2 * 37.57 + gap + 2.0)
    board_span_x = 27.94 if controller_id == ESP32 else 53.4
    board_span_z = (48.26 + 2.5) if controller_id == ESP32 else (68.6 + 2.0)
    inner_x = max(sensor_span_x, board_span_x) + 2 * gap
    inner_z = max(35.90, board_span_z) + 2 * gap
    outer_x, outer_z = inner_x + 2 * wall, inner_z + 2 * wall
    lid_floor = board_top + gap
    frame_y = lid_floor - wall
    total_y = lid_floor + wall
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
        group: str | None = None,
        catalog_id: str | None = None,
        source_url: str | None = None,
        kind: Literal[
            "rounded_box", "rounded_frame", "sensor_outline", "cylinder"
        ] = "rounded_box",
        frame_wall: float = 0.0,
    ) -> None:
        root = group == node_id
        nodes.append(
            AssemblyNode(
                id=node_id,
                label=label,
                part_instance_id=group,
                catalog_id=catalog_id,
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
                source=source_url,
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

    if sensor_qty == 1:
        _append_sensor_nodes(box, "sensor-1", "MyoWare 2 sensor", 0.0, sensor_y, sensor_top, pcb)
        sensor_groups = ["sensor-1"]
    else:
        offset_x = (37.57 + gap + 2.0) / 2
        _append_sensor_nodes(
            box, "sensor-1", "MyoWare 2 sensor (Ch 1)", -offset_x, sensor_y, sensor_top, pcb
        )
        _append_sensor_nodes(
            box, "sensor-2", "MyoWare 2 sensor (Ch 2)", offset_x, sensor_y, sensor_top, pcb
        )
        sensor_groups = ["sensor-1", "sensor-2"]

    _append_controller_nodes(box, controller_id, board_y, pcb)

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

    verify_clearance(nodes, inner_x, inner_z, wall, lid_floor, gap, sensor_groups)
    return AssemblyManifest(
        parameters=parameters,
        envelope_mm=(round(outer_x, 2), round(total_y, 2), round(outer_z, 2)),
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
                detail=f"The board envelopes have at least {gap:g} mm of separation.",
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
    return _build_manifest(
        ESP32, MYOWARE, 1, parameters, report.requirements.wrist_circumference_mm
    )


def build_assembly_for_spec(
    spec: DeviceSpecification, catalog_snapshot: dict[str, Part]
) -> AssemblyManifest:
    """Generate parametric 3D assembly directly from a canonical DeviceSpecification."""
    controllers: list[ComponentInstance] = [c for c in spec.components if c.role == "controller"]
    sensors: list[ComponentInstance] = [c for c in spec.components if c.role == "emg_sensor"]
    if len(controllers) != 1 or len(sensors) != 1:
        raise GeometryError("Assembly requires one controller and one EMG sensor entry.")
    ctrl_inst, sens_inst = controllers[0], sensors[0]
    if ctrl_inst.catalog_id not in catalog_snapshot or sens_inst.catalog_id not in catalog_snapshot:
        raise GeometryError("Selected components are missing from the sourced catalog snapshot.")
    return _build_manifest(
        ctrl_inst.catalog_id,
        sens_inst.catalog_id,
        sens_inst.quantity,
        spec.mechanical,
        spec.requirements.wrist_circumference_mm,
    )


def verify_clearance(
    nodes: list[AssemblyNode],
    inner_x: float,
    inner_z: float,
    floor: float,
    lid: float,
    gap: float,
    sensor_groups: list[str] | None = None,
) -> None:
    """Check the proxy geometry against the enclosure and adjacent component envelope."""
    tolerance = 1e-6
    sensors = sensor_groups or ["sensor-1"]
    bounds: dict[str, tuple[float, float]] = {}
    x_spans: dict[str, tuple[float, float]] = {}
    for group in (*sensors, "board"):
        parts = [node for node in nodes if node.part_instance_id == group]
        bottom = min(node.position_mm[1] - node.geometry.size_mm[1] / 2 for node in parts)
        top = max(node.position_mm[1] + node.geometry.size_mm[1] / 2 for node in parts)
        min_x = min(node.position_mm[0] - node.geometry.size_mm[0] / 2 for node in parts)
        max_x = max(node.position_mm[0] + node.geometry.size_mm[0] / 2 for node in parts)
        bounds[group] = bottom, top
        x_spans[group] = min_x, max_x
        if bottom < floor + gap - tolerance or top > lid - gap + tolerance:
            raise GeometryError(f"The {group} proxy exceeds the vertical clearance.")
        for node in parts:
            x = abs(node.position_mm[0]) + node.geometry.size_mm[0] / 2
            z = abs(node.position_mm[2]) + node.geometry.size_mm[2] / 2
            if x + gap > inner_x / 2 + tolerance or z + gap > inner_z / 2 + tolerance:
                raise GeometryError(f"The {group} proxy exceeds the enclosure footprint.")
            corner_x = x - (inner_x / 2 - 1.5)
            corner_z = z - (inner_z / 2 - 1.5)
            if corner_x > 0 and corner_z > 0:
                distance = sqrt(corner_x**2 + corner_z**2) - 1.5
                if distance + gap > tolerance:
                    raise GeometryError(f"The {group} proxy clips a rounded corner.")

    max_sensor_top = max(bounds[s][1] for s in sensors)
    if bounds["board"][0] - max_sensor_top < gap - tolerance:
        raise GeometryError("The board and sensor proxies overlap their clearance zones.")
    if len(sensors) == 2:
        if x_spans[sensors[1]][0] - x_spans[sensors[0]][1] < gap - tolerance:
            raise GeometryError("Dual EMG sensor proxies overlap laterally.")


def export_glb(manifest: AssemblyManifest) -> bytes:
    """Return a glTF 2.0 binary model with named, independently pickable components."""
    return glb.export(manifest)
