#!/usr/bin/env python3
"""FORGE Automated 3D Reverse-Engineering & Reconstruction CLI.

Reconstructs 100+ production 3D models and STL files for top Arduino,
Adafruit, KiCad, Raspberry Pi, SparkFun, and Espressif components directly
from engineering documentation and catalog specifications.

Usage:
    .venv/bin/python tools/reconstruct_models.py [--limit 105] [--output assets/models]
"""

import argparse
import json
import sys
from pathlib import Path

# Add repo root to sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from forge_research.reconstruction import (
    batch_reconstruct_catalog,
    reconstruct_hardware_model,
    export_stl_binary,
    export_glb,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reconstruct 100+ STL and GLB 3D models from catalog documentation."
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=REPO_ROOT / "forge_research" / "catalog_data.json",
        help="Path to catalog_data.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=REPO_ROOT / "assets" / "models",
        help="Output directory for generated STL and GLB files",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=120,
        help="Target number of 3D models to generate (default: 120)",
    )
    parser.add_argument(
        "--single",
        type=str,
        default=None,
        help="Generate a single specific model by ID (e.g. kb2040, arduino-uno-r3)",
    )

    args = parser.parse_args()

    if not args.catalog.exists():
        print(f"Error: Catalog file not found at {args.catalog}", file=sys.stderr)
        return 1

    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    print(f"Loaded {len(catalog)} component specifications from {args.catalog}")

    if args.single:
        item = next((x for x in catalog if x.get("id") == args.single), None)
        if not item:
            print(f"Error: Item '{args.single}' not found in catalog.", file=sys.stderr)
            return 1
        model = reconstruct_hardware_model(item)
        stl_bytes = export_stl_binary(model)
        glb_bytes = export_glb(model)

        args.output.mkdir(parents=True, exist_ok=True)
        stl_path = args.output / f"{model.id}.stl"
        glb_path = args.output / f"{model.id}.glb"
        stl_path.write_bytes(stl_bytes)
        glb_path.write_bytes(glb_bytes)

        print(f"Reconstructed {model.name} ({model.id}):")
        print(f"  Triangles: {model.total_triangles()}, Meshes: {len(model.meshes)}")
        print(f"  STL: {stl_path} ({len(stl_bytes)} bytes)")
        print(f"  GLB: {glb_path} ({len(glb_bytes)} bytes)")
        return 0

    print(f"Batch reconstructing {args.limit}+ 3D models into {args.output}...")
    summary = batch_reconstruct_catalog(
        catalog_items=catalog,
        output_dir=args.output,
        target_count=args.limit,
    )

    total = summary["total_models"]
    print(f"\nSuccessfully reconstructed {total} 3D models and generated {total} STL files!")
    print(f"  STL directory: {args.output / 'stl'}")
    print(f"  GLB directory: {args.output / 'glb'}")
    print(f"  Manifest:      {args.output / 'manifest.json'}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
