import {
  applyResearchEvent,
  finishResearchMap,
  readResearch,
  showResearchMap,
} from "./research-map.js";
import {
  bindWorkbenchEvents,
  getCurrentProject,
  loadProjectIntoWorkbench,
  setCatalogParts,
  setLiveGeminiStatus,
} from "./workbench.js";

const $ = sel => document.querySelector(sel);

const form = $("#composer");
const brief = $("#brief");
const connection = $("#connection");
const leanBadge = $("#lean-badge");
const runButton = $("#run");
const runLabel = $("#run-label");
const sampleButton = $("#run-sample");
const exampleButton = $("#fill-example");
const tightExampleButton = $("#fill-tight-budget");
const feedback = $("#feedback");

let sampleBrief =
  "Design a wrist-worn finger-gesture detector using muscle sensors for under $100 that sends gesture events to my laptop over Bluetooth Low Energy.";
const tightBrief =
  "Design a BLE wristband using EMG muscle sensors for finger gestures. Keep core parts under $80 and size the strap for a 175 mm wrist.";

let pending = false;
let researchController = null;
let latestCompletedReport = null;

if (/mac/i.test(navigator.userAgentData?.platform ?? navigator.platform)) {
  $("#modifier").textContent = "⌘";
}

function showFeedback(msg) {
  feedback.textContent = msg;
}

function showBriefScreen() {
  $("#brief-view").hidden = false;
  $("#research-view").hidden = true;
  $("#blocked-view").hidden = true;
  $("#workbench-view").hidden = true;
  $("#engineering-statusbar").hidden = true;
  $("#Capabilities-pill").hidden = false;
  $("#nav-context").textContent = "New brief";
  brief.focus();
}

function showResearchScreen() {
  $("#brief-view").hidden = true;
  $("#research-view").hidden = false;
  $("#blocked-view").hidden = true;
  $("#workbench-view").hidden = true;
  $("#engineering-statusbar").hidden = true;
  $("#Capabilities-pill").hidden = false;
  $("#nav-context").textContent = "Agent Research DAG";
}

function renderBlockedReport(report) {
  $("#brief-view").hidden = true;
  $("#research-view").hidden = true;
  $("#workbench-view").hidden = true;
  $("#blocked-view").hidden = false;
  $("#engineering-statusbar").hidden = true;
  $("#Capabilities-pill").hidden = false;
  $("#nav-context").textContent = "Blocked Report";

  const statusMap = {
    blocked: "Design blocked by constraints",
    unsupported: "Outside supported wearable catalog scope",
    candidate: "Candidate report",
  };
  $("#blocked-mode").textContent = `${
    report.mode === "offline" ? "Offline sample" : `Gemini (${report.model})`
  } · ${statusMap[report.review.status] || report.review.status}`;
  $("#blocked-brief").textContent = report.brief;

  const findingsList = $("#blocked-findings");
  findingsList.replaceChildren(
    ...(report.review.findings || []).map(f => {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = `${f.check.replaceAll("_", " ")} · ${f.status.toUpperCase()}`;
      const small = document.createElement("small");
      small.textContent = f.detail;
      li.append(strong, small);
      return li;
    })
  );

  const stepsList = $("#blocked-next-steps");
  stepsList.replaceChildren(
    ...(report.review_notes?.next_steps || []).map(step => {
      const li = document.createElement("li");
      li.textContent = step;
      return li;
    })
  );
}

function setBusy(busy, mode) {
  pending = busy;
  runButton.disabled = busy;
  runLabel.textContent = busy && mode === "live" ? "Researching…" : "Research with Gemini";
  sampleButton.disabled = busy;
  exampleButton.disabled = busy;
  tightExampleButton.disabled = busy;
  brief.readOnly = busy;
  form.setAttribute("aria-busy", String(busy));
}

async function startResearch(mode) {
  if (pending) return;
  const value = brief.value.trim();
  if (mode === "live" && !value) {
    showFeedback("Enter a hardware design brief or launch the offline wristband studio.");
    brief.setAttribute("aria-invalid", "true");
    brief.focus();
    return;
  }
  brief.removeAttribute("aria-invalid");
  setBusy(true, mode);
  showFeedback("");
  researchController = new AbortController();
  $("#open-workbench-btn").hidden = true;
  $("#engineer-pcb-btn").hidden = true;
  showResearchScreen();
  showResearchMap(mode, mode === "sample" ? sampleBrief : value);

  try {
    const report = await readResearch(
      mode,
      value,
      researchController.signal,
      applyResearchEvent
    );
    latestCompletedReport = report;
    finishResearchMap("completed", "", report);
    // Research never blocks the build. With or without catalog picks, the brief
    // goes to the PCB studio, which can generate a board for any request.
    if (!report.brief) report.brief = mode === "sample" ? sampleBrief : value;
    $("#engineer-pcb-btn").hidden = false;
    $("#btn-engineer-pcb").hidden = false;
    if (report.project) $("#open-workbench-btn").hidden = false;
    engineerPcb();
  } catch (error) {
    if (researchController.signal.aborted) {
      finishResearchMap("stopped", "Run cancelled. You can edit the brief and try again.");
    } else {
      const message =
        error instanceof TypeError
          ? "Could not reach FORGE server. Check that uvicorn is running."
          : error.message;
      finishResearchMap("failed", message);
      // A failed research run still hands the brief over so the board gets built.
      const brief = mode === "sample" ? sampleBrief : value;
      if (brief) {
        latestCompletedReport = { brief, review: { selected_parts: [] } };
        $("#engineer-pcb-btn").hidden = false;
        engineerPcb();
      }
    }
  } finally {
    researchController = null;
    setBusy(false, mode);
  }
}

// Hand the finished research run to the PCB studio, which generates a board for it.
// Inside the PCB studio's Research tab this posts to the parent window; standalone it
// navigates to the studio (FORGE_PCB_URL from /api/session).
// Served under /research/ by the PCB studio: the studio is this origin's root.
const sameOriginStudio = location.pathname.startsWith("/research");
// Vite binds "localhost", which can be IPv6 only, so 127.0.0.1 may refuse.
let pcbUrl = sameOriginStudio ? `${location.origin}/` : "http://localhost:5173/";
// Resolves once /api/session has supplied the real studio address.
let sessionLoaded = Promise.resolve();
async function engineerPcb() {
  const report = latestCompletedReport;
  if (!report) return;
  const parts = (report.review?.selected_parts || []).map(p => ({
    id: p.id, role: p.role, name: p.name, manufacturer: p.manufacturer, sku: p.sku,
  }));
  const message = { type: "forge:engineer", brief: report.brief, parts };
  if (window.parent !== window) {
    window.parent.postMessage(message, location.origin);
  } else {
    // A fast run (?run=sample) can finish before the session answers; wait for the address.
    await sessionLoaded;
    const url = new URL(pcbUrl);
    url.searchParams.set("brief", report.brief);
    url.searchParams.set("parts", parts.map(p => p.name).join(", "));
    location.assign(url);
  }
}
$("#engineer-pcb-btn").addEventListener("click", engineerPcb);
$("#btn-engineer-pcb").addEventListener("click", engineerPcb);

$("#brand-home").addEventListener("click", e => {
  e.preventDefault();
  if (getCurrentProject()) {
    $("#brief-view").hidden = true;
    $("#research-view").hidden = true;
    $("#blocked-view").hidden = true;
    $("#workbench-view").hidden = false;
    $("#engineering-statusbar").hidden = false;
    $("#Capabilities-pill").hidden = true;
    $("#nav-context").textContent = "Workbench";
  } else {
    showBriefScreen();
  }
});

$("#stop-research").addEventListener("click", () => researchController?.abort());
$("#edit-brief").addEventListener("click", showBriefScreen);
$("#blocked-edit-brief").addEventListener("click", showBriefScreen);
$("#open-workbench-btn").addEventListener("click", () => {
  if (getCurrentProject()) {
    loadProjectIntoWorkbench(getCurrentProject(), latestCompletedReport);
  }
});

form.addEventListener("submit", e => {
  e.preventDefault();
  startResearch("live");
});
brief.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    form.requestSubmit();
  }
});
brief.addEventListener("input", () => {
  brief.removeAttribute("aria-invalid");
  if (!pending) showFeedback("");
});
exampleButton.addEventListener("click", () => {
  brief.value = sampleBrief;
  brief.removeAttribute("aria-invalid");
  showFeedback("");
  brief.focus();
});
tightExampleButton.addEventListener("click", () => {
  brief.value = tightBrief;
  brief.removeAttribute("aria-invalid");
  showFeedback("");
  brief.focus();
});
sampleButton.addEventListener("click", () => startResearch("sample"));
if (new URLSearchParams(location.search).get("run") === "sample") startResearch("sample");

bindWorkbenchEvents(
  () => showBriefScreen(),
  () => {
    showResearchScreen();
    $("#open-workbench-btn").hidden = !getCurrentProject();
    $("#edit-brief").hidden = false;
    $("#stop-research").hidden = true;
  }
);

sessionLoaded = Promise.all([
  fetch("/api/session").then(r => (r.ok ? r.json() : null)),
  fetch("/api/catalog").then(r => (r.ok ? r.json() : null)),
])
  .then(([sess, cat]) => {
    if (cat?.parts) setCatalogParts(cat.parts);
    if (sess) {
      if (sess.pcb_url && !sameOriginStudio) pcbUrl = sess.pcb_url;
      connection.dataset.live = String(sess.live);
      connection.hidden = !!sess.live;
      connection.lastElementChild.textContent = sess.live ? "" : "Offline";
      leanBadge.dataset.ready = String(sess.lean_available);
      leanBadge.textContent = sess.lean_available ? "Lean 4 ready" : "Lean 4 unavailable";
      setLiveGeminiStatus(sess.live);
      if (sess.sample_brief) sampleBrief = sess.sample_brief;
    }
  })
  .catch(() => {
    connection.lastElementChild.textContent = "Server unavailable";
  });
