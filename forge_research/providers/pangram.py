"""Pangram authorship analysis. Its scores are never used as truth probabilities."""
from __future__ import annotations

import asyncio
import hashlib
import os
import time
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .usage import record_usage

BASE_URL = "https://text.external-api.pangram.com"


class PangramWindow(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    text: str = ""
    label: str
    ai_assistance_score: float = Field(ge=0, le=1)
    confidence: str
    start_index: int = Field(ge=0)
    end_index: int = Field(ge=0)


class AuthorshipScan(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    subject: str
    scope: str
    status: Literal["completed", "unavailable", "skipped", "error"]
    text_sha256: str | None = None
    characters_scanned: int = 0
    truncated: bool = False
    version: str | None = None
    prediction: str | None = None
    fraction_ai: float | None = Field(default=None, ge=0, le=1)
    fraction_ai_assisted: float | None = Field(default=None, ge=0, le=1)
    fraction_human: float | None = Field(default=None, ge=0, le=1)
    windows: list[PangramWindow] = Field(default_factory=list)
    detail: str | None = None


async def analyze_text(text: str, *, subject: str, scope: str,
                       transport: httpx.AsyncBaseTransport | None = None) -> AuthorshipScan:
    key = os.getenv("PANGRAM_API_KEY", "").strip()
    if not key:
        return AuthorshipScan(subject=subject, scope=scope, status="unavailable",
                              detail="Add PANGRAM_API_KEY in Keys to run authorship analysis.")
    if len(text.split()) < 200:
        return AuthorshipScan(subject=subject, scope=scope, status="skipped",
                              detail="Insufficient prose: this workflow requires at least 200 words for authorship analysis.")
    # Report what was actually scanned. Never request a public dashboard link.
    submitted = text[:24_000]
    metadata = dict(subject=subject, scope=scope,
                    text_sha256=hashlib.sha256(submitted.encode()).hexdigest(),
                    characters_scanned=len(submitted), truncated=len(text) > len(submitted))
    started = time.monotonic()
    try:
        async with asyncio.timeout(65), httpx.AsyncClient(timeout=15, transport=transport) as client:
            response = await client.post(f"{BASE_URL}/task", headers={"x-api-key": key},
                                         json={"text": submitted, "public_dashboard_link": False})
            response.raise_for_status()
            task_id = response.json().get("task_id")
            if not isinstance(task_id, str) or not task_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in task_id):
                raise ValueError("Invalid task ID")
            for _ in range(60):
                response = await client.get(f"{BASE_URL}/task/{task_id}", headers={"x-api-key": key})
                response.raise_for_status()
                raw = response.json()
                if raw.get("stage") == "STAGE_FAILED":
                    raise ValueError("Pangram could not analyze this text")
                if raw.get("stage") == "STAGE_SUCCESS":
                    result = AuthorshipScan(
                        **metadata, status="completed", version=raw["version"],
                        prediction=raw["prediction_short"], fraction_ai=raw["fraction_ai"],
                        fraction_ai_assisted=raw["fraction_ai_assisted"], fraction_human=raw["fraction_human"],
                        windows=raw["windows"],
                        detail="AI-authorship classification only; not factual accuracy or a hallucination probability.",
                    )
                    fractions = (result.fraction_ai, result.fraction_ai_assisted, result.fraction_human)
                    if abs(sum(fractions) - 1) > 0.02 or any(w.end_index < w.start_index or w.end_index > len(submitted) for w in result.windows):
                        raise ValueError("Invalid Pangram result")
                    record_usage("pangram", "authorship", duration_ms=int((time.monotonic() - started) * 1000),
                                 characters=len(submitted), detail=subject)
                    return result
                await asyncio.sleep(1)
            raise TimeoutError("Pangram polling deadline")
    except Exception as error:
        record_usage("pangram", "authorship", ok=False, detail=type(error).__name__)
        # Do not echo request headers, submitted text or credentials in errors.
        return AuthorshipScan(**metadata, status="error",
                              detail=f"Pangram analysis unavailable ({type(error).__name__}); no authorship conclusion.")
