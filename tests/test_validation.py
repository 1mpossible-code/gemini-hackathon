import asyncio
import copy
import json
import math
import os
import unittest
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import httpx

from forge_research import validation
from forge_research.catalog import PARTS
from forge_research.evidence import datasheets as ds
from forge_research.models import ObligationResult, VerificationReport
from forge_research.offline import DEMO_BRIEF, DemoModel
from forge_research.providers.pangram import AuthorshipScan, analyze_text
from forge_research.validation_html import render_validation_html
from forge_research.workflow import run_research

os.environ.setdefault("FORGE_ENCLOSURE", "off")  # skip the CadQuery enclosure job in fast tests

TEXT = " ".join(["This is a test of generated explanatory prose for component review."] * 24)


def pangram_response():
    return dict(stage="STAGE_SUCCESS", version="test-model", prediction_short="AI",
                fraction_ai=.8, fraction_ai_assisted=.1, fraction_human=.1,
                windows=[dict(text="This is a test", label="AI-Generated", ai_assistance_score=.8,
                              confidence="High", start_index=0, end_index=14),
                         dict(text="generated explanatory prose", label="Human", ai_assistance_score=.2,
                              confidence="Low", start_index=16, end_index=45)])


class PangramAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_api_success_is_private_and_has_no_truth_score(self):
        requests = []
        async def handle(request):
            requests.append(request)
            if request.method == "POST":
                return httpx.Response(200, json={"task_id": "task-1"})
            return httpx.Response(200, json=pangram_response())
        with patch.dict(os.environ, {"PANGRAM_API_KEY": "test-key"}):
            scan = await analyze_text(TEXT, subject="Report", scope="Generated prose", transport=httpx.MockTransport(handle))
        self.assertEqual(scan.status, "completed")
        self.assertEqual(scan.fraction_ai, .8)
        self.assertFalse(json.loads(requests[0].content)["public_dashboard_link"])
        self.assertEqual(requests[1].url.path, "/task/task-1")
        self.assertNotIn("probability_correct", scan.model_dump())

    async def test_missing_key_and_short_prose_do_not_make_a_detector_claim(self):
        with patch.dict(os.environ, {"PANGRAM_API_KEY": ""}):
            self.assertEqual((await analyze_text(TEXT, subject="Report", scope="prose")).status, "unavailable")
        with patch.dict(os.environ, {"PANGRAM_API_KEY": "fake"}):
            self.assertEqual((await analyze_text("A short table", subject="Source", scope="excerpt")).status, "skipped")

    async def test_invalid_response_http_failure_and_task_failure_have_no_score(self):
        for case in ("http", "failed", "nan", "fractions", "range"):
            async def handle(request):
                if case == "http":
                    return httpx.Response(401, json={"error": "private diagnostic"})
                if request.method == "POST":
                    return httpx.Response(200, json={"task_id": "task-1"})
                raw = pangram_response()
                if case == "failed": raw["stage"] = "STAGE_FAILED"
                if case == "nan": raw["windows"][0]["ai_assistance_score"] = "NaN"
                if case == "fractions": raw["fraction_ai"] = .1
                if case == "range": raw["windows"][0]["ai_assistance_score"] = 1.1
                return httpx.Response(200, json=raw)
            with self.subTest(case=case), patch.dict(os.environ, {"PANGRAM_API_KEY": "test-key"}):
                scan = await analyze_text(TEXT, subject="Report", scope="prose", transport=httpx.MockTransport(handle))
                self.assertEqual(scan.status, "error")
                self.assertIsNone(scan.fraction_ai)
                self.assertNotIn("test-key", scan.detail)
                self.assertNotIn("private diagnostic", scan.detail)

    async def test_polling_waits_for_completion(self):
        calls = 0
        async def handle(request):
            nonlocal calls
            if request.method == "POST":
                return httpx.Response(200, json={"task_id": "task-1"})
            calls += 1
            return httpx.Response(200, json=pangram_response() if calls > 1 else {"stage": "STAGE_PROCESSING"})
        with patch.dict(os.environ, {"PANGRAM_API_KEY": "test-key"}), patch("forge_research.providers.pangram.asyncio.sleep", AsyncMock()):
            scan = await analyze_text(TEXT, subject="Report", scope="prose", transport=httpx.MockTransport(handle))
        self.assertEqual(calls, 2)
        self.assertEqual(scan.status, "completed")


class StatisticsTests(unittest.TestCase):
    def test_sample_sd_is_descriptive_and_requires_two_observations(self):
        single = validation.spread("Report", "authorship_score", "index", "index", [.5])
        self.assertIsNone(single.sample_stddev)
        multiple = validation.spread("Report", "authorship_score", "index", "index", [.2, .8])
        self.assertAlmostEqual(multiple.mean, .5)
        self.assertAlmostEqual(multiple.sample_stddev, math.sqrt(.18))
        self.assertIn("not confidence", multiple.interpretation)

    def test_reader_spread_normalizes_units_and_does_not_mix_quantities(self):
        part = PARTS[0]
        bundle = ds.catalog_evidence(part)
        bundle.facts = [ds.ComponentFact(field="supply_voltage_recommended", label="Supply", kind="recommended_operating",
                       min=3000, max=3600, unit="mV", provenance="datasheet_extraction", status="extracted",
                       independent={"min": 3, "max": 3.6, "unit": "V"})]
        stats = validation.reader_spreads([bundle])
        self.assertEqual(len(stats), 2)
        self.assertTrue(all(s.sample_stddev == 0 and s.n == 2 for s in stats))
        self.assertEqual(stats[0].unit, "mV")


class ValidationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.report = await run_research(DEMO_BRIEF, DemoModel(), mode="offline")
        self.part = self.report.review.selected_parts[0]
        self.bundle = ds.catalog_evidence(self.part)
        self.proof = VerificationReport(revision=1, status="verified", verified_count=1, obligations=[
            ObligationResult(id="test", title="Known arithmetic", category="voltage", status="verified", summary="Proved")])

    async def audit(self, ai_fraction=.99, bundle=None, proof=None):
        raw = pangram_response()
        raw.update(fraction_ai=ai_fraction, fraction_ai_assisted=0, fraction_human=1-ai_fraction)
        scan = AuthorshipScan(subject="Report", scope="prose", status="completed", **{k:v for k,v in raw.items() if k in AuthorshipScan.model_fields})
        registry = ds.EvidenceRegistry()
        with patch.object(registry, "get", AsyncMock(return_value=bundle or self.bundle)), \
             patch.object(validation, "verify_design", AsyncMock(return_value=proof or self.proof)) as verify, \
             patch.object(validation, "analyze_text", AsyncMock(return_value=scan)):
            # The verifier is stubbed here; real Lean regression tests cover the kernel.
            from forge_research.project import initial_spec_from_report
            from forge_research.bom import compute_cost_breakdown
            spec, snapshot = initial_spec_from_report(self.report)
            cost = compute_cost_breakdown(1, spec, snapshot)
            result = await validation.validate_report(self.report, registry=registry, parts=[self.part], spec=spec, cost=cost, revision=1)
            verify.assert_awaited_once()
            self.assertFalse(verify.call_args.kwargs["use_cache"])
        return result

    async def test_human_label_cannot_rescue_unverified_source(self):
        report = await self.audit(ai_fraction=0)
        self.assertEqual(report.status, "needs_review")
        self.assertIsNone(report.probability_correct)
        self.assertIsNone(report.confidence_interval)
        self.assertTrue(report.reasons)

    async def test_high_ai_score_does_not_refute_a_proved_claim(self):
        bundle = copy.deepcopy(self.bundle)
        bundle.design_ready = True
        bundle.blocking_reasons = []
        from forge_research.providers.datasheet_review import IndependentRead
        bundle.documents = [ds.SourceDocument(url=ds.documents_for(self.part)[0].url, sha256="a"*64,
            independent_read=IndependentRead(manufacturer=self.part.manufacturer, part_number=self.part.sku, revision="1",
             identity_matches=True, identity_page=1, identity_quote="SKU", identity_reason="Exact", facts=[]))]
        report = await self.audit(ai_fraction=.99, bundle=bundle)
        self.assertEqual(report.status, "checked")
        self.assertEqual(report.proof.status, "verified")
        self.assertIsNone(report.probability_correct)
        broken = self.proof.model_copy(update={"status": "failed", "failed_count": 1, "verified_count": 0})
        report = await self.audit(ai_fraction=0, bundle=bundle, proof=broken)
        self.assertEqual(report.status, "needs_review")

    async def test_export_escapes_untrusted_text_and_includes_limitations(self):
        report = await self.audit()
        report.reasons.append('<script>alert("x")</script>')
        html = render_validation_html(report)
        self.assertNotIn('<script>alert', html)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("does not certify factual truth", html)
        self.assertIn(str(report.validation_id), html)
        self.assertIn("Sample SD", html)


class ValidationRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_button_endpoints_use_saved_run_and_export_both_formats(self):
        from forge_research import studio
        # Provider credentials are disabled; this is a genuine offline audit,
        # never a billable detector call or a claim that all checks succeeded.
        with patch.dict(os.environ, {"PANGRAM_API_KEY": "", "REDUCTO_API_KEY": "", "GEMINI_API_KEY": "", "GOOGLE_API_KEY": "", "NOUS_API_KEY": ""}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=studio.app), base_url="http://test") as client:
                research = await client.post("/api/research", json={"mode": "sample"})
                self.assertEqual(research.status_code, 200, research.text)
                body = research.json()
                result = await client.post(f'/api/research/{body["research_id"]}/validate')
                self.assertEqual(result.status_code, 200, result.text)
                audit = result.json()
                self.assertEqual(audit["mode"], "offline")
                self.assertIsNone(audit["probability_correct"])
                self.assertEqual(audit["authorship"][0]["status"], "unavailable")
                audit_id = audit["validation_id"]
                html = await client.get(f"/api/validations/{audit_id}/report.html")
                self.assertEqual(html.status_code, 200)
                self.assertIn("attachment;", html.headers["content-disposition"])
                self.assertIn("does not certify factual truth", html.text)
                exported = await client.get(f"/api/validations/{audit_id}")
                self.assertEqual(exported.json()["input_sha256"], audit["input_sha256"])
                project = body["project"]
                self.assertIsNotNone(project)
                stale = await client.post(f'/api/projects/{project["project_id"]}/validate', json={"base_revision": 999})
                self.assertEqual(stale.status_code, 409)
                fresh = await client.post(f'/api/projects/{project["project_id"]}/validate', json={"base_revision": project["revision"]})
                self.assertEqual(fresh.status_code, 200, fresh.text)
                self.assertEqual(fresh.json()["revision"], project["revision"])
