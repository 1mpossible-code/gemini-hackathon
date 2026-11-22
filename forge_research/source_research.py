"""Source admission: retrieve once, parse and detect in parallel, exclude and retry."""
from __future__ import annotations
import asyncio
import hashlib
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .agents.source_discovery import discover_documents
from .evidence import datasheets as ds
from .models import Part
from .providers.pangram import AuthorshipScan, analyze_text


class SourcePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    enabled: bool = True
    exclude_at_ai_fraction: float = Field(default=.5, ge=0, le=1)
    include_ai_assisted: bool = False
    max_retries: int = Field(default=1, ge=0, le=2)


class SourceAdmission(BaseModel):
    part_id: str
    document: ds.BundleDocument
    round: int
    decision: Literal["accepted", "excluded", "unverified", "error"]
    reason: str
    sha256: str | None = None
    ai_fraction: float | None = None
    ai_assisted_fraction: float | None = None
    metric: str = "Character-weighted Pangram fractions over all locally extracted source text"
    scans: list[AuthorshipScan] = Field(default_factory=list)
    parsed: ds.SourceDocument | None = None
    facts: list[ds.ComponentFact] = Field(default_factory=list)
    discovery: str = "catalog"
    grounding_urls: list[str] = Field(default_factory=list)


class SourceResearch(BaseModel):
    policy: SourcePolicy
    status: Literal["accepted", "needs_review", "skipped"]
    rounds: int = 0
    sources: list[SourceAdmission] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    note: str = "Authorship policy only; admission does not prove factual truth. Excluded sources remain in the audit trail."


def allowed_hosts(parts: list[Part]) -> set[str]:
    return {urlsplit(url).hostname for part in parts for url in
            [*(str(u) for u in part.technical_sources), *(d.url for d in ds.documents_for(part))]
            if urlsplit(url).hostname}


async def fetch_source(url: str, hosts: set[str]) -> bytes:
    # Discovery cannot turn the backend into an arbitrary/private URL fetcher.
    # Every redirect must remain on a known manufacturer host for the supported catalog.
    async with httpx.AsyncClient(timeout=35, follow_redirects=False) as client:
        for _ in range(5):
            parsed = urlsplit(url)
            if parsed.scheme != "https" or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.port not in (None, 443):
                raise ValueError("Source is outside the supported manufacturer HTTPS hosts.")
            async with client.stream("GET", url) as response:
                if response.is_redirect:
                    url = str(response.url.join(response.headers["location"]))
                    continue
                response.raise_for_status()
                chunks, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > 14 * 1024 * 1024: raise ValueError("Source exceeds the 14 MB verified-reader limit.")
                    chunks.append(chunk)
                data = b"".join(chunks)
                if not data.startswith(b"%PDF"): raise ValueError("Source URL did not return a PDF.")
                return data
        raise ValueError("Too many source redirects.")


def pdf_text(data: bytes) -> str:
    executable = shutil.which("pdftotext")
    if not executable: raise ValueError("pdftotext is required to scan original PDF text with Pangram.")
    with tempfile.TemporaryDirectory(prefix="forge-source-") as directory:
        source, output = Path(directory) / "source.pdf", Path(directory) / "source.txt"
        source.write_bytes(data)
        subprocess.run([executable, "-enc", "UTF-8", str(source), str(output)],
                       capture_output=True, check=True, timeout=25)
        if output.stat().st_size > 1_000_000: raise ValueError("Source text exceeds audit size limit.")
        return output.read_text()


async def scan_original(data: bytes, doc: ds.BundleDocument) -> list[AuthorshipScan]:
    try:
        text = await asyncio.to_thread(pdf_text, data)
    except Exception as error:
        return [AuthorshipScan(subject=doc.title, scope="Original PDF text", status="error",
                               detail=f"Original text extraction unavailable ({type(error).__name__}).")]
    if len(text) > 192_000:
        return [AuthorshipScan(subject=doc.title, scope="Original PDF text", status="skipped",
                               detail="Document exceeds the complete-text scan budget; no automatic admission.")]
    # Split without dropping text. A short final tail is included in the previous
    # chunk, which analyze_text must not silently truncate for admission.
    chunks = [text[i:i+20_000] for i in range(0, len(text), 20_000)] or [text]
    if len(chunks) > 1 and len(chunks[-1].split()) < 200:
        chunks[-2:] = [chunks[-2] + chunks[-1]]
    # A tail merge can exceed a provider request budget: remain unverified.
    if any(len(chunk) > 24_000 for chunk in chunks):
        return [AuthorshipScan(subject=doc.title, scope="Original PDF text", status="skipped",
                               detail="Full text cannot fit the bounded scan chunks; no automatic admission.")]
    async def scan(index, chunk):
        return await analyze_text(chunk, subject=f"{doc.title} · section {index+1}/{len(chunks)}",
                                  scope="Original locally extracted PDF text, including technical content")
    return await asyncio.gather(*(scan(i, chunk) for i, chunk in enumerate(chunks)))


def admission_decision(scans: list[AuthorshipScan], policy: SourcePolicy) -> tuple[str, str, float | None, float | None]:
    if not scans or any(s.status != "completed" or s.truncated for s in scans):
        return "unverified", "Complete original-text authorship scan unavailable; source was not automatically admitted.", None, None
    total = sum(s.characters_scanned for s in scans)
    if not total or any(s.fraction_ai is None or s.fraction_ai_assisted is None for s in scans):
        return "unverified", "Detector did not return complete text fractions.", None, None
    ai = sum(s.fraction_ai * s.characters_scanned for s in scans) / total
    assisted = sum(s.fraction_ai_assisted * s.characters_scanned for s in scans) / total
    score = ai + assisted if policy.include_ai_assisted else ai
    if score >= policy.exclude_at_ai_fraction:
        return "excluded", f"Detected fraction {score:.1%} meets/exceeds the {policy.exclude_at_ai_fraction:.1%} exclusion threshold.", ai, assisted
    return "accepted", f"Detected fraction {score:.1%} is below the {policy.exclude_at_ai_fraction:.1%} exclusion threshold.", ai, assisted


async def research_sources(brief: str, parts: list[Part], policy: SourcePolicy, *, emit=None) -> SourceResearch:
    if not policy.enabled:
        return SourceResearch(policy=policy, status="skipped", reasons=["Automatic authorship filtering is disabled."])
    if not parts:
        return SourceResearch(policy=policy, status="needs_review", reasons=["This research path needs supported catalog parts before it can discover and verify PDFs."])
    if not all(os.getenv(k, "").strip() for k in ("REDUCTO_API_KEY", "PANGRAM_API_KEY")) or not (os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("GOOGLE_API_KEY", "").strip()):
        return SourceResearch(policy=policy, status="needs_review", reasons=["Source admission requires Reducto, Gemini and Pangram keys. Unknown detector results cannot pass the policy."])
    hosts = allowed_hosts(parts)
    audit = SourceResearch(policy=policy, status="needs_review")
    by_id = {part.id: part for part in parts}
    seen_urls, seen_hashes = set(), set()
    limit = asyncio.Semaphore(3)
    async def notify(event):
        if emit: emit({"type": "source_audit", **event})
    async def process(part_id, doc, round_number, discovery="catalog", grounding=None):
        async with limit:
            await notify({"event": "reading", "url": doc.url, "title": doc.title, "part_id": part_id, "round": round_number})
            try:
                data = await fetch_source(doc.url, hosts)
                sha = hashlib.sha256(data).hexdigest()
                if (part_id, sha) in seen_hashes:
                    return SourceAdmission(part_id=part_id, document=doc, round=round_number, decision="unverified",
                                           reason="Duplicate document content; a new URL does not reset its policy result.", sha256=sha,
                                           discovery=discovery, grounding_urls=grounding or [])
                seen_hashes.add((part_id, sha))
                parsed, scans = await asyncio.gather(ds._parse_pdf(by_id[part_id], doc, data), scan_original(data, doc))
                source, facts = parsed
                decision, reason, ai, assisted = admission_decision(scans, policy)
                if decision == "accepted" and (source.status != "parsed" or source.verification_error or not source.independent_read or not source.independent_read.identity_matches):
                    decision, reason = "unverified", "Authorship cutoff passed but document identity, revision or extraction remains unresolved."
                result = SourceAdmission(part_id=part_id, document=doc, round=round_number, decision=decision,
                    reason=reason, sha256=sha, ai_fraction=ai, ai_assisted_fraction=assisted, scans=scans,
                    parsed=source, facts=facts, discovery=discovery, grounding_urls=grounding or [])
            except Exception as error:
                result = SourceAdmission(part_id=part_id, document=doc, round=round_number, decision="error",
                                         reason=f"Source acquisition or parsing failed ({type(error).__name__}).",
                                         discovery=discovery, grounding_urls=grounding or [])
            await notify({"event": "decision", "source": result.model_dump(mode="json")})
            return result
    for round_number in range(1, policy.max_retries + 2):
        audit.rounds = round_number
        needed = [part for part in parts if not admitted_evidence(part, audit).design_ready]
        await notify({"event": "round", "round": round_number, "max_rounds": policy.max_retries + 1, "policy": policy.model_dump()})
        discovered = await discover_documents(brief, needed, list(seen_urls), round_number=round_number)
        candidates = [(p.id, doc, "catalog", []) for p in needed for doc in ds.documents_for(p)] if round_number == 1 else []
        candidates.extend((d.part_id, d.document, d.specialist, d.grounded_urls) for d in discovered)
        unique = []
        for pid, doc, origin, grounding in candidates:
            if doc.url in seen_urls: continue
            seen_urls.add(doc.url)
            unique.append((pid, doc, origin, grounding))
        # Explicit bounded research budget, applied before any retrieval.
        unique = unique[:min(6, max(0, 12 - len(audit.sources)))]
        results = await asyncio.gather(*(process(pid, doc, round_number, origin, grounding) for pid, doc, origin, grounding in unique))
        audit.sources.extend(results)
        missing = [p for p in parts if not admitted_evidence(p, audit).design_ready]
        if not missing:
            audit.status = "accepted"
            break
        if round_number <= policy.max_retries:
            await notify({"event": "retry", "round": round_number + 1, "detail": "Searching again for sources that pass the configured authorship policy."})
    if audit.status != "accepted":
        audit.reasons = [f"{p.name}: accepted sources still do not verify the required design facts after {audit.rounds} round(s)."
                         for p in parts if not admitted_evidence(p, audit).design_ready]
    await notify({"event": "complete", "audit": audit.model_dump(mode="json")})
    return audit


def admitted_evidence(part: Part, audit: SourceResearch) -> ds.ComponentEvidence:
    records = [s for s in audit.sources if s.part_id == part.id and s.decision == "accepted" and s.parsed]
    # Rebuild against the current catalog snapshot without fetching a different PDF.
    return ds.bundle_from_documents(part, [s.parsed.model_copy(deep=True) for s in records],
                                    [[f.model_copy(deep=True) for f in s.facts] for s in records])


def require_admitted_evidence(report, parts: list[Part]) -> None:
    audit = getattr(report, "source_research", None)
    if audit is None or not audit.policy.enabled:
        return
    if audit.status != "accepted":
        raise ds.EvidenceBlocked("Research sources did not pass the configured authorship policy.")
    for part in parts:
        evidence = admitted_evidence(part, audit)
        if not evidence.design_ready:
            raise ds.EvidenceBlocked(f"{part.name}: accepted sources do not verify the required design facts. " + "; ".join(evidence.blocking_reasons))
