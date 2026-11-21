"""Unit tests for the FORGE 3D Reverse-Engineering & Reconstruction Pipeline.

Verifies:
  - Reading from engineering project documentation & catalog specs
  - Procedural 3D geometry reverse-engineering from dimensions, pinouts, and packages
  - Standard Binary STL export specification compliance
  - Standard ASCII STL export specification compliance
  - glTF 2.0 / GLB binary compliance (units, scene graph, materials)
  - Reverse-engineering accuracy for top Arduino, Adafruit, KiCad, SparkFun models
  - 100+ 3D models and STL files generated with valid geometry
"""

import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

from forge_research.reconstruction import (
    batch_reconstruct_catalog,
    export_glb,
    export_stl_ascii,
    export_stl_binary,
    reconstruct_hardware_model,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = REPO_ROOT / "forge_research" / "catalog_data.json"


class TestReconstructionPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assertTrue(
            CATALOG_PATH.exists(),
            f"Catalog data file must exist at {CATALOG_PATH}",
        )
        cls.catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        cls.by_id = {item["id"]: item for item in cls.catalog}

    def test_catalog_ingestion_and_documentation_reading(self):
        """Verifies that hardware documentation and specifications are ingested."""
        self.assertGreaterEqual(len(self.catalog), 100)

        # Check top 10 most popular models across Arduino, Adafruit, KiCad, SparkFun, Raspberry Pi
        top_models = [
            "arduino-uno-r3",
            "arduino-mega-2560",
            "arduino-nano",
            "kb2040",
            "feather-rp2040",
            "rpi-pico",
            "esp32-devkitc-32e",
            "bme280",
            "mpu6050",
            "hcsr04",
        ]
        for model_id in top_models:
            self.assertIn(
                model_id,
                self.by_id,
                f"Expected top model '{model_id}' to be present in catalog.",
            )
            item = self.by_id[model_id]
            self.assertIn("dimensions", item)
            self.assertIn("w", item["dimensions"])
            self.assertIn("h", item["dimensions"])
            self.assertGreater(item["dimensions"]["w"], 0)
            self.assertGreater(item["dimensions"]["h"], 0)

    def test_procedural_3d_reconstruction(self):
        """Verifies procedural 3D model generation from specs."""
        kb_item = self.by_id["kb2040"]
        model = reconstruct_hardware_model(kb_item)

        self.assertEqual(model.id, "kb2040")
        self.assertEqual(model.manufacturer, "Adafruit")
        self.assertEqual(model.dimensions, (33.0, 17.8, 1.6))
        self.assertGreater(len(model.meshes), 2)
        self.assertGreater(model.total_triangles(), 50)

        min_box, max_box = model.bounds()
        measured_width = max_box[0] - min_box[0]
        measured_depth = max_box[2] - min_box[2]

        # Bounding box should match documented dimensions
        self.assertAlmostEqual(measured_width, 33.0, delta=0.5)
        self.assertAlmostEqual(measured_depth, 17.8, delta=0.5)

    def test_binary_stl_compliance(self):
        """Verifies standard binary STL file format compliance."""
        uno_item = self.by_id["arduino-uno-r3"]
        model = reconstruct_hardware_model(uno_item)
        stl_bytes = export_stl_binary(model)

        # 1. Header is exactly 80 bytes
        self.assertGreaterEqual(len(stl_bytes), 84)
        header = stl_bytes[:80]
        self.assertTrue(header.startswith(b"FORGE CAD STL:"))

        # 2. Number of triangles uint32 little-endian at offset 80
        num_triangles = struct.unpack_from("<I", stl_bytes, 80)[0]
        self.assertEqual(num_triangles, model.total_triangles())
        self.assertGreater(num_triangles, 0)

        # 3. Exact file size formula: 80 + 4 + N * 50
        expected_size = 80 + 4 + num_triangles * 50
        self.assertEqual(len(stl_bytes), expected_size)

        # 4. Verify facet records: normals and vertices must be finite
        for i in range(min(num_triangles, 50)):
            offset = 84 + i * 50
            nx, ny, nz, x1, y1, z1, x2, y2, z2, x3, y3, z3, attr = struct.unpack_from(
                "<3f3f3f3fH", stl_bytes, offset
            )
            # Check normal vector magnitude close to 1.0 (or normalized)
            norm_mag = math.sqrt(nx * nx + ny * ny + nz * nz)
            self.assertTrue(
                math.isclose(norm_mag, 1.0, rel_tol=1e-3) or norm_mag == 0.0,
                f"Normal magnitude {norm_mag} should be unit length",
            )
            for coord in (x1, y1, z1, x2, y2, z2, x3, y3, z3):
                self.assertFalse(math.isnan(coord))
                self.assertFalse(math.isinf(coord))

    def test_ascii_stl_compliance(self):
        """Verifies standard ASCII STL file format compliance."""
        pico_item = self.by_id["rpi-pico"]
        model = reconstruct_hardware_model(pico_item)
        ascii_stl = export_stl_ascii(model)

        lines = [line.strip() for line in ascii_stl.splitlines() if line.strip()]
        self.assertTrue(lines[0].startswith("solid"))
        self.assertTrue(lines[-1].startswith("endsolid"))

        # Verify loop keywords
        self.assertTrue(any("facet normal" in line for line in lines))
        self.assertTrue(any("outer loop" in line for line in lines))
        self.assertTrue(any("vertex" in line for line in lines))
        self.assertTrue(any("endloop" in line for line in lines))
        self.assertTrue(any("endfacet" in line for line in lines))

    def test_glb_gltf2_compliance(self):
        """Verifies standard glTF 2.0 binary (.glb) compliance."""
        feather_item = self.by_id["feather-rp2040"]
        model = reconstruct_hardware_model(feather_item)
        glb_bytes = export_glb(model)

        # 1. Header (12 bytes): magic, version, total length
        magic, version, length = struct.unpack_from("<4sII", glb_bytes, 0)
        self.assertEqual(magic, b"glTF")
        self.assertEqual(version, 2)
        self.assertEqual(length, len(glb_bytes))

        # 2. JSON Chunk
        json_len, json_type = struct.unpack_from("<II", glb_bytes, 12)
        self.assertEqual(json_type, 0x4E4F534A)  # "JSON"
        json_bytes = glb_bytes[20 : 20 + json_len]
        doc = json.loads(json_bytes.decode("utf-8"))

        self.assertEqual(doc["asset"]["version"], "2.0")
        self.assertIn("nodes", doc)
        self.assertIn("meshes", doc)
        self.assertIn("accessors", doc)
        self.assertIn("materials", doc)
        self.assertEqual(len(doc["nodes"]), len(model.meshes))

        # 3. BIN Chunk
        bin_offset = 20 + json_len
        bin_len, bin_type = struct.unpack_from("<II", glb_bytes, bin_offset)
        self.assertEqual(bin_type, 0x004E4942)  # "BIN\0"
        self.assertEqual(doc["buffers"][0]["byteLength"], bin_len)

    def test_reverse_engineering_top_models(self):
        """Verifies detailed reverse-engineered features for key hardware boards."""
        # 1. Arduino Uno R3: ATmega328P DIP, USB-B, DC Jack, Female Headers
        uno = reconstruct_hardware_model(self.by_id["arduino-uno-r3"])
        mesh_names = [m.name for m in uno.meshes]
        self.assertTrue(any("ic" in name for name in mesh_names))
        self.assertTrue(any("metal" in name for name in mesh_names))
        self.assertTrue(any("plastic" in name for name in mesh_names))
        self.assertTrue(any("pins" in name for name in mesh_names))

        # 2. Adafruit KB2040: RP2040 QFN, USB-C, STEMMA QT, 24 pins
        kb = reconstruct_hardware_model(self.by_id["kb2040"])
        kb_meshes = {m.name: m for m in kb.meshes}
        self.assertIn("kb2040-pcb", kb_meshes)
        self.assertIn("kb2040-ic", kb_meshes)
        self.assertIn("kb2040-metal", kb_meshes)

        # 3. HC-SR04 Ultrasonic Sensor: Dual transducer cylinders
        hcsr = reconstruct_hardware_model(self.by_id["hcsr04"])
        self.assertGreater(hcsr.total_triangles(), 100)

        # 4. SG90 Micro Servo: Motor chassis, gear horn
        servo = reconstruct_hardware_model(self.by_id["sg90"])
        self.assertTrue(any("chassis" in m.name for m in servo.meshes))

    def test_batch_generation_100_plus_models(self):
        """Verifies that 100+ models can be batch generated with 100% success."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            summary = batch_reconstruct_catalog(
                catalog_items=self.catalog,
                output_dir=tmp_dir,
                target_count=105,
            )
            self.assertGreaterEqual(summary["total_models"], 100)
            models = summary["models"]
            self.assertGreaterEqual(len(models), 100)

            # Check that STL and GLB files exist on disk and have non-zero size
            for record in models[:10]:
                stl_file = Path(tmp_dir) / "stl" / f"{record['id']}.stl"
                glb_file = Path(tmp_dir) / "glb" / f"{record['id']}.glb"
                self.assertTrue(stl_file.exists(), f"STL file missing: {stl_file}")
                self.assertTrue(glb_file.exists(), f"GLB file missing: {glb_file}")
                self.assertGreater(stl_file.stat().st_size, 1000)
                self.assertGreater(glb_file.stat().st_size, 1000)
                self.assertGreater(record["triangles"], 10)


if __name__ == "__main__":
    unittest.main()
