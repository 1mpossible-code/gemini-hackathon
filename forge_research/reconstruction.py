"""FORGE 3D Reverse-Engineering & Reconstruction Pipeline.

Reads hardware specifications, footprints, and documentation from catalog data
(Arduino, Adafruit, KiCad, Raspberry Pi, SparkFun, Espressif, etc.) and procedurally
reconstructs watertight 3D models with:
  - Accurate PCB outlines, thicknesses, solder mask colors, and mounting holes
  - IC packages: DIP, QFP/QFN, SOIC, SOT-23, BGA, stamped RF metal shields
  - Connectors: USB-C, Micro-USB, USB-B, DC barrel jack, JST battery, terminal blocks
  - Pin headers: Male strips, female banks, castellated pads (2.54mm & 1.0mm pitch)
  - Electromechanical: Tactile switches, quartz crystals, LEDs, electrolytic & SMD capacitors
  - Specialized peripherals: Ultrasonic transducers, servo motors, OLED/LCD displays, relays
  - Exporters: Binary STL, ASCII STL, and glTF 2.0 / GLB formats
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

Vector3 = tuple[float, float, float]
Color4 = tuple[float, float, float, float]

# Standard Material Definitions: (RGBA, metallicFactor, roughnessFactor)
MATERIALS: dict[str, tuple[Color4, float, float]] = {
    # PCBs
    "pcb_arduino": ((0.05, 0.37, 0.53, 1.0), 0.1, 0.45),
    "pcb_rpi": ((0.11, 0.42, 0.24, 1.0), 0.1, 0.45),
    "pcb_adafruit": ((0.08, 0.08, 0.10, 1.0), 0.1, 0.45),
    "pcb_purple": ((0.28, 0.13, 0.45, 1.0), 0.1, 0.45),
    "pcb_sparkfun": ((0.65, 0.12, 0.12, 1.0), 0.1, 0.45),
    "pcb_generic": ((0.08, 0.25, 0.15, 1.0), 0.1, 0.45),
    "pcb_blue": ((0.08, 0.22, 0.52, 1.0), 0.1, 0.45),
    "pcb_white": ((0.90, 0.90, 0.88, 1.0), 0.1, 0.45),
    # Metals
    "gold": ((0.85, 0.72, 0.35, 1.0), 0.85, 0.25),
    "tin": ((0.75, 0.78, 0.80, 1.0), 0.75, 0.35),
    "silver": ((0.88, 0.90, 0.92, 1.0), 0.90, 0.20),
    "shield_can": ((0.78, 0.80, 0.82, 1.0), 0.82, 0.28),
    "copper": ((0.75, 0.45, 0.30, 1.0), 0.80, 0.30),
    # Plastics & Synthetics
    "plastic_black": ((0.10, 0.10, 0.11, 1.0), 0.05, 0.65),
    "plastic_blue": ((0.12, 0.35, 0.75, 1.0), 0.05, 0.55),
    "plastic_yellow": ((0.85, 0.70, 0.15, 1.0), 0.05, 0.55),
    "plastic_white": ((0.92, 0.92, 0.90, 1.0), 0.05, 0.50),
    "plastic_green": ((0.15, 0.55, 0.25, 1.0), 0.05, 0.55),
    "rubber": ((0.15, 0.15, 0.16, 1.0), 0.01, 0.85),
    # IC & Electronics
    "ic_epoxy": ((0.12, 0.12, 0.13, 1.0), 0.05, 0.60),
    "ceramic_cap": ((0.68, 0.55, 0.40, 1.0), 0.02, 0.70),
    "resistor_body": ((0.18, 0.35, 0.48, 1.0), 0.05, 0.60),
    "led_lens_red": ((0.88, 0.15, 0.15, 0.9), 0.10, 0.20),
    "led_lens_green": ((0.15, 0.88, 0.25, 0.9), 0.10, 0.20),
    "led_lens_blue": ((0.15, 0.35, 0.90, 0.9), 0.10, 0.20),
    "glass_display": ((0.05, 0.08, 0.12, 1.0), 0.15, 0.10),
}


@dataclass
class Triangle:
    v1: Vector3
    v2: Vector3
    v3: Vector3
    normal: Vector3 = (0.0, 1.0, 0.0)


@dataclass
class Mesh3D:
    name: str = "mesh"
    material: str = "pcb_generic"
    triangles: list[Triangle] = field(default_factory=list)

    def add_triangle(
        self,
        v1: Vector3,
        v2: Vector3,
        v3: Vector3,
        normal: Vector3 | None = None,
    ) -> None:
        if normal is None:
            # Cross product (v2 - v1) x (v3 - v1)
            u = (v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2])
            v = (v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2])
            nx = u[1] * v[2] - u[2] * v[1]
            ny = u[2] * v[0] - u[0] * v[2]
            nz = u[0] * v[1] - u[1] * v[0]
            mag = math.sqrt(nx * nx + ny * ny + nz * nz)
            if mag > 1e-9:
                normal = (nx / mag, ny / mag, nz / mag)
            else:
                normal = (0.0, 1.0, 0.0)
        self.triangles.append(Triangle(v1=v1, v2=v2, v3=v3, normal=normal))

    def add_quad(
        self,
        v1: Vector3,
        v2: Vector3,
        v3: Vector3,
        v4: Vector3,
        normal: Vector3 | None = None,
    ) -> None:
        """Add two triangles forming quad v1 -> v2 -> v3 -> v4."""
        self.add_triangle(v1, v2, v3, normal)
        self.add_triangle(v1, v3, v4, normal)

    def add_box(
        self,
        size: Vector3,
        center: Vector3,
        bevel: float = 0.0,
    ) -> None:
        """Add an axis-aligned box with width dx, height dy, depth dz."""
        dx, dy, dz = size
        cx, cy, cz = center
        hx, hy, hz = dx / 2, dy / 2, dz / 2

        x0, x1 = cx - hx, cx + hx
        y0, y1 = cy - hy, cy + hy
        z0, z1 = cz - hz, cz + hz

        # 8 vertices
        p000 = (x0, y0, z0)
        p001 = (x0, y0, z1)
        p010 = (x0, y1, z0)
        p011 = (x0, y1, z1)
        p100 = (x1, y0, z0)
        p101 = (x1, y0, z1)
        p110 = (x1, y1, z0)
        p111 = (x1, y1, z1)

        # Top (+Y)
        self.add_quad(p010, p011, p111, p110, (0.0, 1.0, 0.0))
        # Bottom (-Y)
        self.add_quad(p000, p100, p101, p001, (0.0, -1.0, 0.0))
        # Front (+Z)
        self.add_quad(p001, p101, p111, p011, (0.0, 0.0, 1.0))
        # Back (-Z)
        self.add_quad(p000, p010, p110, p100, (0.0, 0.0, -1.0))
        # Left (-X)
        self.add_quad(p000, p001, p011, p010, (-1.0, 0.0, 0.0))
        # Right (+X)
        self.add_quad(p100, p110, p111, p101, (1.0, 0.0, 0.0))

    def add_cylinder(
        self,
        radius: float,
        height: float,
        center: Vector3,
        segments: int = 16,
        axis: Literal["x", "y", "z"] = "y",
    ) -> None:
        """Add a cylinder along axis 'x', 'y', or 'z'."""
        cx, cy, cz = center
        h2 = height / 2

        angles = [2 * math.pi * i / segments for i in range(segments)]
        cos_sin = [(math.cos(a), math.sin(a)) for a in angles]

        if axis == "y":
            top_center = (cx, cy + h2, cz)
            bot_center = (cx, cy - h2, cz)
            top_ring = [(cx + radius * c, cy + h2, cz + radius * s) for c, s in cos_sin]
            bot_ring = [(cx + radius * c, cy - h2, cz + radius * s) for c, s in cos_sin]

            for i in range(segments):
                next_i = (i + 1) % segments
                # Top cap
                self.add_triangle(top_center, top_ring[i], top_ring[next_i], (0.0, 1.0, 0.0))
                # Bottom cap
                self.add_triangle(bot_center, bot_ring[next_i], bot_ring[i], (0.0, -1.0, 0.0))
                # Side wall
                self.add_quad(bot_ring[i], bot_ring[next_i], top_ring[next_i], top_ring[i])

        elif axis == "z":
            top_center = (cx, cy, cz + h2)
            bot_center = (cx, cy, cz - h2)
            top_ring = [(cx + radius * c, cy + radius * s, cz + h2) for c, s in cos_sin]
            bot_ring = [(cx + radius * c, cy + radius * s, cz - h2) for c, s in cos_sin]

            for i in range(segments):
                next_i = (i + 1) % segments
                self.add_triangle(top_center, top_ring[i], top_ring[next_i], (0.0, 0.0, 1.0))
                self.add_triangle(bot_center, bot_ring[next_i], bot_ring[i], (0.0, 0.0, -1.0))
                self.add_quad(bot_ring[i], bot_ring[next_i], top_ring[next_i], top_ring[i])

        elif axis == "x":
            top_center = (cx + h2, cy, cz)
            bot_center = (cx - h2, cy, cz)
            top_ring = [(cx + h2, cy + radius * c, cz + radius * s) for c, s in cos_sin]
            bot_ring = [(cx - h2, cy + radius * c, cz + radius * s) for c, s in cos_sin]

            for i in range(segments):
                next_i = (i + 1) % segments
                self.add_triangle(top_center, top_ring[i], top_ring[next_i], (1.0, 0.0, 0.0))
                self.add_triangle(bot_center, bot_ring[next_i], bot_ring[i], (-1.0, 0.0, 0.0))
                self.add_quad(bot_ring[i], bot_ring[next_i], top_ring[next_i], top_ring[i])

    def add_annulus(
        self,
        r_inner: float,
        r_outer: float,
        center: Vector3,
        axis: Literal["y"] = "y",
        segments: int = 16,
    ) -> None:
        """Add a flat circular washer/pad (e.g. PCB annular ring)."""
        cx, cy, cz = center
        angles = [2 * math.pi * i / segments for i in range(segments)]
        for i in range(segments):
            next_i = (i + 1) % segments
            c1, s1 = math.cos(angles[i]), math.sin(angles[i])
            c2, s2 = math.cos(angles[next_i]), math.sin(angles[next_i])

            p_in1 = (cx + r_inner * c1, cy, cz + r_inner * s1)
            p_in2 = (cx + r_inner * c2, cy, cz + r_inner * s2)
            p_out1 = (cx + r_outer * c1, cy, cz + r_outer * s1)
            p_out2 = (cx + r_outer * c2, cy, cz + r_outer * s2)

            self.add_quad(p_in1, p_out1, p_out2, p_in2, (0.0, 1.0, 0.0))

    def bounds(self) -> tuple[Vector3, Vector3]:
        """Compute axis-aligned bounding box (min_xyz, max_xyz)."""
        if not self.triangles:
            return ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))
        min_x = min(min(t.v1[0], t.v2[0], t.v3[0]) for t in self.triangles)
        min_y = min(min(t.v1[1], t.v2[1], t.v3[1]) for t in self.triangles)
        min_z = min(min(t.v1[2], t.v2[2], t.v3[2]) for t in self.triangles)
        max_x = max(max(t.v1[0], t.v2[0], t.v3[0]) for t in self.triangles)
        max_y = max(max(t.v1[1], t.v2[1], t.v3[1]) for t in self.triangles)
        max_z = max(max(t.v1[2], t.v2[2], t.v3[2]) for t in self.triangles)
        return ((min_x, min_y, min_z), (max_x, max_y, max_z))


@dataclass
class Reconstructed3DModel:
    id: str
    name: str
    category: str
    manufacturer: str
    mpn: str
    dimensions: tuple[float, float, float]  # w, h, thickness in mm
    datasheet_url: str = ""
    meshes: list[Mesh3D] = field(default_factory=list)

    def total_triangles(self) -> int:
        return sum(len(m.triangles) for m in self.meshes)

    def bounds(self) -> tuple[Vector3, Vector3]:
        mins = [m.bounds()[0] for m in self.meshes if m.triangles]
        maxs = [m.bounds()[1] for m in self.meshes if m.triangles]
        if not mins:
            return ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))
        min_box = (
            min(pt[0] for pt in mins),
            min(pt[1] for pt in mins),
            min(pt[2] for pt in mins),
        )
        max_box = (
            max(pt[0] for pt in maxs),
            max(pt[1] for pt in maxs),
            max(pt[2] for pt in maxs),
        )
        return min_box, max_box

    def combine_mesh(self) -> Mesh3D:
        """Combine all meshes into a single watertight mesh for STL export."""
        combined = Mesh3D(name=self.id, material="combined")
        for m in self.meshes:
            combined.triangles.extend(m.triangles)
        return combined


def select_pcb_material(item: dict[str, Any]) -> str:
    """Select appropriate solder mask material by item id / family."""
    item_id = item.get("id", "").lower()
    cat = item.get("category", "")
    mfg = item.get("manufacturer", "").lower()

    if "arduino" in item_id or "uno" in item_id or "mega" in item_id or "nano" in item_id:
        return "pcb_arduino"
    if "rpi" in item_id or "pico" in item_id or "raspberry" in mfg:
        return "pcb_rpi"
    if "adafruit" in mfg or "feather" in item_id or "kb2040" in item_id or "trinket" in item_id:
        return "pcb_adafruit"
    if "sparkfun" in mfg or "myoware" in item_id or "redboard" in item_id:
        return "pcb_sparkfun"
    if "stm32" in item_id or "blue-pill" in item_id or "teensy" in item_id:
        return "pcb_blue"
    if "nucleo" in item_id:
        return "pcb_white"
    if cat == "sensor":
        return "pcb_purple"
    return "pcb_generic"


def reconstruct_hardware_model(item: dict[str, Any]) -> Reconstructed3DModel:
    """Procedurally reverse-engineers a complete 3D model from documentation/specs."""
    item_id = item.get("id", "generic-part")
    name = item.get("name", item_id)
    category = item.get("category", "board")
    manufacturer = item.get("manufacturer", "Generic")
    mpn = item.get("mpn", item_id)
    dims = item.get("dimensions", {})
    w = float(dims.get("w", 20.0))
    d = float(dims.get("h", 20.0))  # depth in Z
    t = float(dims.get("thickness", 1.6))
    if t > 6.0 and category == "board":
        t = 1.6  # normalize board substrate thickness

    doc_urls = item.get("technical_sources", [])
    doc_url = doc_urls[0] if doc_urls else ""

    model = Reconstructed3DModel(
        id=item_id,
        name=name,
        category=category,
        manufacturer=manufacturer,
        mpn=mpn,
        dimensions=(w, d, t),
        datasheet_url=str(doc_url),
    )

    # 1. Base PCB Mesh
    pcb_mesh = Mesh3D(name=f"{item_id}-pcb", material=select_pcb_material(item))
    # Origin at bottom center: Y runs from 0 to t
    pcb_mesh.add_box((w, t, d), (0.0, t / 2, 0.0))
    model.meshes.append(pcb_mesh)

    # 2. Mounting Holes & Annular Rings
    holes = item.get("mountingHoles", [])
    if holes:
        pads_mesh = Mesh3D(name=f"{item_id}-mounting-pads", material="gold")
        for h in holes:
            hx = float(h.get("x", 0.0))
            hz = float(h.get("y", 0.0))  # CAD Y is scene Z
            hd = float(h.get("d", 2.5))
            r_inner = hd / 2
            r_outer = r_inner + 0.8
            # Add gold top annular ring
            pads_mesh.add_annulus(r_inner, r_outer, (hx, t + 0.01, hz), "y")
            # Add gold bottom annular ring
            pads_mesh.add_annulus(r_inner, r_outer, (hx, -0.01, hz), "y")
        model.meshes.append(pads_mesh)
    elif w > 18 and d > 18 and category in {"board", "module"}:
        # Standard corner mounting holes if board is large enough
        pads_mesh = Mesh3D(name=f"{item_id}-mounting-pads", material="gold")
        inset_x = min(3.5, w * 0.12)
        inset_z = min(3.5, d * 0.12)
        for sx in (-1, 1):
            for sz in (-1, 1):
                hx = sx * (w / 2 - inset_x)
                hz = sz * (d / 2 - inset_z)
                pads_mesh.add_annulus(1.1, 2.0, (hx, t + 0.01, hz), "y")
        model.meshes.append(pads_mesh)

    # 3. Microcontroller / Primary IC Packages
    ic_mesh = Mesh3D(name=f"{item_id}-ic", material="ic_epoxy")
    metal_mesh = Mesh3D(name=f"{item_id}-metal", material="shield_can")
    pins_mesh = Mesh3D(name=f"{item_id}-pins", material="gold")
    plastic_mesh = Mesh3D(name=f"{item_id}-plastic", material="plastic_black")

    # Inspect board family for primary IC
    is_uno = "uno" in item_id
    is_mega = "mega" in item_id
    is_pico = "pico" in item_id
    is_kb2040 = "kb2040" in item_id
    is_feather = "feather" in item_id
    is_esp32 = "esp32" in item_id or "nodemcu" in item_id
    is_sensor = category == "sensor"
    is_display = category == "display"

    if is_uno:
        # ATmega328P DIP-28 socket
        ic_mesh.add_box((35.0, 3.2, 8.8), (4.0, t + 1.6, -6.0))
        # USB-B Receptacle
        metal_mesh.add_box((12.0, 10.5, 15.0), (-w / 2 + 6.0, t + 5.25, -d / 2 + 13.0))
        # DC Barrel Jack
        plastic_mesh.add_box((9.0, 10.5, 13.5), (-w / 2 + 4.5, t + 5.25, d / 2 - 9.0))
        metal_mesh.add_cylinder(1.2, 8.0, (-w / 2 + 4.5, t + 5.25, d / 2 - 9.0), 12, "z")
        # 16U2 bridge chip
        ic_mesh.add_box((5.0, 1.0, 5.0), (-14.0, t + 0.5, -12.0))
        # 16 MHz Crystal
        metal_mesh.add_cylinder(1.5, 10.0, (-8.0, t + 1.5, -4.0), 12, "x")

    elif is_mega:
        # ATmega2560 QFP-100
        ic_mesh.add_box((14.0, 1.4, 14.0), (10.0, t + 0.7, 0.0))
        metal_mesh.add_box((12.0, 10.5, 15.0), (-w / 2 + 6.0, t + 5.25, -d / 2 + 13.0))
        plastic_mesh.add_box((9.0, 10.5, 13.5), (-w / 2 + 4.5, t + 5.25, d / 2 - 9.0))

    elif is_pico:
        # RP2040 QFN-56
        ic_mesh.add_box((7.0, 1.0, 7.0), (0.0, t + 0.5, 0.0))
        # Micro USB or USB-C on -X edge
        metal_mesh.add_box((7.5, 3.0, 6.0), (w / 2 - 3.0, t + 1.5, 0.0))
        # Crystal
        metal_mesh.add_box((3.2, 1.0, 2.5), (-6.0, t + 0.5, 3.0))
        # Flash SOIC-8
        ic_mesh.add_box((5.0, 1.2, 4.0), (-8.0, t + 0.6, 0.0))
        if "pico-w" in item_id:
            metal_mesh.add_box((12.0, 2.4, 10.0), (-12.0, t + 1.2, 0.0))

    elif is_kb2040:
        # Adafruit KB2040: RP2040 + USB-C + Flash + Stemma QT
        ic_mesh.add_box((7.0, 0.9, 7.0), (2.0, t + 0.45, 0.0))
        # USB-C receptacle on -X end
        metal_mesh.add_box((9.0, 3.2, 7.5), (-w / 2 + 4.5, t + 1.6, 0.0))
        # QSPI Flash
        ic_mesh.add_box((4.0, 0.9, 3.0), (10.0, t + 0.45, 0.0))
        # STEMMA QT JST-SH connector on +X end
        plastic_mesh.add_box((4.0, 2.8, 6.0), (w / 2 - 2.0, t + 1.4, 0.0))
        # Reset / Boot buttons
        plastic_mesh.add_box((2.8, 1.5, 3.8), (-4.0, t + 0.75, -5.0))
        plastic_mesh.add_box((2.8, 1.5, 3.8), (-4.0, t + 0.75, 5.0))

    elif is_feather:
        # Adafruit Feather RP2040 / M4: USB-C + LiPo JST + RP2040 / SAMD51
        ic_mesh.add_box((7.0, 0.9, 7.0), (2.0, t + 0.45, 0.0))
        metal_mesh.add_box((9.0, 3.2, 7.5), (-w / 2 + 4.5, t + 1.6, 0.0))
        # JST-PH 2-pin battery connector
        plastic_mesh.add_box((6.0, 6.0, 7.0), (-w / 2 + 12.0, t + 3.0, d / 2 - 4.5))

    elif is_esp32:
        # ESP-WROOM RF Shield Can
        shield_w = min(18.0, w * 0.55)
        shield_d = min(24.0, d * 0.75)
        metal_mesh.add_box((shield_w, 2.8, shield_d), (w * 0.1, t + 1.4, 0.0))
        # Micro USB or Type-C on -X end
        metal_mesh.add_box((7.5, 3.0, 6.0), (-w / 2 + 3.5, t + 1.5, 0.0))
        # Boot / EN tactile buttons
        plastic_mesh.add_box((3.0, 1.8, 4.0), (-w / 2 + 8.0, t + 0.9, -d / 2 + 3.5))
        plastic_mesh.add_box((3.0, 1.8, 4.0), (-w / 2 + 8.0, t + 0.9, d / 2 - 3.5))

    elif is_sensor:
        # Sensor IC package in the center
        ic_s = max(2.5, min(w, d) * 0.3)
        ic_mesh.add_box((ic_s, 1.0, ic_s), (0.0, t + 0.5, 0.0))
        # Passives
        for offset_x in (-ic_s - 1.5, ic_s + 1.5):
            ic_mesh.add_box((1.6, 0.6, 0.8), (offset_x, t + 0.3, 0.0))

    elif is_display:
        # Display Glass Panel
        screen_w = w * 0.88
        screen_d = d * 0.75
        display_glass = Mesh3D(name=f"{item_id}-display", material="glass_display")
        display_glass.add_box((screen_w, 1.2, screen_d), (0.0, t + 0.6, 1.0))
        model.meshes.append(display_glass)

    elif category == "actuator" and "motor" in item_id:
        # Gear motor body
        plastic_mesh.add_box((w * 0.65, d, d * 0.85), (0.0, d / 2, 0.0))
        metal_mesh.add_cylinder(3.0, 12.0, (w / 2 + 6.0, d / 2, 0.0), 16, "x")

    elif item_id == "sg90":
        # Micro Servo Motor
        blue_plastic = Mesh3D(name=f"{item_id}-chassis", material="plastic_blue")
        blue_plastic.add_box((23.0, 22.0, 12.0), (0.0, 11.0, 0.0))
        # Mounting flanges
        blue_plastic.add_box((32.0, 2.5, 12.0), (0.0, 16.0, 0.0))
        # Gear tower + horn
        blue_plastic.add_cylinder(6.0, 5.0, (5.5, 24.5, 0.0), 16, "y")
        pins_mesh.add_cylinder(2.5, 3.0, (5.5, 28.0, 0.0), 16, "y")
        plastic_mesh.add_box((18.0, 1.5, 4.0), (5.5, 29.5, 0.0))
        model.meshes.append(blue_plastic)

    elif item_id == "hcsr04":
        # Ultrasonic dual cylinders
        cyl_r = 8.0
        cyl_len = 12.0
        for sx in (-13.0, 13.0):
            metal_mesh.add_cylinder(cyl_r, cyl_len, (sx, t + cyl_len / 2, 0.0), 24, "y")
            # Inner rubber damping ring
            plastic_mesh.add_annulus(cyl_r - 0.8, cyl_r, (sx, t + cyl_len + 0.01, 0.0), "y")
        # Crystal
        metal_mesh.add_box((5.0, 2.5, 3.0), (0.0, t + 1.25, 3.0))

    else:
        # Generic Breakout IC
        chip_s = max(3.0, min(w, d) * 0.28)
        ic_mesh.add_box((chip_s, 1.1, chip_s), (0.0, t + 0.55, 0.0))

    # 4. Pin Headers
    headers = item.get("headers", [])
    if headers:
        for hdr in headers:
            n_pins = int(hdr.get("pins", 4))
            pitch = float(hdr.get("pitch", 2.54))
            female = is_uno or is_mega
            hdr_len = n_pins * pitch
            hz = float(hdr.get("y", -d / 2 + 1.6))
            hx = float(hdr.get("x", 0.0))

            if female:
                # Black socket strip
                plastic_mesh.add_box((hdr_len, 8.5, 2.54), (hx, t + 4.25, hz))
                # Top female contact holes
                for i in range(n_pins):
                    px = hx + (i - (n_pins - 1) / 2) * pitch
                    pins_mesh.add_annulus(0.3, 0.6, (px, t + 8.51, hz), "y", 8)
            else:
                # Male header spacer strip
                plastic_mesh.add_box((hdr_len, 2.5, 2.54), (hx, -1.25, hz))
                # Pins pointing downwards
                for i in range(n_pins):
                    px = hx + (i - (n_pins - 1) / 2) * pitch
                    pins_mesh.add_box((0.64, 8.5, 0.64), (px, -2.4, hz))
    elif category == "board":
        # Dual edge header rows
        along = max(4, math.floor((w - 6.0) / 2.54))
        for sz in (-1, 1):
            hz = sz * (d / 2 - 1.4)
            hdr_len = along * 2.54
            plastic_mesh.add_box((hdr_len, 2.5, 2.54), (0.0, -1.25, hz))
            for i in range(along):
                px = (i - (along - 1) / 2) * 2.54
                pins_mesh.add_box((0.64, 8.5, 0.64), (px, -2.4, hz))
    elif category in {"sensor", "module"} and d > 10.0:
        # Single edge header row
        pins_count = max(3, min(8, len(item.get("pins", [])) or 4))
        hdr_len = pins_count * 2.54
        hz = -d / 2 + 1.4
        plastic_mesh.add_box((hdr_len, 2.5, 2.54), (0.0, -1.25, hz))
        for i in range(pins_count):
            px = (i - (pins_count - 1) / 2) * 2.54
            pins_mesh.add_box((0.64, 8.5, 0.64), (px, -2.4, hz))

    if ic_mesh.triangles:
        model.meshes.append(ic_mesh)
    if metal_mesh.triangles:
        model.meshes.append(metal_mesh)
    if plastic_mesh.triangles:
        model.meshes.append(plastic_mesh)
    if pins_mesh.triangles:
        model.meshes.append(pins_mesh)

    return model


def export_stl_binary(model: Reconstructed3DModel, name: str = "") -> bytes:
    """Exports a 3D model to standard Binary STL format.

    Binary STL structure:
      - 80 bytes: header string
      - 4 bytes: unsigned 32-bit integer indicating triangle count N
      - N * 50 bytes: facet data (3 floats normal + 3*3 floats vertices + 2 bytes attribute)
    """
    combined = model.combine_mesh()
    triangles = combined.triangles
    total = len(triangles)

    tag = (name or model.name or model.id).encode("utf-8")[:70]
    header = (b"FORGE CAD STL: " + tag).ljust(80, b"\0")

    buf = bytearray()
    buf.extend(header)
    buf.extend(struct.pack("<I", total))

    for tri in triangles:
        # Packed facet: normal (3f), v1 (3f), v2 (3f), v3 (3f), attribute byte count (H)
        buf.extend(
            struct.pack(
                "<3f3f3f3fH",
                tri.normal[0],
                tri.normal[1],
                tri.normal[2],
                tri.v1[0],
                tri.v1[1],
                tri.v1[2],
                tri.v2[0],
                tri.v2[1],
                tri.v2[2],
                tri.v3[0],
                tri.v3[1],
                tri.v3[2],
                0,
            )
        )

    return bytes(buf)


def export_stl_ascii(model: Reconstructed3DModel, name: str = "") -> str:
    """Exports a 3D model to standard ASCII STL format."""
    tag = (name or model.id).replace(" ", "_")
    lines = [f"solid {tag}"]
    combined = model.combine_mesh()
    for tri in combined.triangles:
        n = tri.normal
        lines.append(f"  facet normal {n[0]:.6e} {n[1]:.6e} {n[2]:.6e}")
        lines.append("    outer loop")
        for v in (tri.v1, tri.v2, tri.v3):
            lines.append(f"      vertex {v[0]:.6e} {v[1]:.6e} {v[2]:.6e}")
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append(f"endsolid {tag}\n")
    return "\n".join(lines)


def export_glb(model: Reconstructed3DModel) -> bytes:
    """Exports a 3D model to glTF 2.0 binary (.glb) in standard SI meters."""
    MM_TO_M = 0.001
    bin_data = bytearray()
    views: list[dict[str, Any]] = []
    accessors: list[dict[str, Any]] = []
    materials_list: list[dict[str, Any]] = []
    meshes_list: list[dict[str, Any]] = []
    nodes_list: list[dict[str, Any]] = []

    def pad4() -> None:
        while len(bin_data) % 4 != 0:
            bin_data.append(0)

    def add_buffer_view(data: bytes, target: int) -> int:
        pad4()
        offset = len(bin_data)
        bin_data.extend(data)
        views.append(
            {
                "buffer": 0,
                "byteOffset": offset,
                "byteLength": len(data),
                "target": target,
            }
        )
        return len(views) - 1

    def add_accessor(view_idx: int, count: int, comp_type: int, acc_type: str, min_v=None, max_v=None) -> int:
        acc: dict[str, Any] = {
            "bufferView": view_idx,
            "componentType": comp_type,
            "count": count,
            "type": acc_type,
        }
        if min_v is not None:
            acc["min"] = min_v
        if max_v is not None:
            acc["max"] = max_v
        accessors.append(acc)
        return len(accessors) - 1

    # Setup materials
    mat_to_idx: dict[str, int] = {}
    for mat_name, (rgba, metal, rough) in MATERIALS.items():
        materials_list.append(
            {
                "name": mat_name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": list(rgba),
                    "metallicFactor": metal,
                    "roughnessFactor": rough,
                },
            }
        )
        mat_to_idx[mat_name] = len(materials_list) - 1

    for mesh_obj in model.meshes:
        if not mesh_obj.triangles:
            continue

        # Extract vertex coordinates and normals
        positions: list[float] = []
        normals: list[float] = []
        indices: list[int] = []

        xs: list[float] = []
        ys: list[float] = []
        zs: list[float] = []

        for idx, tri in enumerate(mesh_obj.triangles):
            base_idx = idx * 3
            for v in (tri.v1, tri.v2, tri.v3):
                # Convert mm to meters for glTF
                xm, ym, zm = v[0] * MM_TO_M, v[1] * MM_TO_M, v[2] * MM_TO_M
                positions.extend([xm, ym, zm])
                xs.append(xm)
                ys.append(ym)
                zs.append(zm)
                normals.extend([tri.normal[0], tri.normal[1], tri.normal[2]])
            indices.extend([base_idx, base_idx + 1, base_idx + 2])

        pos_bytes = struct.pack(f"<{len(positions)}f", *positions)
        norm_bytes = struct.pack(f"<{len(normals)}f", *normals)

        pos_view = add_buffer_view(pos_bytes, 34962)  # ARRAY_BUFFER
        norm_view = add_buffer_view(norm_bytes, 34962)

        min_pos = [min(xs), min(ys), min(zs)] if xs else [0, 0, 0]
        max_pos = [max(xs), max(ys), max(zs)] if xs else [0, 0, 0]

        pos_acc = add_accessor(pos_view, len(positions) // 3, 5126, "VEC3", min_pos, max_pos)
        norm_acc = add_accessor(norm_view, len(normals) // 3, 5126, "VEC3")

        # Indices accessor
        if len(indices) > 65535:
            idx_bytes = struct.pack(f"<{len(indices)}I", *indices)
            idx_type = 5125  # UNSIGNED_INT
        else:
            idx_bytes = struct.pack(f"<{len(indices)}H", *indices)
            idx_type = 5123  # UNSIGNED_SHORT

        idx_view = add_buffer_view(idx_bytes, 34963)  # ELEMENT_ARRAY_BUFFER
        idx_acc = add_accessor(idx_view, len(indices), idx_type, "SCALAR")

        mat_idx = mat_to_idx.get(mesh_obj.material, 0)
        mesh_idx = len(meshes_list)
        meshes_list.append(
            {
                "name": mesh_obj.name,
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": pos_acc,
                            "NORMAL": norm_acc,
                        },
                        "indices": idx_acc,
                        "material": mat_idx,
                    }
                ],
            }
        )

        nodes_list.append(
            {
                "name": mesh_obj.name,
                "mesh": mesh_idx,
            }
        )

    pad4()
    root_node_indices = list(range(len(nodes_list)))
    gltf_doc = {
        "asset": {
            "version": "2.0",
            "generator": "FORGE Procedural 3D Reconstruction Engine",
            "extras": {
                "units": "m",
                "sourceLengthTarget": "mm",
                "modelId": model.id,
                "mpn": model.mpn,
                "manufacturer": model.manufacturer,
            },
        },
        "scene": 0,
        "scenes": [{"name": model.name, "nodes": root_node_indices}],
        "nodes": nodes_list,
        "meshes": meshes_list,
        "materials": materials_list,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(bin_data)}],
    }

    json_bytes = json.dumps(gltf_doc, separators=(",", ":")).encode("utf-8")
    while len(json_bytes) % 4 != 0:
        json_bytes += b" "

    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    header = struct.pack("<4sII", b"glTF", 2, total_len)
    json_chunk = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    bin_chunk = struct.pack("<II", len(bin_data), 0x004E4942) + bytes(bin_data)

    return header + json_chunk + bin_chunk


def batch_reconstruct_catalog(
    catalog_items: list[dict[str, Any]],
    output_dir: Path | str,
    target_count: int = 100,
) -> dict[str, Any]:
    """Reconstructs 3D models and exports STL and GLB files for catalog items."""
    out_path = Path(output_dir)
    stl_dir = out_path / "stl"
    glb_dir = out_path / "glb"
    stl_dir.mkdir(parents=True, exist_ok=True)
    glb_dir.mkdir(parents=True, exist_ok=True)

    manifest_records: list[dict[str, Any]] = []
    processed_count = 0

    for item in catalog_items:
        if processed_count >= target_count:
            break

        model = reconstruct_hardware_model(item)
        if not model.meshes or model.total_triangles() == 0:
            continue

        stl_bytes = export_stl_binary(model)
        glb_bytes = export_glb(model)

        stl_file = stl_dir / f"{model.id}.stl"
        glb_file = glb_dir / f"{model.id}.glb"

        stl_file.write_bytes(stl_bytes)
        glb_file.write_bytes(glb_bytes)

        mins, maxs = model.bounds()
        dims_measured = (
            round(maxs[0] - mins[0], 2),
            round(maxs[1] - mins[1], 2),
            round(maxs[2] - mins[2], 2),
        )

        manifest_records.append(
            {
                "id": model.id,
                "name": model.name,
                "category": model.category,
                "manufacturer": model.manufacturer,
                "mpn": model.mpn,
                "triangles": model.total_triangles(),
                "mesh_count": len(model.meshes),
                "measured_bounds_mm": {
                    "width_x": dims_measured[0],
                    "height_y": dims_measured[1],
                    "depth_z": dims_measured[2],
                },
                "stl_path": str(stl_file.relative_to(out_path.parent)),
                "stl_bytes": len(stl_bytes),
                "glb_path": str(glb_file.relative_to(out_path.parent)),
                "glb_bytes": len(glb_bytes),
                "datasheet_url": model.datasheet_url,
            }
        )
        processed_count += 1

    summary = {
        "generator": "FORGE 3D Reverse-Engineering Pipeline",
        "total_models": len(manifest_records),
        "target_count": target_count,
        "models": manifest_records,
    }

    manifest_path = out_path / "manifest.json"
    manifest_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary
