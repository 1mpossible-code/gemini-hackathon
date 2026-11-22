"""List generation models for the supplied Gemini credential without saving it."""
from __future__ import annotations

import asyncio
import hashlib
import os
import time

import httpx
from fastapi import HTTPException

_cache: dict[str, tuple[float, list[dict[str, str]]]] = {}


async def list_gemini_models(api_key: str | None = None) -> dict:
    key = (api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip()
    if not key:
        return {"models": [], "reason": "no-key"}
    identity = hashlib.sha256(key.encode()).hexdigest()
    hit = _cache.get(identity)
    if hit and hit[0] > time.monotonic():
        return {"models": hit[1]}
    models = {}
    try:
        async with asyncio.timeout(10), httpx.AsyncClient(timeout=8) as client:
            token = ""
            for _ in range(10):
                response = await client.get(
                    "https://generativelanguage.googleapis.com/v1beta/models",
                    headers={"x-goog-api-key": key},
                    params={"pageSize": 100, **({"pageToken": token} if token else {})},
                )
                if response.status_code in (400, 401, 403):
                    raise HTTPException(400, "Gemini could not list models. Check your API key and its permissions.")
                response.raise_for_status()
                data = response.json()
                for model in data.get("models", []):
                    name = model.get("name", "").removeprefix("models/")
                    if name.startswith("gemini-") and "generateContent" in model.get("supportedGenerationMethods", []):
                        models[name] = {"id": name, "label": model.get("displayName") or name}
                token = data.get("nextPageToken", "")
                if not token:
                    break
    except (httpx.HTTPError, TimeoutError, ValueError) as error:
        raise HTTPException(502, "Model list unavailable. Try loading models again.") from error
    result = sorted(models.values(), key=lambda model: model["id"])
    if len(_cache) >= 32:
        _cache.pop(next(iter(_cache)))
    _cache[identity] = (time.monotonic() + 300, result)
    return {"models": result}
