# FORGE 3D Reverse-Engineering & Reconstruction Pipeline

## Overview

The 3D Reverse-Engineering & Reconstruction Pipeline bridges electrical component documentation, datasheet mechanical drawings, and physical 3D prototyping. It programmatically reads dimensional specifications, pin headers, chip packages, port locations, and mounting patterns from catalog documentation (covering Arduino, Adafruit, KiCad, SparkFun, Raspberry Pi, and Espressif) and procedurally generates watertight 3D models.

```text
Component Documentation / Datasheet Specs
        ↓ (Dimensions, Pinouts, Footprints, Mounting Holes)
FORGE Reconstruction Engine (forge_research/reconstruction.py)
        ↓
  ┌───────────────────────┬───────────────────────┬────────────────────────┐
  ▼                       ▼                       ▼                        ▼
Binary & ASCII STL      glTF 2.0 / GLB        Interactive Three.js      Batch Generator
(3D Printing & CAD)     (Web 3D Assets)       (pcb-studio WebGL)        (120+ Models)
```

## Supported Output Formats

### 1. Binary & ASCII STL (`.stl`)
- **Binary STL**: Follows the strict 80-byte header, unsigned 32-bit triangle count $N$, and $N \times 50$-byte facet records (`3f` normal + `3f*3` vertices + `2B` attribute).
- Fully compatible with 3D slicers (Bambu Studio, PrusaSlicer, Cura), FreeCAD, Blender, and KiCad 3D footprint viewers.
- Bounding box and coordinates are in standard engineering millimeters (mm).

### 2. glTF 2.0 Binary (`.glb`)
- Follows the Khronos glTF 2.0 standard in meters (glTF standard SI unit, scaled by 0.001 from mm).
- Structured scene hierarchy with subcomponent node identification (e.g., `arduino-uno-r3-pcb`, `arduino-uno-r3-ic`, `arduino-uno-r3-metal`, `arduino-uno-r3-plastic`, `arduino-uno-r3-pins`).
- PBR Metallic-Roughness materials mapped with realistic dielectric and metallic factors (FR4 solder masks, stamped steel/tin shields, gold/tin pins, black epoxy encapsulant).

### 3. Interactive WebGL / Three.js
- Procedural rendering in `pcb-studio/src/scene/devices.ts` and `forge_research/web/assembly-viewer.js`.
- Real-time raycasting and component inspection.

---

## Reverse-Engineered Features

| Hardware Feature | Geometry Representation | Real-World Hardware Examples |
| :--- | :--- | :--- |
| **PCB Substrates** | Rounded box with exact $W \times D \times T$ dimensions and family solder mask colors | Arduino teal, RPi green, Adafruit black/purple, SparkFun red |
| **Mounting Holes** | Annular rings and drill vias at exact millimeter coordinates | Uno R3 (4 non-rectangular holes), Pico (4-corner symmetric M2.1), Feather (4-corner M2.5) |
| **IC Packages** | DIP-28 socket, QFP/QFN with gull-wing leads, SOT-23/SOIC | ATmega328P DIP, RP2040 QFN-56, ESP32-S3, ATmega2560 |
| **Shielding Cans** | Stamped metal RF shield cans with top chamfer | ESP32-WROOM-32E, ESP32-S3-WROOM-1, Raspberry Pi Pico W |
| **Connectors** | Receptacle shells, chamfered insertion slots, and pins | USB Type-C, Micro-USB, USB Type-B, DC Barrel Jack, JST-PH battery, STEMMA QT / Qwiic |
| **Pin Headers** | 2.54 mm & 1.0 mm pitch male strips, female banks, castellated pads | Arduino shield banks, breadboard header rows, castellated module edges |
| **Electromechanical**| Tactile buttons, quartz crystals, LED lenses, electrolytic cans | Reset/Boot pushbuttons, 16 MHz crystals, power/status LEDs |
| **Sensors & Actuators** | Ultrasonic dual transducers, micro servo motor horns, OLED panels | HC-SR04, SG90 servo, SSD1306 0.96" OLED display |

---

## Top Reverse-Engineered Models

1. **Arduino Uno R3**: ATmega328P DIP socket, USB-B receptacle, DC barrel jack, female header rows, 16 MHz crystal.
2. **Arduino Mega 2560**: ATmega2560 QFP-100, USB-B, DC barrel jack, extended dual-row headers.
3. **Arduino Nano**: Miniaturized 45 × 18 mm outline, ATmega328P, Mini-USB/Type-C, dual 15-pin breadboard headers.
4. **Adafruit KB2040 (SKU 5302)**: Pro Micro RP2040 footprint, USB-C, STEMMA QT JST-SH connector, reset & boot switches.
5. **Adafruit Feather RP2040**: Feather form-factor (50.8 × 22.8 mm), USB-C, JST-PH 2-pin LiPo battery port, feather headers.
6. **Raspberry Pi Pico & Pico W**: 51 × 21 mm outline, RP2040, 4 mounting holes, micro-USB, 40-pin pitch, Wi-Fi metal shield can.
7. **Espressif ESP32-DevKitC-32E**: ESP-WROOM stamped RF shield, dual 19-pin headers, boot & enable pushbuttons, micro-USB.
8. **BME280 Breakout**: Compact temperature, pressure & humidity sensor, 6-pin I2C/SPI header, passive bypass MLCCs.
9. **MPU-6050 Breakout**: 6-axis IMU sensor, QFN package, I2C address selection, 8-pin header.
10. **HC-SR04 Ultrasonic Sensor**: Dual 16mm ultrasonic transducer metal cans, 4-pin header, 4MHz crystal.
11. **SG90 Micro Servo**: Translucent blue chassis, mounting flanges, top gear tower, rotating servo horn.
12. **SSD1306 0.96" OLED**: Glass display panel with pixel area, flex connector PCB, 4-pin I2C header.

---

## CLI Usage

To batch reconstruct 3D models and generate STL and GLB files:

```bash
# Reconstruct 100+ models into assets/models/
.venv/bin/python tools/reconstruct_models.py --limit 120

# Reconstruct a specific component (e.g. Adafruit KB2040)
.venv/bin/python tools/reconstruct_models.py --single kb2040

# Reconstruct an Arduino Uno R3
.venv/bin/python tools/reconstruct_models.py --single arduino-uno-r3
```

Generated assets are placed in:
- `assets/models/stl/<id>.stl` — Ready for 3D printing and CAD import.
- `assets/models/glb/<id>.glb` — Ready for WebGL, Three.js, and browser viewers.
- `assets/models/manifest.json` — Complete index with dimensions, triangle counts, and file sizes.

---

## Automated Verification & Tests

Run the test suite to verify geometry generation, STL binary/ASCII conformance, and GLB validity:

```bash
.venv/bin/python -m unittest tests/test_reconstruction_pipeline.py
```
