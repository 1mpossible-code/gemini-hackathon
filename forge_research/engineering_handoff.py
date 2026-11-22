"""Read-only engineering boundary over saved research, never browser-supplied claims."""
from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response

from .evidence.datasheets import EvidenceBlocked, bundle_from_documents
from .project import initial_spec_from_report
from .source_research import admitted_evidence, require_admitted_evidence


def engineering_bundle(report) -> dict:
    if report.evidence_blocked or report.review.status == "blocked":
        raise EvidenceBlocked("Research is blocked. Resolve the findings before engineering.")
    parts = report.review.selected_parts
    kind = "sample" if report.mode == "offline" else "exploratory"
    evidence = []
    spec = None
    if report.review.status == "candidate":
        spec, _ = initial_spec_from_report(report)
        if report.project:
            spec = report.project.device_spec.model_copy(deep=True)
        if report.mode != "offline":
            require_admitted_evidence(report, parts)
            audit = report.source_research
            for part in parts:
                if audit and audit.policy.enabled:
                    bundle = admitted_evidence(part, audit)
                else:
                    saved = next((e for e in report.evidence if e.part_id == part.id), None)
                    if saved is None:
                        raise EvidenceBlocked(f"Missing saved evidence for {part.name}.")
                    # Re-evaluate saved facts against the selected SKU, without a refetch.
                    bundle = bundle_from_documents(part, saved.documents, [
                        [f for f in saved.facts if f.document_url == doc.url]
                        for doc in saved.documents
                    ])
                if not bundle.design_ready:
                    raise EvidenceBlocked(f"{part.name}: " + "; ".join(bundle.blocking_reasons))
                evidence.append(bundle.model_dump(mode="json", exclude={"retrieved_at", "cached"}))
            kind = "evidence_backed"
    verification = report.project.verification if report.project else None
    if verification and verification.status in ("failed", "error"):
        raise EvidenceBlocked("The research design has failed or errored proof obligations.")
    payload = {
        "research_id": str(report.research_id),
        "project_id": str(report.project.project_id) if report.project else None,
        "research_revision": report.project.revision if report.project else None,
        "kind": kind,
        "brief": report.brief,
        "parts": [p.model_dump(mode="json") for p in parts],
        "device_spec": spec.model_dump(mode="json") if spec else None,
        "evidence": evidence,
        "source_research": report.source_research.model_dump(mode="json") if report.source_research else None,
        "research_verification": verification.model_dump(mode="json") if verification else None,
        "scope": "Saved research inputs only. Generated PCB wiring, footprints, added parts and edits require separate validation. Pangram measures authorship, not truth.",
    }
    # Hash the exact serialized snapshot so consumers need no cross-language float canonicalization.
    snapshot = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {"schema_version": 1, "bundle_sha256": hashlib.sha256(snapshot.encode()).hexdigest(), "snapshot_json": snapshot}


def handoff_router(runs: Callable[[], Mapping]) -> APIRouter:
    router = APIRouter()

    @router.get("/api/research/{research_id}/engineering-handoff")
    async def get_handoff(research_id: UUID, response: Response):
        report = runs().get(research_id)
        if report is None:
            raise HTTPException(404, "Research run expired. Run research again before engineering.")
        try:
            result = engineering_bundle(report)
        except EvidenceBlocked as error:
            raise HTTPException(422, str(error)) from error
        response.headers["Cache-Control"] = "no-store"
        return result

    return router
