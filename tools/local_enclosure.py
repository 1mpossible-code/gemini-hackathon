"""Local fallback for the Modal enclosure worker: same CadQuery code, this machine's CPU.

Usage: python tools/local_enclosure.py SPEC.json OUT_DIR
Prints one JSON object (the same metadata the Modal endpoint returns, minus files).
Needs cadquery>=2.8; the studio runs it through ``uv run --with cadquery==2.8.0``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tools")]

import step_to_glb  # noqa: E402
from modal_workers import enclosure  # noqa: E402


def main() -> None:
    spec = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    result = enclosure.generate(spec, str(out))
    report = step_to_glb.convert_step(
        out / "enclosure.step", out / "enclosure.glb",
        linear_mm=0.1, angular_rad=0.35, copyright_text=None, license_notice=None, source_url=None,
    )
    result.pop("files", None)
    result["glb"] = {"triangles": report["triangles"], "size_mm": report["size_mm"], "nodes": report["nodes"]}
    result["spec_hash"] = enclosure.spec_hash(spec)
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
