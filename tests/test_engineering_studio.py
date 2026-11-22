import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from forge_research.bom import compute_cost_breakdown, format_minor_currency
from forge_research.catalog import PARTS
from forge_research.models import (
    ComponentInstance,
    DeviceSpecification,
    Requirements,
    WiringSpec,
)
from forge_research.procurement import search_part_offers_sync
from forge_research.studio import app, projects
from forge_research.verify import _ObligationSpec, _build_lean_file, verify_design_sync

os.environ.setdefault("FORGE_ENCLOSURE", "off")  # skip the CadQuery enclosure job in fast tests


class EngineeringStudioScenarioTests(unittest.TestCase):
    def setUp(self):
        projects.clear()
        self.addCleanup(projects.clear)
        env = patch.dict(
            os.environ,
            {"GEMINI_API_KEY": "", "GOOGLE_API_KEY": "", "FORGE_GEMINI_MODEL": "", "NOUS_API_KEY": ""},
        )
        env.start()
        self.addCleanup(env.stop)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def create_sample_project(self) -> dict:
        resp = self.client.post("/api/research", json={"mode": "sample"})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertIsNotNone(body["project"])
        return body

    def test_scenario_a_geometry_edit_updates_mesh_without_changing_bom_cost(self):
        initial = self.create_sample_project()["project"]
        pid = initial["project_id"]
        self.assertEqual(initial["revision"], 1)
        self.assertEqual(initial["manifest"]["parameters"]["wrist_circumference_mm"], 170)
        self.assertEqual(initial["cost"]["known_subtotal_usd_cents"], 5370)
        glb_rev1 = self.client.get(initial["glb_url"]).content

        resp = self.client.post(
            f"/api/projects/{pid}/edits",
            json={"base_revision": 1, "wrist_circumference_mm": 190},
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        updated = resp.json()

        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["manifest"]["parameters"]["wrist_circumference_mm"], 190)
        glb_rev2 = self.client.get(updated["glb_url"]).content
        self.assertNotEqual(glb_rev1, glb_rev2)

        findings = {f["check"]: f["status"] for f in updated["manifest"]["findings"]}
        self.assertEqual(findings["enclosure_clearance"], "pass")
        self.assertEqual(findings["board_separation"], "pass")
        self.assertEqual(findings["wrist_size"], "pass")

        self.assertEqual(updated["cost"]["known_subtotal_usd_cents"], 5370)
        self.assertTrue(
            any("hardware BOM unchanged" in d for d in updated["cost"]["deltas_from_previous"])
        )

    def test_scenario_b_budget_edit_and_incomplete_pricing_honesty(self):
        initial = self.create_sample_project()["project"]
        pid = initial["project_id"]

        # Lower budget from $100 to $50 -> exceeded by $3.70, no fabricated cheaper parts
        resp = self.client.post(
            f"/api/projects/{pid}/edits",
            json={"base_revision": 1, "budget_usd_cents": 5000, "budget_exclusive": True},
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        over = resp.json()
        self.assertEqual(over["revision"], 2)
        self.assertEqual(over["cost"]["budget_status"], "exceeded")
        self.assertEqual(over["cost"]["budget_remaining_usd_cents"], -370)
        self.assertEqual(
            [c["catalog_id"] for c in over["device_spec"]["components"]],
            ["esp32-devkitc-32e", "myoware-2-dev-27924"],
        )
        budget_ob = next(
            o for o in over["verification"]["obligations"] if o["id"] == "core_parts_budget"
        )
        self.assertEqual(budget_ob["status"], "failed")
        self.assertIn("ob_core_parts_budget_refuted", budget_ob["lean_theorem"])

        # Raise budget back to $100 and swap to Arduino UNO Rev3 (no curated quote)
        resp2 = self.client.post(
            f"/api/projects/{pid}/edits",
            json={
                "base_revision": 2,
                "budget_usd_cents": 10000,
                "controller_id": "arduino-uno-r3",
            },
        )
        self.assertEqual(resp2.status_code, 200, resp2.text)
        incomplete = resp2.json()
        self.assertTrue(incomplete["cost"]["has_unpriced_items"])
        self.assertIn("arduino-uno-r3", incomplete["cost"]["unpriced_catalog_ids"])
        self.assertEqual(incomplete["cost"]["budget_status"], "incomplete")
        self.assertIsNone(incomplete["cost"]["complete_subtotal_usd_cents"])
        budget_ob2 = next(
            o for o in incomplete["verification"]["obligations"] if o["id"] == "core_parts_budget"
        )
        self.assertEqual(budget_ob2["status"], "unverified")

    def test_scenario_c_invalid_electrical_design_lean_refutation_and_repair(self):
        initial = self.create_sample_project()["project"]
        pid = initial["project_id"]

        # Verify ESP32 ADC2 (GPIO4) is valid under BLE, but fails under Wi-Fi
        ble_adc2 = self.client.post(
            f"/api/projects/{pid}/edits",
            json={"base_revision": 1, "signal_pins": ["GPIO4"], "transport": "ble"},
        ).json()
        gpio_ble = next(
            o for o in ble_adc2["verification"]["obligations"] if o["id"] == "gpio_pin_assignments"
        )
        self.assertEqual(gpio_ble["status"], "verified")

        wifi_adc2 = self.client.post(
            f"/api/projects/{pid}/edits",
            json={"base_revision": 2, "transport": "wifi"},
        ).json()
        gpio_wifi = next(
            o for o in wifi_adc2["verification"]["obligations"] if o["id"] == "gpio_pin_assignments"
        )
        self.assertEqual(gpio_wifi["status"], "failed")
        self.assertIn("ADC2", gpio_wifi["summary"])

        # Inject 5000 mV overvoltage (> 3300 mV ESP32 ADC ceiling) + GPIO0 restricted + GPIO34 LED
        fault = self.client.post(
            f"/api/projects/{pid}/edits",
            json={
                "base_revision": 3,
                "transport": "ble",
                "supply_rail_mv": 5000,
                "signal_pins": ["GPIO0"],
                "status_led_pin": "GPIO34",
            },
        ).json()
        self.assertEqual(fault["revision"], 4)
        self.assertEqual(fault["verification"]["status"], "failed")
        obs = {o["id"]: o for o in fault["verification"]["obligations"]}
        self.assertEqual(obs["adc_input_voltage"]["status"], "failed")
        self.assertIn("¬ (ForgeVerify.adcInputSafe 5000 3300)", obs["adc_input_voltage"]["lean_theorem"])
        self.assertEqual(obs["gpio_pin_assignments"]["status"], "failed")

        # Run bounded repair and confirm reverification matches new revision
        repaired_resp = self.client.post(
            f"/api/projects/{pid}/repair",
            json={"base_revision": 4, "mode": "sample"},
        )
        self.assertEqual(repaired_resp.status_code, 200, repaired_resp.text)
        outcome = repaired_resp.json()
        self.assertTrue(outcome["repaired"])
        self.assertEqual(outcome["actor"], "offline_fixture")
        self.assertEqual(outcome["project"]["revision"], 5)
        self.assertEqual(outcome["project"]["verification"]["revision"], 5)
        self.assertEqual(outcome["project"]["verification"]["failed_count"], 0)
        self.assertIn(
            "ADC input overvoltage safety: FAILED → VERIFIED",
            outcome["diff"]["verification_changes"],
        )

    def test_scenario_d_shopify_procurement_classification_currency_and_live(self):
        initial = self.create_sample_project()["project"]
        pid = initial["project_id"]

        def fake_shop_transport(url, headers, payload):
            self.assertEqual(url, "https://mcp.shop.com/")
            self.assertEqual(headers["MCP-Protocol-Version"], "2026-07-28")
            self.assertEqual(headers["Mcp-Name"], "search_catalog")
            return (
                200,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "isError": False,
                        "structuredContent": {
                            "ucp": {"version": "2026-08-25"},
                            "messages": [
                                {"type": "warning", "content": "Price localized to market."}
                            ],
                            "products": [
                                {
                                    "id": "gid://shopify/p/esp1",
                                    "title": "ESP32-DEVKITC-32E",
                                    "variants": [
                                        {
                                            "id": "gid://shopify/ProductVariant/101",
                                            "price": {"amount": 980, "currency": "USD"},
                                            "availability": {"available": True},
                                            "url": "https://merchant.example/products/esp32-devkitc-32e?variant=101",
                                            "seller": {"name": "Verified Maker Co", "domain": "maker.myshopify.com"},
                                        }
                                    ],
                                },
                                {
                                    "id": "gid://shopify/p/esp2",
                                    "title": "ESP32 Protective Case Enclosure",
                                    "variants": [
                                        {
                                            "id": "gid://shopify/ProductVariant/102",
                                            "price": {"amount": 450, "currency": "USD"},
                                            "availability": {"available": True},
                                            "url": "https://merchant.example/products/case?variant=102",
                                            "seller": {"name": "Case Shop", "domain": "cases.myshopify.com"},
                                        }
                                    ],
                                },
                                {
                                    "id": "gid://shopify/p/esp3",
                                    "title": "ESP32-DEVKITC-32E UK Stock",
                                    "variants": [
                                        {
                                            "id": "gid://shopify/ProductVariant/103",
                                            "price": {"amount": 850, "currency": "GBP"},
                                            "availability": {"available": True},
                                            "url": "https://uk.example/products/esp32?variant=103",
                                            "seller": {"name": "UK Boards", "domain": "uk.myshopify.com"},
                                        }
                                    ],
                                },
                                {
                                    "id": "gid://shopify/p/noise",
                                    "title": "Running Sneakers",
                                    "variants": [
                                        {
                                            "id": "gid://shopify/ProductVariant/999",
                                            "price": {"amount": 12000, "currency": "USD"},
                                            "availability": {"available": True},
                                            "url": "https://shoes.example/p?v=999",
                                            "seller": {"name": "Shoes", "domain": "shoes.myshopify.com"},
                                        }
                                    ],
                                },
                            ],
                        },
                    },
                },
            )

        with patch("forge_research.procurement._default_transport", fake_shop_transport):
            esp_part = next(p for p in PARTS if p.id == "esp32-devkitc-32e")
            res = search_part_offers_sync(esp_part)
            self.assertEqual(res.status, "ok")
            self.assertEqual(res.warnings, ["Price localized to market."])
            self.assertEqual(len(res.offers), 3)  # Sneakers filtered out

            searched = self.client.post(
                f"/api/projects/{pid}/procurement/search",
                json={"catalog_id": "esp32-devkitc-32e"},
            ).json()

        offers = searched["procurement"]["results_by_part"]["esp32-devkitc-32e"]["offers"]
        exact_usd = next(o for o in offers if o["currency"] == "USD" and o["match_kind"] == "exact_match")
        accessory = next(o for o in offers if o["match_kind"] == "variant_or_accessory")
        exact_gbp = next(o for o in offers if o["currency"] == "GBP")

        # Reject selecting an accessory as a BOM unit replacement
        bad_sel = self.client.post(
            f"/api/projects/{pid}/procurement/select",
            json={"base_revision": 1, "instance_id": "board", "offer_id": accessory["offer_id"]},
        )
        self.assertEqual(bad_sel.status_code, 422)

        # Selecting exact USD offer updates BOM subtotal ($9.80 + $43.50 = $53.30)
        good_sel = self.client.post(
            f"/api/projects/{pid}/procurement/select",
            json={"base_revision": 1, "instance_id": "board", "offer_id": exact_usd["offer_id"]},
        )
        self.assertEqual(good_sel.status_code, 200)
        updated_bom = good_sel.json()["cost"]
        self.assertEqual(updated_bom["known_subtotal_usd_cents"], 5330)

        # Selecting GBP offer does NOT mix GBP into USD subtotal (reverts to $10.20 + $43.50 = $53.70)
        gbp_sel = self.client.post(
            f"/api/projects/{pid}/procurement/select",
            json={"base_revision": 2, "instance_id": "board", "offer_id": exact_gbp["offer_id"]},
        ).json()
        self.assertEqual(gbp_sel["cost"]["known_subtotal_usd_cents"], 5370)
        board_line = next(i for i in gbp_sel["cost"]["line_items"] if i["instance_id"] == "board")
        self.assertTrue(any("GBP" in n for n in board_line["notes"]))

        # Currency minor units check (JPY=0, KWD=3, USD=2)
        self.assertEqual(format_minor_currency(8000, "JPY"), "¥8,000")
        self.assertEqual(format_minor_currency(8000, "KWD"), "KWD 8.000")
        self.assertEqual(format_minor_currency(8000, "USD"), "$80.00")

        # Live network smoke test against real https://mcp.shop.com/
        live_res = search_part_offers_sync(esp_part, limit=3)
        self.assertIn(live_res.status, ("ok", "no_results", "error"))
        if live_res.status == "ok":
            self.assertTrue(all(o.url.startswith("https://") for o in live_res.offers))

    def test_scenario_e_rapid_edits_stale_revisions_undo_and_compare(self):
        initial = self.create_sample_project()["project"]
        pid = initial["project_id"]

        r2 = self.client.post(
            f"/api/projects/{pid}/edits",
            json={"base_revision": 1, "wrist_circumference_mm": 180},
        )
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["revision"], 2)

        # Stale base_revision=1 must fail with HTTP 409 without overwriting Rev 2
        stale = self.client.post(
            f"/api/projects/{pid}/edits",
            json={"base_revision": 1, "wrist_circumference_mm": 150},
        )
        self.assertEqual(stale.status_code, 409)

        r3 = self.client.post(
            f"/api/projects/{pid}/edits",
            json={"base_revision": 2, "sensor_quantity": 2},
        )
        self.assertEqual(r3.status_code, 200)
        proj3 = r3.json()
        self.assertEqual(proj3["revision"], 3)
        self.assertEqual(proj3["cost"]["known_subtotal_usd_cents"], 9720)
        self.assertEqual(proj3["cost"]["revision"], 3)
        self.assertEqual(proj3["verification"]["revision"], 3)
        self.assertTrue(
            any(n["id"] == "sensor-2" for n in proj3["manifest"]["nodes"])
        )

        # Compare Rev 1 and Rev 3
        cmp_resp = self.client.get(f"/api/projects/{pid}/compare?from_rev=1&to_rev=3")
        self.assertEqual(cmp_resp.status_code, 200)
        diff = cmp_resp.json()
        self.assertIn("components", diff["changed_fields"])
        self.assertIn("wrist_circumference_mm", diff["changed_fields"])

        # Undo / restore back to Rev 1 -> becomes Rev 4
        restored = self.client.post(
            f"/api/projects/{pid}/restore",
            json={"base_revision": 3, "target_revision": 1},
        )
        self.assertEqual(restored.status_code, 200)
        proj4 = restored.json()
        self.assertEqual(proj4["revision"], 4)
        self.assertEqual(proj4["cost"]["known_subtotal_usd_cents"], 5370)
        self.assertEqual(proj4["manifest"]["parameters"]["wrist_circumference_mm"], 170)

    def test_scenario_f_offline_mode_distinguishes_scripted_and_never_fakes_shop(self):
        body = self.create_sample_project()
        self.assertEqual(body["mode"], "offline")
        self.assertEqual(body["model"], "offline-wristband-fixture")
        proj = body["project"]
        self.assertEqual(proj["mode"], "offline")
        self.assertEqual(proj["procurement"]["source"], "none")
        self.assertEqual(proj["procurement"]["results_by_part"], {})

    def test_lean_kernel_integrity_rejects_sorry_and_separates_infra_errors(self):
        bad_ob = _ObligationSpec(
            id="bad",
            title="Injected sorry",
            category="voltage",
            proposition="sorry",
            inputs={},
            pass_summary="",
            fail_summary="",
        )
        with self.assertRaises(ValueError):
            _build_lean_file([bad_ob])

        snap = {p.id: p for p in PARTS}
        spec = DeviceSpecification(
            requirements=Requirements(
                application="emg_wearable",
                budget_usd_cents=8000,
                budget_exclusive=True,
                transport="ble",
                gestures=["flex"],
                unresolved=[],
            ),
            components=[
                ComponentInstance(instance_id="board", catalog_id="esp32-devkitc-32e", role="controller"),
                ComponentInstance(instance_id="sensor-1", catalog_id="myoware-2-dev-27924", role="emg_sensor"),
            ],
            wiring=WiringSpec(supply_rail_mv=3300, signal_pins=["GPIO34"]),
        )
        cost = compute_cost_breakdown(1, spec, snap)

        # Missing Lean binary yields "error" on checkable items, never "verified" or "failed"
        with patch.dict(os.environ, {"FORGE_LEAN_BIN": "/nonexistent/lean-binary"}):
            rep = verify_design_sync(1, spec, snap, cost, use_cache=False)
            self.assertEqual(rep.status, "error")
            self.assertEqual(rep.verified_count, 0)
            self.assertEqual(rep.failed_count, 0)
            self.assertGreater(rep.error_count, 0)


if __name__ == "__main__":
    unittest.main()
