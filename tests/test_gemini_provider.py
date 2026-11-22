import os
import unittest
from unittest.mock import patch

from forge_research.providers.keys import FIELDS, PROVIDERS, KeyUpdate, integrations_status
from forge_research.providers.llm import live_model


class GeminiProviderTests(unittest.TestCase):
    def test_legacy_nous_configuration_cannot_enable_live_research(self):
        with patch.dict(os.environ, {"NOUS_API_KEY": "legacy-key", "FORGE_LLM_PROVIDER": "nous"}, clear=True):
            self.assertIsNone(live_model())
            status = integrations_status()
            self.assertNotIn("nous", status["providers"])
            self.assertNotIn("nous_api_key", status["fields"])

    def test_gemini_is_selected_even_with_a_legacy_nous_preference(self):
        with patch.dict(os.environ, {"NOUS_API_KEY": "legacy-key", "FORGE_LLM_PROVIDER": "nous", "GEMINI_API_KEY": "test-key", "FORGE_GEMINI_MODEL": "gemini-test"}, clear=True):
            model = live_model()
            self.assertEqual(model.mode, "gemini")
            self.assertEqual(model.adk_model(), "gemini-test")
            self.assertTrue(integrations_status()["providers"]["gemini"]["configured"])

    def test_key_setup_exposes_only_current_providers(self):
        self.assertEqual(set(PROVIDERS), {"gemini", "reducto", "pangram", "modal"})
        self.assertFalse(any("nous" in field for field in FIELDS))
        self.assertNotIn("nous_api_key", KeyUpdate.model_fields)


if __name__ == "__main__":
    unittest.main()
