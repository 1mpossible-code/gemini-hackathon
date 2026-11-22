import hashlib
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi import FastAPI

from forge_research.engineering_handoff import engineering_bundle, handoff_router
from forge_research.evidence.datasheets import EvidenceBlocked
from forge_research.offline import DEMO_BRIEF, DemoModel
from forge_research.source_research import SourcePolicy, SourceResearch
from forge_research.workflow import run_research


class EngineeringHandoffTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from forge_research.studio import StudioReport
        base = await run_research(DEMO_BRIEF, DemoModel(), mode="offline")
        self.report = StudioReport(**base.model_dump())

    def test_snapshot_is_stable_content_pinned_and_sample_is_not_verified(self):
        first = engineering_bundle(self.report)
        self.assertEqual(first, engineering_bundle(self.report))
        self.assertEqual(first["bundle_sha256"], hashlib.sha256(first["snapshot_json"].encode()).hexdigest())
        snapshot = json.loads(first["snapshot_json"])
        self.assertEqual(snapshot["kind"], "sample")
        self.assertEqual(snapshot["device_spec"]["components"][1]["catalog_id"], self.report.review.selected_parts[1].id)
        self.assertEqual(snapshot["evidence"], [])
        self.assertIsNone(snapshot["research_verification"])
        self.report.brief += " New requirements."
        self.assertNotEqual(first["bundle_sha256"], engineering_bundle(self.report)["bundle_sha256"])

    def test_live_missing_evidence_and_rejected_sources_are_blocked(self):
        self.report.mode = "gemini"
        with self.assertRaisesRegex(EvidenceBlocked, "Missing saved evidence"):
            engineering_bundle(self.report)
        self.report.source_research = SourceResearch(policy=SourcePolicy(), status="needs_review")
        with self.assertRaisesRegex(EvidenceBlocked, "authorship policy"):
            engineering_bundle(self.report)

    def test_live_rechecks_saved_facts_and_preserves_audit(self):
        from forge_research.evidence.datasheets import catalog_evidence
        self.report.mode = "gemini"
        self.report.evidence = [catalog_evidence(p) for p in self.report.review.selected_parts]
        # A stale top-level flag alone must never authorize the handoff.
        for bundle in self.report.evidence:
            bundle.design_ready = True
        with self.assertRaises(EvidenceBlocked):
            engineering_bundle(self.report)
        self.report.source_research = SourceResearch(policy=SourcePolicy(enabled=False), status="skipped")
        with patch("forge_research.engineering_handoff.bundle_from_documents", side_effect=self.report.evidence):
            first = engineering_bundle(self.report)
        snapshot = json.loads(first["snapshot_json"])
        self.assertEqual(snapshot["kind"], "evidence_backed")
        self.assertFalse(snapshot["source_research"]["policy"]["enabled"])
        self.assertEqual(len(snapshot["evidence"]), 2)
        self.assertNotIn("retrieved_at", snapshot["evidence"][0])

    def test_unsupported_research_remains_exploratory_without_invented_spec(self):
        self.report.mode = "gemini"
        self.report.review.status = "unsupported"
        self.report.review.selected_parts = []
        snapshot = json.loads(engineering_bundle(self.report)["snapshot_json"])
        self.assertEqual(snapshot["kind"], "exploratory")
        self.assertIsNone(snapshot["device_spec"])

    async def test_endpoint_only_resolves_saved_run_and_returns_expiry_and_blocking(self):
        app = FastAPI()
        runs = {self.report.research_id: self.report}
        app.include_router(handoff_router(lambda: runs))
        path = f"/api/research/{self.report.research_id}/engineering-handoff"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            good = await client.get(path)
            self.assertEqual(good.status_code, 200)
            self.assertEqual(good.headers["cache-control"], "no-store")
            self.report.evidence_blocked = True
            self.assertEqual((await client.get(path)).status_code, 422)
            self.assertEqual((await client.get(f"/api/research/{uuid4()}/engineering-handoff")).status_code, 404)
            self.assertEqual((await client.post(path, json={"evidence_blocked": False})).status_code, 405)
