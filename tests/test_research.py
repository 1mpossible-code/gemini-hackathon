import json
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from unittest.mock import patch

from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.adk.models.google_llm import Gemini
from google.genai.errors import APIError

from forge_research.catalog import PARTS, ResearchError, review_proposal
from forge_research.models import Proposal, Requirements
from forge_research.offline import DEMO_BRIEF, DemoModel
from forge_research.workflow import run_research


def text_part(**payload):
    return {"text": json.dumps(payload)}


def tool_call(name, **args):
    return {"functionCall": {"name": name, "args": args}}


def requirements_part(application="emg_wearable"):
    return text_part(
        application=application,
        budget_usd_cents=8_000,
        budget_exclusive=True,
        transport="ble",
        gestures=["flex"],
        unresolved=[],
    )


def response_part(controller_id="esp32-devkitc-32e", sensor_id="myoware-2-dev-27924"):
    return tool_call(
        "set_model_response",
        controller_id=controller_id,
        sensor_id=sensor_id,
        rationale="Use catalog evidence.",
    )


@contextmanager
def gemini_stub(responses, *, provider_error=None):
    """Serve scripted Gemini wire responses without any real credentials."""
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            status = 200
            if provider_error is not None:
                status = provider_error["code"]
                payload = {"error": provider_error}
            elif len(requests) > len(responses):
                status = 400
                payload = {"error": {"code": status, "message": "Unexpected fixture call."}}
            else:
                parts = responses[len(requests) - 1]
                payload = {
                    "candidates": [
                        {
                            "content": {"role": "model", "parts": parts},
                            "finishReason": "STOP",
                        }
                    ],
                    "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1},
                }
            output = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(output)))
            self.end_headers()
            self.wfile.write(output)

        def log_message(self, *args):
            return

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        )
        thread.start()
        model = Gemini(
            model="gemini-forge-test",
            base_url=f"http://127.0.0.1:{server.server_port}/",
            client_kwargs={"api_key": "local-fixture", "enterprise": False},
        )
        try:
            with patch.dict(
                "os.environ",
                {"GOOGLE_GENAI_USE_ENTERPRISE": "false", "GOOGLE_GENAI_USE_VERTEXAI": "false"},
            ):
                yield model, requests
        finally:
            server.shutdown()
            thread.join(timeout=1)


class ResearchWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_offline_run_exercises_real_tools_and_agent_handoffs(self):
        report = await run_research(DEMO_BRIEF, DemoModel(), mode="offline")

        self.assertEqual(report.mode, "offline")
        self.assertIsNone(report.requirements.wrist_circumference_mm)
        self.assertEqual(report.requirements.budget_usd_cents, 10_000)
        self.assertEqual(report.requirements.transport, "ble")
        self.assertEqual(report.review.status, "candidate")
        self.assertEqual(report.review.core_subtotal_usd_cents, 5370)
        self.assertEqual(
            [(event.agent, event.event) for event in report.trace],
            [
                ("requirements", "completed"),
                ("sourcing", "catalog_lookup"),
                ("sourcing", "catalog_lookup"),
                ("sourcing", "completed"),
                ("reviewer", "completed"),
            ],
        )
        self.assertEqual(
            set(report.catalog_snapshot),
            {part_id for event in report.trace for part_id in event.part_ids},
        )

    async def test_gemini_adapter_passes_tool_evidence_and_blocked_findings(self):
        for controller_id, status, transport in (
            ("esp32-devkitc-32e", "candidate", "pass"),
            ("arduino-uno-r3", "blocked", "fail"),
        ):
            with (
                self.subTest(controller=controller_id),
                gemini_stub(
                    [
                        [requirements_part()],
                        [
                            tool_call("lookup_parts", role="controller"),
                            tool_call("lookup_parts", role="emg_sensor"),
                        ],
                        [response_part(controller_id=controller_id)],
                        [text_part(next_steps=["Verify hardware before ordering."])],
                    ]
                ) as (model, requests),
            ):
                report = await run_research(DEMO_BRIEF, model, mode="gemini")
                self.assertEqual(report.mode, "gemini")
                self.assertEqual(report.review.status, status)
                checks = {finding.check: finding.status for finding in report.review.findings}
                self.assertEqual(checks["transport"], transport)
                self.assertEqual(len(requests), 4)
                self.assertEqual(
                    requests[0]["generationConfig"]["responseMimeType"], "application/json"
                )
                responses = [
                    part["functionResponse"]
                    for content in requests[2]["contents"]
                    for part in content["parts"]
                    if "functionResponse" in part
                ]
                self.assertEqual({item["name"] for item in responses}, {"lookup_parts"})
                self.assertIn(controller_id, json.dumps(responses))
                self.assertIn("nominal_sensor_supply", json.dumps(requests[3]))

    async def test_gemini_adapter_accepts_unsupported_briefs_without_catalog_calls(self):
        with gemini_stub(
            [
                [requirements_part(application="unsupported")],
                [response_part(controller_id=None, sensor_id=None)],
                [text_part(next_steps=["Try a brief about an EMG wearable."])],
            ]
        ) as (model, requests):
            report = await run_research("A motorized garden sprinkler.", model, mode="gemini")
            self.assertEqual(report.review.status, "unsupported")
            self.assertEqual(report.catalog_snapshot, {})
            self.assertEqual(len(requests), 3)

    async def test_gemini_adapter_rejects_unseen_part_before_reviewer(self):
        with gemini_stub(
            [
                [requirements_part()],
                [tool_call("lookup_parts", role="controller")],
                [response_part()],
            ]
        ) as (model, requests):
            with self.assertRaisesRegex(ResearchError, "without matching catalog evidence"):
                await run_research(DEMO_BRIEF, model, mode="gemini")
            self.assertEqual(len(requests), 3)

    async def test_gemini_adapter_requires_lookups_for_unavailable_parts(self):
        with gemini_stub(
            [
                [requirements_part()],
                [response_part(controller_id=None, sensor_id=None)],
            ]
        ) as (model, requests):
            with self.assertRaisesRegex(ResearchError, "did not look up both"):
                await run_research(DEMO_BRIEF, model, mode="gemini")
            self.assertEqual(len(requests), 2)

    async def test_gemini_adapter_reports_partial_selection_after_both_lookups(self):
        with gemini_stub(
            [
                [requirements_part()],
                [
                    tool_call("lookup_parts", role="controller"),
                    tool_call("lookup_parts", role="emg_sensor"),
                ],
                [response_part(sensor_id=None)],
                [text_part(next_steps=["Find a sensor matching the remaining requirement."])],
            ]
        ) as (model, requests):
            report = await run_research(DEMO_BRIEF, model, mode="gemini")
            self.assertEqual(report.review.status, "blocked")
            self.assertEqual(report.review.findings[0].check, "core_parts")
            self.assertIsNone(report.proposal.sensor_id)
            self.assertEqual(len(requests), 4)

    async def test_gemini_adapter_preserves_provider_error(self):
        with gemini_stub(
            [],
            provider_error={
                "code": 400,
                "status": "INVALID_ARGUMENT",
                "message": "Fixture credential was rejected.",
            },
        ) as (model, requests):
            with self.assertRaises(APIError) as raised:
                await run_research(DEMO_BRIEF, model, mode="gemini")
            self.assertEqual(raised.exception.code, 400)
            self.assertEqual(len(requests), 1)

    async def test_gemini_adapter_enforces_model_call_limit(self):
        repeated_lookups = [[tool_call("lookup_parts", role="controller")]] * 10
        with gemini_stub([[requirements_part()], *repeated_lookups]) as (model, requests):
            with self.assertRaises(LlmCallsLimitExceededError):
                await run_research(DEMO_BRIEF, model, mode="gemini")
            self.assertEqual(len(requests), 10)


class CatalogReviewTests(unittest.TestCase):
    def setUp(self):
        self.requirements = Requirements(
            application="emg_wearable",
            budget_usd_cents=5370,
            budget_exclusive=True,
            transport="ble",
            gestures=["flex"],
            unresolved=[],
        )
        self.proposal = Proposal(
            controller_id="esp32-devkitc-32e",
            sensor_id="myoware-2-dev-27924",
            rationale="Use an analog input and onboard radio.",
        )
        self.evidence = {part.id: part for part in PARTS}

    def test_rejects_a_real_catalog_id_without_run_evidence(self):
        del self.evidence["esp32-devkitc-32e"]
        with self.assertRaisesRegex(ResearchError, "without matching catalog evidence"):
            review_proposal(self.requirements, self.proposal, self.evidence)

    def test_alternate_board_without_ble_is_blocked(self):
        self.proposal.controller_id = "arduino-uno-r3"
        review = review_proposal(self.requirements, self.proposal, self.evidence)
        self.assertEqual(review.status, "blocked")
        self.assertIsNone(review.core_subtotal_usd_cents)
        findings = {finding.check: finding.status for finding in review.findings}
        self.assertEqual(findings["transport"], "fail")
        self.assertEqual(findings["core_parts_budget"], "unknown")

    def test_exclusive_budget_rejects_equal_subtotal(self):
        review = review_proposal(self.requirements, self.proposal, self.evidence)
        self.assertEqual(review.status, "blocked")
        self.requirements.budget_exclusive = False
        review = review_proposal(self.requirements, self.proposal, self.evidence)
        self.assertEqual(review.status, "candidate")
