import { getPrototype, presentPrototype } from "./prototype.js";
import { applyResearchEvent, finishResearchMap, readResearch, showResearchMap } from "./research-map.js";

const form = document.querySelector("#composer");
const brief = document.querySelector("#brief");
const connection = document.querySelector("#connection");
const runButton = document.querySelector("#run");
const runLabel = document.querySelector("#run-label");
const sampleButton = document.querySelector("#run-sample");
const exampleButton = document.querySelector("#fill-example");
const feedback = document.querySelector("#feedback");
const resultSection = document.querySelector("#result");
const download = document.querySelector("#download");

let example = "Design a wrist-worn finger-gesture detector using muscle sensors for under $100 that sends gesture events to my laptop over Bluetooth Low Energy.";
let currentReport;
let pending = false;
let researchRequest;

const formatUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const checkLabels = {
  catalog_scope: "Catalog scope",
  core_parts: "Core parts",
  transport: "Connectivity",
  signal_interface: "Signal interface",
  nominal_sensor_supply: "Sensor supply",
  core_parts_budget: "Core parts budget",
  prototype_validation: "Prototype validation",
};
const statusLabels = { pass: "Passed", fail: "Flagged", unknown: "Needs validation" };
const reportLabels = { candidate: "Candidate design", blocked: "Design blocked", unsupported: "Outside catalog scope" };
const transportLabels = {
  ble: "Bluetooth Low Energy",
  wifi: "Wi-Fi",
  wired: "Wired",
  wireless: "Wireless",
  other: "Other",
  unspecified: "Unspecified",
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

if (/mac/i.test(navigator.userAgentData?.platform ?? navigator.platform)) {
  document.querySelector("#modifier").textContent = "⌘";
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function showFeedback(text) {
  feedback.textContent = text;
}

function sourceLink(label, url) {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) return element("span", label);
  const link = element("a", label);
  link.href = parsed.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function renderRequirements(requirements) {
  const facts = [["Connectivity", transportLabels[requirements.transport]]];
  if (requirements.budget_usd_cents !== null) {
    const prefix = requirements.budget_exclusive ? "Under " : "Up to ";
    facts.push(["Parts budget", prefix + formatUsd.format(requirements.budget_usd_cents / 100)]);
  }
  if (requirements.wrist_circumference_mm !== null) {
    facts.push(["Wrist circumference", requirements.wrist_circumference_mm + " mm"]);
  }
  if (requirements.gestures.length) {
    facts.push(["Gestures", requirements.gestures.join(", ")]);
  }
  document.querySelector("#requirements").replaceChildren(...facts.map(([label, value]) => {
    const fact = element("div", "");
    fact.append(element("dt", label), element("dd", value));
    return fact;
  }));
}

function renderReport(report) {
  currentReport = report;
  const review = report.review;
  const mode = report.mode === "offline" ? "Offline sample" : "Gemini research";
  document.querySelector("#result-mode").textContent = mode + " / " + reportLabels[review.status];
  document.querySelector("#result-brief").textContent = report.brief;
  renderRequirements(report.requirements);
  document.querySelector("#subtotal").textContent = review.core_subtotal_usd_cents === null
    ? "Core subtotal unavailable"
    : formatUsd.format(review.core_subtotal_usd_cents / 100) + " core subtotal";

  const parts = review.selected_parts.map(part => {
    const row = element("li", "");
    row.append(element("strong", part.name), element("small", part.manufacturer + " / " + part.sku));
    part.technical_sources.forEach((url, index) => {
      row.append(sourceLink(index ? "Technical source " + (index + 1) : "Technical source", url));
    });
    if (part.quote) {
      const label = formatUsd.format(part.quote.unit_price_usd_cents / 100) + " at " + part.quote.vendor;
      row.append(sourceLink(label, part.quote.url));
    }
    return row;
  });
  document.querySelector("#parts").replaceChildren(...(parts.length ? parts : [element("li", "No parts proposed")]));
  document.querySelector("#findings").replaceChildren(...review.findings.map(finding => {
    const row = element("li", "");
    const label = checkLabels[finding.check] ?? finding.check;
    row.append(element("strong", label + " · " + statusLabels[finding.status]), element("small", finding.detail));
    return row;
  }));
  const nextSteps = document.querySelector("#next-steps");
  nextSteps.replaceChildren(...report.review_notes.next_steps.map(step => element("li", step)));
  nextSteps.closest("section").hidden = !report.review_notes.next_steps.length;
  resultSection.hidden = false;
  presentPrototype(report.prototype, report.prototype_error);
  if (!reducedMotion.matches) {
    const sections = resultSection.querySelectorAll(".requirements, .report-grid, .next-steps:not([hidden])");
    sections.forEach((section, index) => {
      section.animate([{ opacity: 0.5, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
        duration: 205,
        delay: index * 40,
        easing: "cubic-bezier(.2,.72,.2,1)",
        fill: "backwards",
      });
    });
  }
}

function setBusy(busy, mode) {
  pending = busy;
  runButton.disabled = busy;
  runLabel.textContent = busy && mode === "live" ? "Researching…" : "Research design";
  sampleButton.disabled = busy;
  exampleButton.disabled = busy;
  brief.readOnly = busy;
  form.setAttribute("aria-busy", String(busy));
}

async function startResearch(mode) {
  if (pending) return;
  const value = brief.value.trim();
  if (mode === "live" && !value) {
    showFeedback("Enter a brief to start research.");
    brief.setAttribute("aria-invalid", "true");
    brief.focus();
    return;
  }
  brief.removeAttribute("aria-invalid");
  setBusy(true, mode);
  showFeedback("");
  resultSection.hidden = true;
  researchRequest = new AbortController();
  showResearchMap(mode, mode === "sample" ? example : value);
  try {
    const data = await readResearch(mode, value, researchRequest.signal, applyResearchEvent);
    renderReport(data);
    finishResearchMap("completed");
  } catch (error) {
    if (researchRequest.signal.aborted) {
      finishResearchMap("stopped", "You can edit the brief and run it again.");
    } else {
      const message = error instanceof TypeError ? "Could not reach FORGE. Check the server and try again." : error.message;
      finishResearchMap("failed", message);
    }
  } finally {
    researchRequest = null;
    setBusy(false);
  }
}

document.querySelector("#stop-research").addEventListener("click", () => researchRequest?.abort());
document.querySelector("#edit-brief").addEventListener("click", () => {
  document.querySelector("#brief-view").hidden = false;
  document.querySelector("#research-view").hidden = true;
  brief.focus();
});
document.querySelector("#view-research-report").addEventListener("click", event => {
  event.preventDefault();
  document.querySelector("#result-title").focus({ preventScroll: true });
  resultSection.scrollIntoView({ behavior: reducedMotion.matches ? "instant" : "smooth" });
});

form.addEventListener("submit", event => {
  event.preventDefault();
  startResearch("live");
});
brief.addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    form.requestSubmit();
  }
});
brief.addEventListener("input", () => {
  brief.removeAttribute("aria-invalid");
  if (!pending) showFeedback("");
});
exampleButton.addEventListener("click", () => {
  brief.value = example;
  brief.removeAttribute("aria-invalid");
  showFeedback("");
  brief.focus();
  brief.setSelectionRange(brief.value.length, brief.value.length);
});
sampleButton.addEventListener("click", () => startResearch("sample"));

function pressFeedback(event) {
  const button = event.currentTarget;
  if (reducedMotion.matches) return;
  const bounds = button.getBoundingClientRect();
  button.style.transformOrigin = (event.clientX - bounds.left) + "px " + (event.clientY - bounds.top) + "px";
}
[runButton, exampleButton, sampleButton].forEach(button => button.addEventListener("pointerdown", pressFeedback));

download.addEventListener("click", () => {
  if (!currentReport) return;
  const updatedReport = { ...currentReport, prototype: getPrototype() };
  const reportFile = new Blob([JSON.stringify(updatedReport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(reportFile);
  const link = element("a", "");
  link.href = url;
  link.download = "forge-research.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

fetch("/api/session")
  .then(response => {
    if (!response.ok) throw new Error("Session unavailable");
    return response.json();
  })
  .then(session => {
    connection.dataset.live = String(session.live);
    connection.lastElementChild.textContent = session.live ? "Gemini configured" : "Offline sample available";
    example = session.sample_brief;
  })
  .catch(() => { connection.lastElementChild.textContent = "Server unavailable"; });
