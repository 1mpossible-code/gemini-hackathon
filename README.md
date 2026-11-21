# Forge PCB Studio

Forge PCB Studio is a monochrome WebGL PCB design and 3D viewer. The app is in `pcb-studio/` (Vite, React, and react-three-fiber).

The agent swarm and the Gemini research work live on the partner's branch. They are not in this tree.

## Board asset

`assets/kb2040.glb` is a glTF binary of the Adafruit KB2040. `tools/step_to_glb.py` converts one vendor STEP file into that GLB. The script uses the Python standard library. CadQuery is imported only while a conversion runs, from a temporary environment. Details are in [docs/kb2040-asset.md](docs/kb2040-asset.md).
