// Every graphic comes from the audit response; no synthetic truth score.
const jobs = new WeakMap();
const sourceProgress = new WeakMap();
const pct = x => x == null ? "Unavailable" : `${(100 * x).toFixed(1)}%`;
const number = x => x == null ? "Insufficient data" : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5 }).format(x);
function el(tag, text = "", cls = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function detail(title, nodes) {
  const section = el("details", "", "audit-detail");
  section.append(el("summary", title), ...nodes);
  return section;
}
function track(items) {
  const list = el("ol", "", "audit-track");
  for (const [title, status, description] of items) {
    const item = el("li", "", `audit-step ${status}`);
    item.append(el("strong", title), el("span", description));
    list.append(item);
  }
  return list;
}
export function clearValidation(target) {
  jobs.get(target)?.abort();
  jobs.delete(target);
  sourceProgress.delete(target);
  target.replaceChildren();
  target.hidden = true;
}
function renderAudit(target, report) {
  const headline = { checked: "Checks completed", needs_review: "Evidence needs review", incomplete: "Some checks unavailable" }[report.status];
  const top = el("div", "", "audit-head");
  top.append(el("h3", headline), el("span", report.revision ? `Revision ${report.revision}` : "Research proposal"));
  const downloads = el("div", "", "audit-downloads");
  for (const [label, suffix] of [["Download HTML report", "/report.html"], ["Download JSON", ""]]) {
    const link = el("a", label, "bar-btn");
    link.href = `/api/validations/${encodeURIComponent(report.validation_id)}${suffix}`;
    link.download = "";
    downloads.append(link);
  }
  const proof = report.proof;
  const checkedSources = report.sources.filter(s => s.parsed && s.identity_matched && s.known_https_url).length;
  target.replaceChildren(top, el("p", `Checked ${new Date(report.checked_at).toLocaleString()} · ${report.mode}`, "audit-note"), track([
    ["Source evidence", checkedSources === report.sources.length && checkedSources > 0 ? "complete" : "attention", `${checkedSources}/${report.sources.length} document checks`],
    ["Lean 4 kernel", proof?.status === "verified" ? "complete" : "attention", proof ? `${proof.verified_count}/${proof.obligations.length} obligations proved` : "No checkable design"],
    ["Pangram authorship", report.authorship[0]?.status === "completed" ? "complete" : "attention", report.authorship[0]?.prediction || report.authorship[0]?.status || "Unavailable"],
  ]), el("p", report.scope, "audit-note"), el("p", report.confidence_note, "audit-note"), downloads);
  if (report.source_research) renderSourceAdmission(target, report.source_research);
  if (report.reasons.length) {
    const reasons = el("ul", "", "audit-reasons");
    report.reasons.forEach(reason => reasons.append(el("li", reason)));
    target.append(detail(`${report.reasons.length} unresolved findings`, [reasons]));
  }
  const sources = el("ul", "", "audit-sources");
  for (const source of report.sources) {
    const row = el("li");
    row.append(el("strong", source.title), el("p", `${source.known_https_url ? "Known HTTPS URL" : "Source URL unresolved"} · ${source.identity_matched ? "Identity matched" : "Identity unresolved"}`));
    try {
      const url = new URL(source.url);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid source URL");
      const link = el("a", source.url);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row.append(link);
    } catch { row.append(el("span", source.url)); }
    row.append(el("code", source.sha256 || "No parsed PDF hash"));
    sources.append(row);
  }
  target.append(detail("Inspect source identity and document hashes", [sources]));
  if (proof) {
    const list = el("ul", "", "audit-proofs");
    for (const ob of proof.obligations) {
      const item = el("li", "", `audit-proof ${ob.status}`);
      item.append(el("strong", `${ob.status.toUpperCase()} · ${ob.title}`), el("p", ob.summary));
      if (ob.lean_theorem) item.append(el("code", ob.lean_theorem));
      list.append(item);
    }
    target.append(detail("Inspect Lean proof outcomes", [el("p", report.proof_note, "audit-note"), list,
      detail("Generated kernel script", [el("pre", proof.lean_source || "No kernel script generated")])]));
  }
  for (const scan of report.authorship) {
    const wrap = el("section", "", "audit-authorship");
    wrap.append(el("h4", scan.subject), el("p", scan.scope, "audit-note"));
    if (scan.status !== "completed") {
      wrap.append(el("p", `${scan.status}: ${scan.detail}`));
      target.append(wrap);
      continue;
    }
    wrap.append(el("p", `${scan.prediction} · AI ${pct(scan.fraction_ai)} · AI-assisted ${pct(scan.fraction_ai_assisted)} · Human ${pct(scan.fraction_human)}`));
    wrap.append(el("p", "These are authorship labels, not factual-error labels. AI-generated text can still be correct.", "audit-note"));
    const strip = el("div", "", "audit-segment-map");
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", "Pangram classified text segments; select a segment to inspect its text");
    const sample = el("div", "Select a segment to inspect the text and detector result.", "audit-segment-text");
    scan.windows.forEach((window, i) => {
      const button = el("button", String(i + 1), "audit-segment");
      button.type = "button";
      button.dataset.origin = /human/i.test(window.label) && !/ai/i.test(window.label) ? "human"
        : /^(ai|ai[- ]generated|fully ai[- ]generated)$/i.test(window.label) ? "ai" : "mixed";
      button.style.flexGrow = Math.max(1, window.end_index - window.start_index);
      button.setAttribute("aria-label", `Segment ${i + 1}: ${window.label}; detector confidence ${window.confidence}; index ${number(window.ai_assistance_score)}`);
      button.addEventListener("click", () => {
        strip.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
        sample.replaceChildren(el("strong", `${window.label} · ${window.confidence} detector confidence · index ${number(window.ai_assistance_score)}`),
          el("blockquote", window.text || "Segment text was not returned by the provider."));
      });
      strip.append(button);
    });
    wrap.append(strip, sample, el("p", `Pangram version ${scan.version} · ${scan.characters_scanned} characters${scan.truncated ? " · partial text scan" : ""}`, "audit-note"));
    target.append(wrap);
  }
  const table = el("table", "", "audit-statistics");
  const header = el("tr");
  ["Observed measurement", "n", "Mean", "Sample SD"].forEach(label => header.append(el("th", label)));
  table.append(header);
  for (const metric of report.spread) {
    const row = el("tr");
    [ `${metric.field} (${metric.unit})`, metric.n, number(metric.mean), number(metric.sample_stddev) ].forEach(value => row.append(el("td", String(value))));
    row.title = `${metric.subject}\n${metric.interpretation}`;
    table.append(row);
  }
  target.append(detail("Observed spread · not confidence in truth", [el("p", "SD needs at least two observations. Zero reader spread does not establish correctness.", "audit-note"), table]));
  target.append(el("small", `Audit ${report.validation_id} · payload SHA-256 ${report.input_sha256}`, "audit-digest"));
}
export function renderSourceProgress(target, event) {
  let audit = sourceProgress.get(target);
  if (event.event === "round") {
    audit ||= { policy: event.policy, status: "running", rounds: 0, sources: [], reasons: [], note: "Original source text is being scanned; authorship is separate from factual correctness." };
    audit.rounds = event.round;
  }
  if (!audit) return;
  if (event.event === "reading") {
    audit.sources.push({ part_id: event.part_id, document: { url: event.url, title: event.title || event.url },
      round: event.round, decision: "reading", reason: "Reducto/Gemini parsing and Pangram detection are running in parallel.",
      metric: "No detection result yet." });
  }
  if (event.event === "decision") {
    const i = audit.sources.findIndex(s => s.document.url === event.source.document.url && s.part_id === event.source.part_id);
    if (i >= 0) audit.sources[i] = event.source; else audit.sources.push(event.source);
  }
  if (event.event === "retry") audit.reasons = [event.detail];
  if (event.event === "complete") audit = event.audit;
  sourceProgress.set(target, audit);
  target.replaceChildren();
  renderSourceAdmission(target, audit);
}

export function renderSourceAdmission(target, audit) {
  const section = el("section", "", "audit-authorship");
  section.append(el("h4", "Research source admission"), el("p", `${audit.status} · ${audit.rounds} discovery round(s) · exclusion cutoff ${pct(audit.policy.exclude_at_ai_fraction)}${audit.policy.include_ai_assisted ? " including AI assistance" : " AI-generated only"}`), el("p", audit.note, "audit-note"));
  const strip = el("div", "", "audit-segment-map");
  const inspector = el("div", "Select a source to inspect its admission decision.", "audit-segment-text");
  for (const [i, source] of audit.sources.entries()) {
    const tile = el("button", `${i+1} · ${source.decision}`, "audit-segment");
    tile.type = "button";
    tile.dataset.origin = source.decision === "accepted" ? "human" : source.decision === "excluded" ? "ai" : "mixed";
    tile.setAttribute("aria-label", `${source.document.title}: ${source.decision}. ${source.reason}`);
    tile.addEventListener("click", () => {
      inspector.replaceChildren(el("strong", source.document.title), el("p", source.document.url),
        el("p", `${source.decision.toUpperCase()} · ${source.reason}`),
        el("p", `AI ${pct(source.ai_fraction)} · AI-assisted ${pct(source.ai_assisted_fraction)} · round ${source.round}`),
        el("p", source.metric, "audit-note"), el("code", source.sha256 || "No retrieved document hash"));
      for (const scan of source.scans || []) {
        const segments = el("div", "", "audit-segment-map");
        for (const window of scan.windows || []) {
          const text = el("details", "", "audit-detail");
          text.append(el("summary", `${window.label} · ${window.confidence} detector confidence`), el("blockquote", window.text || "Segment text unavailable"));
          segments.append(text);
        }
        inspector.append(segments);
      }
    });
    strip.append(tile);
  }
  section.append(strip, inspector);
  for (const reason of audit.reasons) section.append(el("p", reason));
  target.append(section);
  target.hidden = false;
}

export async function runValidation({ url, body, target, button }) {
  jobs.get(target)?.abort();
  const controller = new AbortController();
  jobs.set(target, controller);
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Validating…";
  target.hidden = false;
  target.setAttribute("aria-busy", "true");
  target.replaceChildren(el("h3", "Validating sources, proofs and authorship"), track([
    ["Source evidence", "running", "Reading manufacturer PDFs"],
    ["Lean 4 kernel", "running", "Rechecking emitted obligations"],
    ["Pangram authorship", "running", "Analyzing generated prose"],
  ]), el("p", "Checks run in parallel. Provider timeouts and missing evidence will be reported explicitly.", "audit-note"));
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Validation could not complete.");
    if (jobs.get(target) !== controller) return;
    renderAudit(target, result);
  } catch (error) {
    if (controller.signal.aborted) return;
    target.replaceChildren(el("h3", "Validation unavailable"), el("p", `${error.message} Check the server and provider keys, then try again.`));
  } finally {
    if (jobs.get(target) === controller) {
      target.setAttribute("aria-busy", "false");
      button.disabled = false;
      button.textContent = original;
    }
  }
}
