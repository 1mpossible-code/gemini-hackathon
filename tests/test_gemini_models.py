import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from forge_research.providers import gemini_models


class GeminiModelListTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        gemini_models._cache.clear()

    async def test_missing_key_never_calls_google(self):
        with patch.dict(os.environ, {}, clear=True), patch('httpx.AsyncClient.get', new_callable=AsyncMock) as get:
            self.assertEqual(await gemini_models.list_gemini_models(), {"models": [], "reason": "no-key"})
            get.assert_not_called()

    async def test_pagination_filtering_cache_and_temporary_key(self):
        def response(data):
            return httpx.Response(200, json=data, request=httpx.Request('GET', 'https://generativelanguage.googleapis.com/v1beta/models'))
        pages = [response({"models": [
            {"name": "models/gemini-test", "displayName": "Gemini Test", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-embed", "supportedGenerationMethods": ["embedContent"]},
            {"name": "models/other", "supportedGenerationMethods": ["generateContent"]},
        ], "nextPageToken": "next"}), response({"models": [
            {"name": "models/gemini-fast", "supportedGenerationMethods": ["generateContent"]},
        ]})]
        with patch.dict(os.environ, {"GEMINI_API_KEY": "saved-test-key"}, clear=True), patch('httpx.AsyncClient.get', new_callable=AsyncMock, side_effect=pages) as get:
            result = await gemini_models.list_gemini_models('temporary-test-key')
            self.assertEqual([m['id'] for m in result['models']], ['gemini-fast', 'gemini-test'])
            self.assertEqual(get.call_count, 2)
            self.assertEqual(get.call_args.kwargs['params']['pageToken'], 'next')
            self.assertEqual(get.call_args.kwargs['headers']['x-goog-api-key'], 'temporary-test-key')
            self.assertEqual(os.environ['GEMINI_API_KEY'], 'saved-test-key')
            self.assertEqual(await gemini_models.list_gemini_models('temporary-test-key'), result)
            self.assertEqual(get.call_count, 2)

    async def test_invalid_key_has_actionable_error_and_is_not_cached(self):
        response = httpx.Response(403, request=httpx.Request('GET', 'https://generativelanguage.googleapis.com/v1beta/models'))
        with patch('httpx.AsyncClient.get', new_callable=AsyncMock, return_value=response):
            with self.assertRaises(HTTPException) as error:
                await gemini_models.list_gemini_models('invalid-test-key')
            self.assertEqual(error.exception.status_code, 400)
            self.assertIn('Check your API key', error.exception.detail)
            self.assertFalse(gemini_models._cache)
