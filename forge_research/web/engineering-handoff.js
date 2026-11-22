// Only a saved-run reference crosses the browser boundary. The PCB server resolves it again.
export async function sendEngineeringHandoff(report, studioUrl) {
  if (!report?.research_id || report.evidence_blocked) throw new Error("Complete research before engineering.");
  const response = await fetch(`/api/research/${encodeURIComponent(report.research_id)}/engineering-handoff`, { cache: "no-store" });
  const bundle = await response.json();
  if (!response.ok) throw new Error(bundle.detail || "Engineering handoff is blocked.");
  const reference = { researchId: report.research_id, bundleSha256: bundle.bundle_sha256 };
  if (window.parent !== window) {
    window.parent.postMessage({ type: "forge:engineer", reference }, location.origin);
  } else {
    const url = new URL(studioUrl);
    url.searchParams.set("research", reference.researchId);
    url.searchParams.set("researchHash", reference.bundleSha256);
    location.assign(url);
  }
}
