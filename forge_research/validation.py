"""Evidence audit + fresh Lean proofs + separate, non-authoritative authorship scans."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import statistics
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from pydantic import BaseModel, Field

from .evidence.datasheets import (
    CRITICAL_FIELDS, ComponentEvidence, EvidenceRegistry, documents_for, normalize_unit,
)
from .models import CostBreakdown, DeviceSpecification, Part, ResearchReport, VerificationReport
from .providers.pangram import AuthorshipScan, analyze_text
from .verify import verify_design
from .source_research import SourceResearch, research_sources, admitted_evidence


class Spread(BaseModel):
    subject: str
    metric: Literal["reader_measurement", "authorship_score"]
    field: str
    unit: str
    n: int
    mean: float | None
    sample_stddev: float | None
    interpretation: str


class SourceCheck(BaseModel):
    part_id: str
    title: str
    url: str
    sha256: str | None
    known_https_url: bool
    identity_matched: bool
    parsed: bool


class ValidationReport(BaseModel):
    validation_id: UUID = Field(default_factory=uuid4)
    schema_version: int = 1
    checked_at: datetime
    revision: int | None
    input_sha256: str
    mode: str
    status: Literal["checked", "needs_review", "incomplete"]
    scope: str = "Structured component facts and emitted Lean obligations; free-form narrative claims are not fact-checked."
    probability_correct: None = None
    confidence_interval: None = None
    confidence_note: str = (
        "No calibrated probability of correctness or confidence interval is available. "
        "Standard deviations describe observed spread, not truth confidence. "
        "The readers share one source and are not independent ground-truth samples."
    )
    sources: list[SourceCheck] = Field(default_factory=list)
    evidence: list[ComponentEvidence] = Field(default_factory=list)
    source_research: SourceResearch | None = None
    proof: VerificationReport | None = None
    proof_note: str = "Lean proves only the emitted propositions from the supplied catalog inputs, not the truth of those inputs."
    authorship: list[AuthorshipScan] = Field(default_factory=list)
    spread: list[Spread] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)


def spread(subject: str, metric: str, field: str, unit: str, values: list[float]) -> Spread:
    numbers = [float(v) for v in values if math.isfinite(v)]
    return Spread(subject=subject, metric=metric, field=field, unit=unit, n=len(numbers),
                  mean=statistics.mean(numbers) if numbers else None,
                  sample_stddev=statistics.stdev(numbers) if len(numbers) > 1 else None,
                  interpretation=("Across Pangram text segments; descriptive authorship index, not confidence in factual truth."
                                  if metric == "authorship_score" else
                                  "Across the two readers of this PDF; agreement can still share a source error."))


def reader_spreads(bundles: list[ComponentEvidence]) -> list[Spread]:
    output = []
    for bundle in bundles:
        for fact in bundle.facts:
            other = fact.independent
            if fact.field not in CRITICAL_FIELDS or not other:
                continue
            for key in ("value", "min", "typ", "max"):
                a, b = getattr(fact, key), other.get(key)
                if not isinstance(a, (float, int)) or not isinstance(b, (float, int)):
                    continue
                normalized, unit = normalize_unit(b, other.get("unit"))
                if unit == fact.unit:
                    output.append(spread(f"{bundle.part_id} · {fact.document_url}", "reader_measurement",
                                         f"{fact.field}.{key}", unit or "", [a, normalized]))
    return output


def source_checks(parts: list[Part], bundles: list[ComponentEvidence], admission: SourceResearch | None = None) -> list[SourceCheck]:
    checks = []
    by_id = {p.id: p for p in parts}
    for bundle in bundles:
        known = {doc.url for doc in documents_for(by_id[bundle.part_id])}
        if admission:
            known.update(s.document.url for s in admission.sources if s.part_id == bundle.part_id and s.decision == "accepted")
        for doc in bundle.documents:
            read = doc.independent_read
            checks.append(SourceCheck(
                part_id=bundle.part_id, title=doc.title or doc.url, url=doc.url, sha256=doc.sha256,
                known_https_url=doc.url in known and urlsplit(doc.url).scheme == "https",
                identity_matched=bool(read and read.identity_matches and not doc.verification_error),
                parsed=doc.status == "parsed" and bool(doc.sha256),
            ))
    return checks


def narrative(report: ResearchReport, advisory: str = "") -> str:
    # Scan generated narrative, never the user's brief or an invented human rewrite.
    return "\n\n".join(s for s in [report.proposal.rationale, *report.review_notes.next_steps, advisory] if s.strip())


async def validate_report(
    report: ResearchReport, *, registry: EvidenceRegistry, parts: list[Part],
    spec: DeviceSpecification | None, cost: CostBreakdown | None,
    revision: int | None, advisory: str = "",
) -> ValidationReport:
    text = narrative(report, advisory)
    # Fresh registry downloads PDFs again but permits content-hash reader caches.
    # Fresh proof calls bypass the Lean result cache.
    async def proofs():
        if spec is None or cost is None:
            return None
        return await verify_design(revision or 1, spec, report.catalog_snapshot, cost, use_cache=False)

    previous_admission = getattr(report, "source_research", None)
    admission = previous_admission if previous_admission and not previous_admission.policy.enabled else None
    async def evidence_read():
        nonlocal admission
        previous = getattr(report, "source_research", None)
        if previous and previous.policy.enabled:
            admission = await research_sources(report.brief, parts, previous.policy)
            return [admitted_evidence(part, admission) for part in parts]
        return await asyncio.gather(*(registry.get(part) for part in parts))

    bundles, proof, report_scan = await asyncio.gather(
        evidence_read(), proofs(),
        analyze_text(text, subject="Generated report", scope="Generated narrative only; user brief excluded"),
    )
    sources = source_checks(parts, bundles, admission)
    scans = [report_scan]
    # Table fragments are a poor input to an authorship classifier. Only offer a
    # descriptive scan for sufficiently long prose excerpts; never certify a PDF.
    semaphore = asyncio.Semaphore(3)
    async def scan_source(bundle, doc):
        snippets = list(dict.fromkeys(f.snippet.strip() for f in bundle.facts
                                    if f.document_url == doc.url and f.snippet and f.snippet.strip()))
        excerpt = "\n\n".join(snippets)
        subject = f"{bundle.part_id} · {doc.title or doc.url}"
        scope = "Extracted source excerpts only, not full PDF authorship or source authenticity"
        if len(excerpt.split()) < 200 or excerpt.count(".") < 3:
            return AuthorshipScan(subject=subject, scope=scope, status="skipped",
                                  detail="Insufficient source prose; technical table fragments are unsuitable for reliable authorship detection.")
        async with semaphore:
            return await analyze_text(excerpt, subject=subject, scope=scope)
    if admission is not None and admission.policy.enabled:
        scans.extend(scan for source in admission.sources for scan in source.scans)
    else:
        scans.extend(await asyncio.gather(*(scan_source(bundle, doc) for bundle in bundles for doc in bundle.documents)))
    reasons = []
    if admission is not None and admission.policy.enabled and admission.status != "accepted":
        reasons.extend(admission.reasons or ["Source-admission policy needs review."])
    if not parts:
        reasons.append("No supported component facts are available to validate.")
    for bundle in bundles:
        if not bundle.design_ready:
            reasons.extend(f"{bundle.part_name}: {r}" for r in (bundle.blocking_reasons or ["Critical source facts are not verified."]))
    for source in sources:
        if not source.known_https_url or not source.identity_matched or not source.parsed:
            reasons.append(f"{source.title}: source URL, identity or parsed document evidence is unresolved.")
    if proof is None:
        reasons.append("No supported design was available for Lean verification.")
    elif not proof.obligations or proof.status != "verified" or proof.unverified_count:
        reasons.append("Lean has failed, errored, or unverified obligations; inspect the proof results.")
    factual_review = bool(reasons)
    incomplete_authorship = report_scan.status != "completed" or any(s.status in {"unavailable", "error"} for s in scans)
    for scan in scans:
        if scan.status in {"unavailable", "error"} or (scan is report_scan and scan.status != "completed"):
            reasons.append(f"{scan.subject}: authorship analysis {scan.status}: {scan.detail}")
    metrics = reader_spreads(bundles)
    for scan in scans:
        if scan.status == "completed":
            metrics.append(spread(scan.subject, "authorship_score", "Pangram AI-assistance index", "index (0–1)",
                                  [window.ai_assistance_score for window in scan.windows]))
    payload = dict(report=report.model_dump(mode="json"), spec=spec.model_dump(mode="json") if spec else None,
                   revision=revision, evidence=[b.model_dump(mode="json") for b in bundles],
                   proof=proof.model_dump(mode="json") if proof else None,
                   authorship=[s.model_dump(mode="json") for s in scans],
                   source_research=admission.model_dump(mode="json") if admission else None)
    return ValidationReport(
        checked_at=datetime.now(UTC), revision=revision, mode=report.mode,
        input_sha256=hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(),
        status="needs_review" if factual_review else "incomplete" if incomplete_authorship else "checked",
        sources=sources, evidence=bundles, proof=proof, authorship=scans, spread=metrics, reasons=reasons, source_research=admission,
    )
