import asyncio
import json
import unittest
from struct import unpack_from

from pydantic import ValidationError

from forge_research.geometry import (
    AssemblyParameters,
    GeometryError,
    build_assembly,
    export_glb,
)
from forge_research.offline import DEMO_BRIEF, DemoModel
from forge_research.workflow import run_research


class AssemblyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = asyncio.run(run_research(DEMO_BRIEF, DemoModel(), mode="offline"))

    def test_resolves_wrist_measurement_without_mutating_research(self):
        self.assertIsNone(self.report.requirements.wrist_circumference_mm)
        preview = build_assembly(self.report)
        self.assertEqual(preview.parameters.wrist_circumference_mm, 170)
        self.assertEqual(preview.findings[2].status, "unknown")

        report = self.report.model_copy(deep=True)
        report.requirements.wrist_circumference_mm = 163
        assembly = build_assembly(report)
        self.assertEqual(assembly.parameters.wrist_circumference_mm, 163)
        self.assertEqual(assembly.findings[2].status, "pass")

    def test_edit_regenerates_strap_but_keeps_part_ids(self):
        small = build_assembly(self.report, AssemblyParameters(wrist_circumference_mm=155))
        large = build_assembly(self.report, AssemblyParameters(wrist_circumference_mm=194))
        low = {node.id: node for node in small.nodes}
        high = {node.id: node for node in large.nodes}
        self.assertEqual(low.keys(), high.keys())
        self.assertEqual(low["board"], high["board"])
        self.assertEqual(low["sensor-1"], high["sensor-1"])
        self.assertGreater(high["strap"].geometry.size_mm[2], low["strap"].geometry.size_mm[2])
        self.assertNotEqual(export_glb(small), export_glb(large))

    def test_rejects_invalid_parameters_and_unverified_research(self):
        with self.assertRaises(ValidationError):
            AssemblyParameters(wrist_circumference_mm=80)
        with self.assertRaises(ValidationError):
            AssemblyParameters(clearance_mm=float("nan"))
        report = self.report.model_copy(deep=True)
        report.review.status = "blocked"
        with self.assertRaises(GeometryError):
            build_assembly(report)

    def test_glb_preserves_measures_and_part_identity(self):
        manifest = build_assembly(self.report)
        binary = export_glb(manifest)
        magic, version, total = unpack_from("<4sII", binary)
        self.assertEqual((magic, version, total), (b"glTF", 2, len(binary)))
        json_length, json_type = unpack_from("<I4s", binary, 12)
        self.assertEqual(json_type, b"JSON")
        document = json.loads(binary[20 : 20 + json_length])
        payload_length, payload_type = unpack_from("<I4s", binary, 20 + json_length)
        self.assertEqual(payload_type, b"BIN\0")
        self.assertEqual(payload_length, document["buffers"][0]["byteLength"])
        self.assertEqual(len(binary), 28 + json_length + payload_length)

        nodes = {node["name"]: node for node in document["nodes"]}
        self.assertEqual(len(nodes), len(manifest.nodes))
        board = nodes["board"]
        self.assertEqual(board["extras"]["part_instance_id"], "board")
        self.assertEqual(nodes["board-right-pin-19"]["extras"]["part_instance_id"], "board")
        self.assertEqual(nodes["sensor-ref"]["extras"]["part_instance_id"], "sensor-1")
        position_id = document["meshes"][board["mesh"]]["primitives"][0]["attributes"][
            "POSITION"
        ]
        positions = document["accessors"][position_id]
        self.assertAlmostEqual(positions["max"][0] - positions["min"][0], 27.94 / 1000)
        self.assertAlmostEqual(positions["max"][2] - positions["min"][2], 48.26 / 1000)
