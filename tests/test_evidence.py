import asyncio
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from forge_research.catalog import PARTS
from forge_research.evidence import datasheets
from forge_research.evidence.datasheets import (
    ComponentFact,
    EvidenceRegistry,
    documents_for,
    extract_part_evidence,
    facts_from_extraction,
    merge_facts,
    normalize_unit,
)
from forge_research.providers.reducto import ReductoError

PART = next(p for p in PARTS if p.id == "esp32-devkitc-32e")
SENSOR = next(p for p in PARTS if p.id == "myoware-2-dev-27924")


def cited(value, page):
    return {"value": value, "citations": [{"bbox": {"page": page}, "content": f"p{page} text"}]}


def reducto_result(rec_max=3.6, abs_max=3.6, unit="V"):
    return {
        "job_id": "job-1",
        "usage": {"num_pages": 30},
        "result": {
            "document_revision": cited("v1.4", 1),
            "supply_voltage_recommended": cited({"min": 3.0, "typ": 3.3, "max": rec_max, "unit": unit}, 12),
            "supply_voltage_absolute_max": cited({"min": -0.3, "typ": None, "max": abs_max, "unit": unit}, 11),
            "adc_resolution_bits": cited(12, 20),
            "wireless_interfaces": cited(["Wi-Fi", "BLE"], 2),
            "pins": cited([{"name": "GPIO34"}, {"name": "GPIO35"}], 8),
        },
    }


class UnitTests(unittest.TestCase):
    def test_normalize_units(self):
        self.assertEqual(normalize_unit(3.3, "V"), (3300.0, "mV"))
        self.assertEqual(normalize_unit(250, "uA"), (0.25, "mA"))
        self.assertEqual(normalize_unit(1.2, "cm"), (12.0, "mm"))

    def test_abs_max_kept_separate_from_recommended(self):
        facts, revision = facts_from_extraction(reducto_result()["result"])
        kinds = {f.field: f.kind for f in facts}
        self.assertEqual(kinds["supply_voltage_recommended"], "recommended_operating")
        self.assertEqual(kinds["supply_voltage_absolute_max"], "absolute_maximum")
        rec = next(f for f in facts if f.field == "supply_voltage_recommended")
        self.assertEqual((rec.min, rec.max, rec.unit, rec.page), (3000.0, 3600.0, "mV", 12))
        self.assertEqual(revision, "v1.4")

    def test_unknown_unit_needs_review(self):
        facts, _ = facts_from_extraction(reducto_result(unit="furlongs")["result"])
        rec = next(f for f in facts if f.field == "supply_voltage_recommended")
        self.assertEqual(rec.status, "needs_review")

    def test_merge_corroborates_and_flags_conflicts(self):
        a = ComponentFact(field="supply_voltage_recommended", label="x", kind="recommended_operating", min=3000, max=3600, unit="mV", provenance="datasheet_extraction", status="extracted")
        b = a.model_copy()
        c = a.model_copy(update={"max": 5000})
        merged = merge_facts([[a], [b]])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0].corroborated_by, 1)
        conflicted = merge_facts([[a.model_copy()], [c]])
        self.assertEqual(len(conflicted), 2)
        self.assertTrue(all(f.status == "needs_review" for f in conflicted))
        self.assertEqual(sum(f.primary for f in conflicted), 1)

    def test_every_part_has_a_document_bundle(self):
        for part in PARTS:
            docs = documents_for(part)
            self.assertTrue(docs, part.id)
            self.assertTrue(all(d.url.startswith("https://") for d in docs))
        self.assertGreaterEqual(len(documents_for(PART)), 2)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"FORGE_CACHE_DIR": self.tmp.name, "REDUCTO_API_KEY": "test", "GEMINI_API_KEY": "", "GOOGLE_API_KEY": ""})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_no_key_returns_labeled_catalog_record(self):
        with patch.dict(os.environ, {"REDUCTO_API_KEY": ""}):
            ev = asyncio.run(extract_part_evidence(PART))
        self.assertEqual(ev.provider, "catalog")
        self.assertEqual(ev.status, "catalog_only")

    def test_reads_all_documents_and_caches(self):
        calls = []

        async def fake_fetch(url):
            return f"pdf:{url}".encode()

        async def fake_extract(pdf, **kwargs):
            calls.append(pdf)
            return reducto_result()

        with patch.object(datasheets, "fetch_pdf", fake_fetch), patch.object(datasheets, "extract", fake_extract):
            ev = asyncio.run(extract_part_evidence(PART))
            self.assertEqual(ev.provider, "reducto")
            self.assertEqual(len(ev.documents), len(documents_for(PART)))
            self.assertTrue(all(d.status == "parsed" for d in ev.documents))
            self.assertEqual(len(calls), len(documents_for(PART)))
            rec = next(f for f in ev.facts if f.field == "supply_voltage_recommended")
            self.assertEqual(rec.corroborated_by, len(documents_for(PART)) - 1)
            again = asyncio.run(extract_part_evidence(PART))
        self.assertEqual(len(calls), len(documents_for(PART)), "second read must hit the cache")
        self.assertTrue(again.cached)

    def test_all_documents_fail_falls_back_with_errors(self):
        async def fake_fetch(url):
            return b"pdf"

        async def boom(pdf, **kwargs):
            raise ReductoError("Reducto extract returned HTTP 500.", 500)

        with patch.object(datasheets, "fetch_pdf", fake_fetch), patch.object(datasheets, "extract", boom):
            ev = asyncio.run(extract_part_evidence(SENSOR))
        self.assertEqual(ev.provider, "catalog")
        self.assertIn("HTTP 500", ev.error or "")
        self.assertTrue(any(d.status == "failed" for d in ev.documents))

    def test_registry_prefetches_every_part(self):
        async def fake_fetch(url):
            return url.encode()

        async def fake_extract(pdf, **kwargs):
            return reducto_result()

        async def run():
            registry = EvidenceRegistry()
            queued = registry.prefetch(PARTS)
            self.assertEqual(queued, len(PARTS))
            self.assertEqual(registry.prefetch(PARTS), 0)
            results = [await registry.get(p) for p in PARTS]
            return registry, results

        with patch.object(datasheets, "fetch_pdf", fake_fetch), patch.object(datasheets, "extract", fake_extract):
            registry, results = asyncio.run(run())
        self.assertEqual({r.part_id for r in results}, {p.id for p in PARTS})
        self.assertTrue(all(s != "pending" for s in registry.status().values()))


class RouteTests(unittest.TestCase):
    def test_evidence_routes(self):
        from forge_research.studio import app

        with patch.dict(os.environ, {"REDUCTO_API_KEY": ""}):
            client = TestClient(app)
            index = client.get("/api/evidence").json()
            self.assertFalse(index["reducto_enabled"])
            self.assertIn(PART.id, index["documents"])
            ev = client.get(f"/api/evidence/{PART.id}").json()
            self.assertEqual(ev["part_id"], PART.id)
            self.assertEqual(client.get("/api/evidence/nope").status_code, 404)


if __name__ == "__main__":
    unittest.main()
