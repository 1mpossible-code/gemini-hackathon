"""Self-contained, escaped audit report suitable for downloading and sharing."""
from html import escape
from .validation import ValidationReport


def render_validation_html(report: ValidationReport) -> str:
    e = lambda value: escape(str(value))
    proof = report.proof
    source_rows = "".join(
        f"<tr><td>{e(s.part_id)}</td><td>{e(s.title)}<br>{e(s.url)}</td>"
        f"<td>{'Known HTTPS URL' if s.known_https_url else 'Unresolved URL'}</td>"
        f"<td>{'Matched' if s.identity_matched else 'Unresolved'}</td><td><code>{e(s.sha256 or 'No document hash')}</code></td></tr>"
        for s in report.sources
    )
    proof_rows = "".join(
        f"<tr><td>{e(o.title)}</td><td>{e(o.status)}</td><td>{e(o.summary)}<br><code>{e(o.lean_theorem or 'No kernel proof')}</code></td></tr>"
        for o in (proof.obligations if proof else [])
    )
    scans = []
    for scan in report.authorship:
        segments = "".join(f'<mark title="{e(w.confidence)} · index {w.ai_assistance_score:.3f}">{e(w.label)}: {e(w.text or "Segment text unavailable")}</mark> ' for w in scan.windows)
        scans.append(f"<h3>{e(scan.subject)}</h3><p>{e(scan.scope)} · {e(scan.status)} · {e(scan.prediction or scan.detail)}</p>"
                     f"<p>AI fraction: {e(scan.fraction_ai)} · assisted fraction: {e(scan.fraction_ai_assisted)} · human fraction: {e(scan.fraction_human)}</p><p>{segments}</p>")
    stats = "".join(f"<tr><td>{e(s.subject)}<br>{e(s.field)}</td><td>{s.n}</td><td>{e(s.mean)}</td><td>{e(s.sample_stddev if s.sample_stddev is not None else 'Insufficient data')}</td><td>{e(s.unit)}<br>{e(s.interpretation)}</td></tr>" for s in report.spread)
    reasons = "".join(f"<li>{e(r)}</li>" for r in report.reasons)
    admission = ""
    if report.source_research:
        audit = report.source_research
        rows = "".join(f"<tr><td>{e(s.document.title)}<br>{e(s.document.url)}</td><td>{e(s.decision)}</td><td>{e(s.ai_fraction)}</td><td>{e(s.ai_assisted_fraction)}</td><td>{e(s.round)}</td><td>{e(s.reason)}</td></tr>" for s in audit.sources)
        admission = f"<h2>Research source admission</h2><p>{e(audit.status)} · {audit.rounds} rounds · exclusion cutoff {audit.policy.exclude_at_ai_fraction:.0%}. {e(audit.note)}</p><table><thead><tr><th>Source</th><th>Decision</th><th>AI fraction</th><th>Assisted fraction</th><th>Round</th><th>Reason</th></tr></thead><tbody>{rows}</tbody></table>"
    raw = e(report.model_dump_json(indent=2))
    return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FORGE validation report</title><style>
body{{max-width:1100px;margin:40px auto;padding:0 24px;font:16px/1.55 system-ui;color:#18221d;background:#f6f7f3}}
h1{{font-size:2.6rem;line-height:1.1}}h2{{margin-top:42px;border-top:1px solid #bac5bd;padding-top:24px}}
table{{border-collapse:collapse;width:100%;font-size:14px}}th,td{{text-align:left;border-bottom:1px solid #c5cec7;padding:12px 8px;vertical-align:top;overflow-wrap:anywhere}}
.track{{display:flex;flex-wrap:wrap;gap:12px;margin:28px 0}}.track strong{{padding:14px;background:#e1e8e1}}
mark{{display:inline;background:#f1ddaa;color:#36280d;padding:2px}}code,pre{{font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap}}
@media print{{body{{margin:0;background:white}}details{{display:block}}}}
</style><h1>Sources, proofs &amp; authorship</h1><p>{e(report.status.replace('_', ' '))} · {e(report.checked_at.isoformat())} · {e(report.mode)} · revision {e(report.revision or 'Research proposal')}</p>
<div class="track"><strong>{sum(s.parsed and s.identity_matched and s.known_https_url for s in report.sources)}/{len(report.sources)} source checks</strong>
<strong>{proof.verified_count if proof else 0}/{len(proof.obligations) if proof else 0} Lean obligations proved</strong>
<strong>{sum(s.status == 'completed' for s in report.authorship)}/{len(report.authorship)} authorship scans completed</strong></div>
<p><b>This report does not certify factual truth or absence of AI hallucinations.</b> {e(report.scope)}</p><p>{e(report.confidence_note)}</p><ul>{reasons}</ul>
{admission}<h2>Source evidence</h2><table><thead><tr><th>Part</th><th>Source</th><th>Provenance</th><th>Identity</th><th>SHA-256</th></tr></thead><tbody>{source_rows}</tbody></table>
<h2>Lean 4 proof outcomes</h2><p>{e(report.proof_note)}</p><table><thead><tr><th>Obligation</th><th>Outcome</th><th>Evidence</th></tr></thead><tbody>{proof_rows}</tbody></table>
<h2>Pangram authorship analysis</h2><p>Flags describe writing origin, not whether the text is true or the design works.</p>{''.join(scans)}
<h2>Observed spread</h2><p>Sample standard deviation; not a calibrated confidence interval.</p><table><thead><tr><th>Measurement</th><th>n</th><th>Mean</th><th>Sample SD</th><th>Meaning</th></tr></thead><tbody>{stats}</tbody></table>
<h2>Reproducibility record</h2><p>Audit ID: {e(report.validation_id)}<br>Audit payload SHA-256: <code>{e(report.input_sha256)}</code></p>
<details><summary>Complete machine-readable audit, source excerpts and proof script</summary><pre>{raw}</pre></details></html>'''
