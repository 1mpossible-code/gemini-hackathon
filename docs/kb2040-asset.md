# KB2040 vendor asset (Adafruit SKU 5302)

`assets/kb2040.glb` is a glTF binary made from Adafruit's STEP model of the KB2040, product id 5302. `tools/step_to_glb.py` is the converter. It is a pilot for one vendor file.

## Source

| Fact | Value |
| --- | --- |
| Product | [Adafruit KB2040, product 5302](https://www.adafruit.com/product/5302) |
| CAD directory | [Adafruit_CAD_Parts/5302 KB2040](https://github.com/adafruit/Adafruit_CAD_Parts/tree/main/5302%20KB2040) |
| File converted | `5302 KB2040.step` on `main` |
| Bytes downloaded | `https://raw.githubusercontent.com/adafruit/Adafruit_CAD_Parts/main/5302%20KB2040/5302%20KB2040.step` |
| SHA-256 | `bc990ea632850b47e18d6c8fcf9ffe5ca101bacc450d628d4d366b0a7890ae57` |
| Git blob | `47c6238e2abdda5c107a530c4c3d58af4ff57652` |
| Commit that added the file | [`120f15905f7b95f2828f5b7bfb947aec25400b5f`](https://github.com/adafruit/Adafruit_CAD_Parts/commit/120f15905f7b95f2828f5b7bfb947aec25400b5f) (`KB2040 added`) |
| STEP `FILE_NAME` | `/Users/purplemac/Dropbox/3D/Products/KB2040/CAD/Adafruit KB2040 v2.step` |
| STEP timestamp | `2021-12-06T15:46:22-05:00` |
| Preprocessor | ST-DEVELOPER v18.1 |
| Originating system | Autodesk Translation Framework v10.10.0.1391 |
| Schema | `AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }` |

`FILE_DESCRIPTION`, author, organization, and authorisation in the STEP header are empty. The assembly name inside the file is `Adafruit KB2040 v2`. The directory name is the SKU. Nothing in the header adds a later revision letter.

The assigned 3D length unit is millimetre: `SI_UNIT(.MILLI.,.METRE.)` on the geometric context (`#43375`). A bare metre unit exists (`#43376`) and is not the unit assigned to that context. The file's own uncertainty is `LENGTH_MEASURE(0.01)` millimetres, described as the maximum model-space distance between entities at asserted connectivities. That is the exporter's statement, not a measurement made here.

The STL, 3MF, Fusion, and GIF files in the same directory were not used.

## License

The STEP header has no copyright or license text. The notice published with the file is the repository [`LICENSE`](https://github.com/adafruit/Adafruit_CAD_Parts/blob/main/LICENSE):

- SHA-256 `f60436644e066301d4c2e8f1f0674a157b1f60e4fd5586717b99dde255cc18cd`
- Git blob `19a9cd8546f62f1fe25919da52882cb67c52dbba`

The GLB is a derivative of that model. `asset.copyright` is `Copyright (c) 2016 Adafruit Industries`. `asset.extras.licenseNotice` is the LICENSE file, unchanged. The same text is copied here:

```text
MIT License

Copyright (c) 2016 Adafruit Industries

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## What was converted

CadQuery `Assembly.importStep` reads the STEP document with names and colors. Open CASCADE scales a declared length unit to millimetres. The tool then writes glTF 2.0 coordinates in metres and rotates the Z-up STEP frame onto glTF's Y-up frame:

```text
(x, y, z) millimetres, Z-up  ->  (x, z, -y) metres, Y-up
```

glTF does not store a unit enum. Metres are the unit in the [glTF 2.0 coordinate system](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units). `asset.extras.units` is `m` so the choice is visible in the file. A position of about `0.033` is the board length, not `33`.

Node names are the XCAF names CadQuery returned. They match the STEP occurrence names (`NEXT_ASSEMBLY_USAGE_OCCURRENCE`), not the `PRODUCT` strings. The scene root is `Adafruit KB2040 v2`. Its only child is `PCB Component`, which holds the solids:

`Board:1`, `_0805MP:C6`, `_0805MP:C8`, `SOT23-5:U2`, `BTN_KMR2_4.6X2.8:SW2`, `BTN_KMR2_4.6X2.8:SW3`, `_0402NO:R11`, `_0402NO:R5`, `_0402NO:C9`, `_0402NO:R9`, `_0402NO:C7`, `_0402NO:C11`, `_0402NO:C13`, `_0402NO:C14`, `_0402NO:C16`, `_0402NO:C17`, `_0402NO:C19`, `_0402NO:C20`, `_0402NO:R6`, `_0402NO:R1`, `_0402NO:R2`, `_0402NO:R3`, `_0402NO:R4`, `_0402NO:R10`, `_0402NO:R12`, `_0402NO:R7`, `SK6805_1515:LED1`, `SOD-323F:D3`, `SOD-323F:D1`, `USON8_4X4:U5`, `_0603MP:C10`, `_0603MP:C12`, `QFN56_7MM_REDUCEDEPAD:IC2`, `CRYSTAL_2.5X2:Y1`, `0603-NO:C15`, `USB_C_CUSB31-CFM2AX-01-X:X6`, `0805-NO:R8`, `JST_SH4_SKINNY:CONN1`, `CHIPLED_0603_NOOUTLINE:D2`.

The STEP file also contains these `PRODUCT` names, which were not copied onto the nodes: `Adafruit KB2040`, `Board`, `10µF` (stored as `10\X\B5F`), `AP2112K-3.3`, `KMR2`, `10K`, `WS2812B_SK6805_1515`, `NSR0320`, `8MB QSPI Flash`, `1uF`, `1uF_1`, `RP2040_QFN56`, `12MHZ`, `USB TYPE C`, `FUSE`, `STEMMA_I2C_QTSKINNY`, `GREEN`.

Colors present on an assembly node are stored as base colors. The tool names them from the 8-bit channels, for example `step-color-120-110-70` on `Board:1`. Twenty-two nodes had no node color (`_0402NO:*`, `SK6805_1515:LED1`, `CHIPLED_0603_NOOUTLINE:D2`). Those use a material named `uncolored`, RGB `(0.62, 0.62, 0.64)`. That color is not in the STEP file. Metallic factor `0` and roughness `0.55` are also tool defaults. Per-face colors were not copied.

Identical local meshes are shared. The file has 39 solids and 15 meshes. `_0805MP:C6`, `_0805MP:C8`, and `0805-NO:R8` are one mesh. A shared mesh means the tessellation matched. It does not mean the components are the same part. The node names stay distinct.

## Checked-in GLB

| Fact | Value |
| --- | --- |
| Path | `assets/kb2040.glb` |
| SHA-256 | `70cdd37efe708404575b2d9dabf3857e93f3902ed70158765e0e6c09a44d2cf4` |
| Size | 858032 bytes |
| Generator | `forge/tools/step_to_glb.py` |
| Triangles | 31518 |
| Nodes / meshes | 41 / 15 |
| Linear deflection | 0.15 mm, absolute |
| Angular deflection | 0.4 rad |

CadQuery `Shape.tessellate` uses a relative deflection. This tool meshes with `BRepMesh_IncrementalMesh` and `relative=False`, so 0.15 is millimetres.

The converter compares the GLB world bounds with the STEP compound bounds after the axis map. This run's maximum corner delta was 0.0000 mm at four decimal places. The allowed delta is twice the linear deflection (0.30 mm). A pass means the placed mesh envelope matches the solid envelope. It does not mean every curved face is within 0.15 mm of a drawing.

## Measured envelopes

STEP compound bounds, Z-up, millimetres:

| Axis | Min | Max | Size |
| --- | --- | --- | --- |
| X | -1.1529 | 33.0200 | 34.1729 |
| Y | 0.0000 | 17.7800 | 17.7800 |
| Z | 0.0000 | 4.7700 | 4.7700 |

The same corners in the GLB, Y-up, metres: minimum `(-0.001153, 0.000000, -0.017780)`, maximum `(0.033020, 0.004770, 0.000000)`. The assembly is 34.1729 mm by 4.7700 mm by 17.7800 mm in glTF X, Y, Z. Y is up. The board lies on XZ and extends toward -Z because STEP +Y becomes glTF -Z. The origin is the STEP origin. It is not labeled as a pin.

Node mesh bounds after the same transform:

| Node | Size (mm, glTF X × Y × Z) | What the bounds show |
| --- | --- | --- |
| `Board:1` | 33.020 × 1.570 × 17.780 | Occupies X 0…33.020, Y 0…1.570, Z -17.780…0. This is the 33.02 mm by 17.78 mm outline and a 1.57 mm thickness. |
| `USB_C_CUSB31-CFM2AX-01-X:X6` | 7.900 × 4.200 × 8.940 | Reaches the assembly's minimum X (-1.1529 mm) and maximum Y (4.770 mm). |
| `QFN56_7MM_REDUCEDEPAD:IC2` | 7.000 × 1.000 × 7.000 | 7 mm in the board plane and 1 mm tall, with its base at Y = 1.570 mm. |
| `JST_SH4_SKINNY:CONN1` | 4.950 × 2.960 × 6.000 | Extends to Y = 4.530 mm, below the USB node's top. |

`33.02 / 25.4 = 1.300` inches and `17.78 / 25.4 = 0.700` inches. Those two board axes match the product page's "1.3 in × 0.7 in". The page also lists product dimensions `35.0 mm × 17.8 mm × 4.9 mm / 1.4 in × 0.7 in × 0.2 in`. `1.4 in` is 35.56 mm, not 35.0 mm. The STEP envelope is 34.17 mm × 17.78 mm × 4.77 mm, and the board solid is 33.02 mm × 17.78 mm × 1.57 mm. The catalog triple was not confirmed. These bounds are not a fit clearance.

Part origins for the components sit at STEP Z = 1.57 mm, which is the top of `Board:1`. That is consistent with parts on that face. It was not checked by sectioning the board.

No node name identifies a pin header.

## What this file cannot tell you

- Which pad is pin 1, or which GPIO, power, or USB signal a pad carries. Occurrence names include reference designators. They are not a pin map.
- Which `PRODUCT` string belongs to which node. Both sets of names are in the STEP file. This pilot did not walk the STEP relationship graph to join them. Do not treat `QFN56_7MM_REDUCEDEPAD:IC2` as a datasheet citation of the RP2040, even though a product string `RP2040_QFN56` is also in the file.
- The USB receptacle opening, the castellated-pad origins, or the connector mating face. Those were not measured against a fabrication drawing.
- Whether a body is a simplified stand-in. Several 0402 occurrences share one mesh. The QFN height of 1.00 mm is the mesh envelope of that solid.
- Soldermask or metal. `Board:1` is display color `(0.471, 0.431, 0.275)`, an olive color. That is not a measurement of a pink PCB. Missing node colors were replaced by `uncolored`.
- The Eagle board, the pinout drawing, and the RP2040 datasheet. None of them were inputs.
- A manufacturing tolerance. The STEP uncertainty text and the 0.15 mm mesh deflection are separate from a fabrication allowance.
- A fit against an enclosure. The catalog 35.0 mm and 4.9 mm figures disagree with this STEP.

## Reproduce

CadQuery stays in a temporary environment. Do not add it to the project dependencies or the lockfile. The checked-in GLB was produced with CPython 3.12.13, CadQuery 2.8.0, and cadquery-ocp 7.9.3.1.1.

```bash
uv venv /tmp/forge-step-to-glb --python 3.12
uv pip install --python /tmp/forge-step-to-glb/bin/python cadquery
mkdir -p /tmp/kb2040-src
curl -fsSL -o "/tmp/kb2040-src/5302 KB2040.step" \
  "https://raw.githubusercontent.com/adafruit/Adafruit_CAD_Parts/main/5302%20KB2040/5302%20KB2040.step"
curl -fsSL -o /tmp/kb2040-src/LICENSE \
  "https://raw.githubusercontent.com/adafruit/Adafruit_CAD_Parts/main/LICENSE"
/tmp/forge-step-to-glb/bin/python tools/step_to_glb.py \
  "/tmp/kb2040-src/5302 KB2040.step" \
  assets/kb2040.glb \
  --copyright "Copyright (c) 2016 Adafruit Industries" \
  --license-notice-file /tmp/kb2040-src/LICENSE \
  --source-url "https://github.com/adafruit/Adafruit_CAD_Parts/blob/120f15905f7b95f2828f5b7bfb947aec25400b5f/5302%20KB2040/5302%20KB2040.step"
```

Confirm the download before trusting a new GLB:

```bash
sha256sum "/tmp/kb2040-src/5302 KB2040.step" /tmp/kb2040-src/LICENSE
```

Inspection does not import CadQuery:

```bash
python3 tools/step_to_glb.py --inspect assets/kb2040.glb
```

The converter exits with an error if the GLB world bounds miss the STEP bounds by more than twice the linear deflection. A STEP file that does not declare a length unit is read as millimetres, which is CadQuery's fallback. This KB2040 file does declare millimetres. If `importStep` reports that the file has no assembly, the tool writes one node from the compound shape and names it from the file name.
