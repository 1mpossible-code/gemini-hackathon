"""Reducto datasheet extraction adapter.

Reducto parses a PDF (tables, pinouts, drawings) and fills a JSON schema with
citations. FORGE stores the result as typed evidence and checks every number
itself; the parser output is never accepted as a validated design fact.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

from .usage import record_usage

DEFAULT_BASE_URL = "https://platform.reducto.ai"
MAX_PDF_BYTES = 30 * 1024 * 1024


class ReductoError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def reducto_api_key() -> str | None:
    key = os.getenv("REDUCTO_API_KEY", "").strip()
    return key or None


def _base_url() -> str:
    return (os.getenv("REDUCTO_BASE_URL", "").strip() or DEFAULT_BASE_URL).rstrip("/")


async def fetch_pdf(url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> bytes:
    """Download a datasheet PDF from a public http(s) URL with a size cap."""
    if not url.startswith(("https://", "http://")):
        raise ReductoError("Datasheet URLs must be http(s).")
    async with httpx.AsyncClient(timeout=45, follow_redirects=True, transport=transport) as client:
        async with client.stream("GET", url) as response:
            if response.status_code >= 400:
                raise ReductoError(f"Datasheet download returned HTTP {response.status_code}.")
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > MAX_PDF_BYTES:
                    raise ReductoError("Datasheet is larger than 30 MB.")
                chunks.append(chunk)
    data = b"".join(chunks)
    if not data.startswith(b"%PDF"):
        raise ReductoError("The datasheet URL did not return a PDF.")
    return data


async def extract(
    pdf: bytes,
    *,
    filename: str,
    schema: dict[str, Any],
    system_prompt: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Upload a PDF and run schema extraction with citations enabled."""
    key = reducto_api_key()
    if key is None:
        raise ReductoError("REDUCTO_API_KEY is not configured on the server.")
    headers = {"Authorization": f"Bearer {key}"}
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=180, transport=transport) as client:
            upload = await client.post(
                f"{_base_url()}/upload",
                headers=headers,
                files={"file": (filename, pdf, "application/pdf")},
            )
            if upload.status_code >= 400:
                raise ReductoError(f"Reducto upload returned HTTP {upload.status_code}.", upload.status_code)
            file_id = upload.json().get("file_id")
            if not file_id:
                raise ReductoError("Reducto upload returned no file_id.")
            document = file_id if str(file_id).startswith("reducto://") else f"reducto://{file_id}"
            response = await client.post(
                f"{_base_url()}/extract",
                headers=headers,
                json={
                    "input": document,
                    "instructions": {"schema": schema, "system_prompt": system_prompt},
                    "settings": {"citations": {"enabled": True}},
                },
            )
    except httpx.HTTPError as error:
        record_usage("reducto", "extract", ok=False, detail=type(error).__name__)
        raise ReductoError(f"Reducto request failed: {type(error).__name__}") from error
    except ReductoError as error:
        record_usage("reducto", "extract", ok=False, detail=str(error))
        raise
    duration = int((time.monotonic() - started) * 1000)
    if response.status_code >= 400:
        record_usage("reducto", "extract", ok=False, duration_ms=duration, detail=f"HTTP {response.status_code}")
        raise ReductoError(f"Reducto extract returned HTTP {response.status_code}.", response.status_code)
    data = response.json()
    usage = data.get("usage") or {}
    record_usage(
        "reducto",
        "extract",
        duration_ms=duration,
        pages=usage.get("num_pages"),
        credits=usage.get("credits"),
    )
    return data
