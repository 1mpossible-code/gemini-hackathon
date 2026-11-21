const svgNamespace = "http://www.w3.org/2000/svg";
const stages = {
  requirements: { label: "Requirements", kind: "Brief agent", tone: "green", copy: "Extract the design constraints.", icon: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6" },
  sourcing: { label: "Part sourcing", kind: "Sourcing agent", tone: "blue", copy: "Look up viable components.", icon: "m12 3 8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9" },
  controller: { label: "Controllers", kind: "Catalog tool", tone: "blue", copy: "Controller candidates.", icon: "M7 7h10v10H7z M9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4" },
  sensor: { label: "EMG sensors", kind: "Catalog tool", tone: "blue", copy: "Sensor candidates.", icon: "M3 12h4l3-7 4 14 3-7h4" },
  compatibility: { label: "Compatibility", kind: "Decision gate", tone: "amber", copy: "Check whether the parts work together.", icon: "m12 3 9 9-9 9-9-9z M9 12l2 2 4-5" },
  reviewer: { label: "Design review", kind: "Reviewer agent", tone: "violet", copy: "Surface open questions and next steps.", icon: "M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4" },
  hold: { label: "Build on hold", kind: "Decision branch", tone: "amber", copy: "Keep the report when the build cannot proceed.", icon: "M12 3 2.5 20h19z M12 9v5 M12 17h.01" },
  geometry: { label: "Build geometry", kind: "Model builder", tone: "blue", copy: "Assemble the enclosure and parts.", icon: "m4 9 8-5 8 5-8 5z M4 9v6l8 5 8-5V9 M12 14v6" },
  export: { label: "Export model", kind: "GLB output", tone: "green", copy: "Prepare the model for the 3D viewer.", icon: "M12 3v12m-4-4 4 4 4-4M5 15v6h14v-6" },
};
const connections = [
  ["requirements", "sourcing", "down"],
  ["sourcing", "controller", "branch"],
  ["sourcing", "sensor", "branch"],
  ["sourcing", "compatibility", "main"],
  ["compatibility", "reviewer", "main"],
  ["compatibility", "hold", "down"],
  ["reviewer", "geometry", "down"],
  ["geometry", "export", "down"],
];
const labels = {
  pending: "Queued",
  running: "Running",
  completed: "Complete",
  skipped: "Not run",
  failed: "Failed",
  stopped: "Stopped",
};
const outcomes = { candidate: "Candidate accepted", blocked: "Parts did not pass", unsupported: "Outside catalog scope" };
const budgets = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const smallScreen = matchMedia("(max-width: 850px)");
const $ = id => document.getElementById(id);
const network = $("map-network");
const wires = $("map-wires");
const detail = $("map-detail");
const mapStatus = $("map-status");
const follow = $("map-follow");
const log = $("map-log");
const state = new Map();
const cards = new Map();
let selected;
let current;
let followLive = true;
let startedAt;
let zoom = 1;
let runState = "idle";

function text(tag, contents, className) {
  const element = document.createElement(tag);
  element.textContent = contents;
  if (className) element.className = className;
  return element;
}

function icon(outline) {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svgNamespace, "path");
  path.setAttribute("d", outline);
  svg.append(path);
  return svg;
}

for (const [id, stage] of Object.entries(stages)) {
  const button = text("button", "", "map-card");
  button.type = "button";
  button.id = "map-card-" + id;
  button.dataset.stage = id;
  button.dataset.tone = stage.tone;
  button.setAttribute("aria-pressed", "false");
  const glyph = text("span", "", "map-glyph");
  glyph.append(icon(stage.icon));
  const body = text("span", "", "map-card-body");
  const status = text("span", "", "map-card-state");
  const meta = text("span", "", "map-card-meta");
  body.append(text("span", stage.kind, "map-card-kind"), text("strong", stage.label), meta, status);
  button.append(glyph, body);
  button.addEventListener("click", () => {
    setFollow(false);
    select(id);
    if (smallScreen.matches) {
      const inspector = $("map-inspector");
      inspector.focus({ preventScroll: true });
      inspector.scrollIntoView({ block: "nearest" });
    }
  });
  network.append(button);
  cards.set(id, { button, status, meta });
}

function updateCard(id) {
  const { button, status, meta } = cards.get(id);
  const { status: phase, summary } = state.get(id);
  button.dataset.status = phase;
  status.textContent = labels[phase];
  meta.textContent = summary || stages[id].copy;
}

function drawWires() {
  const graph = network.getBoundingClientRect();
  if (!graph.width || !graph.height) return;
  const width = network.clientWidth;
  const height = network.clientHeight;
  wires.setAttribute("viewBox", "0 0 " + width + " " + height);
  const compact = matchMedia("(max-width: 650px)").matches;
  function bounds(id) {
    const rect = cards.get(id).button.getBoundingClientRect();
    return {
      x: (rect.left - graph.left) * width / graph.width,
      y: (rect.top - graph.top) * height / graph.height,
      w: rect.width * width / graph.width,
      h: rect.height * height / graph.height,
    };
  }
  const paths = connections.map(([from, to, shape]) => {
    const a = bounds(from);
    const b = bounds(to);
    const path = document.createElementNS(svgNamespace, "path");
    const down = shape === "down" || compact;
    const aX = down ? a.x + a.w / 2 : shape === "branch" ? a.x : a.x + a.w;
    const aY = down ? a.y + a.h : a.y + a.h / 2;
    const bX = down ? b.x + b.w / 2 : b.x;
    const bY = down ? b.y : b.y + b.h / 2;
    let route;
    if (compact && to === "hold") {
      const margin = a.x - 8;
      route = "M" + a.x + "," + (a.y + a.h / 2) + " H" + margin + " V" + (b.y - 8) + " H" + bX + " V" + bY;
    } else if (down) {
      const bend = aY + Math.min(22, (bY - aY) / 2);
      route = "M" + aX + "," + aY + " C" + aX + "," + bend + " " + bX + "," + bend + " " + bX + "," + bY;
    } else if (shape === "branch") {
      route = "M" + aX + "," + aY + " C" + (aX - 26) + "," + aY + " " + (bX - 26) + "," + bY + " " + bX + "," + bY;
    } else {
      const center = (aX + bX) / 2;
      route = "M" + aX + "," + aY + " C" + center + "," + aY + " " + center + "," + bY + " " + bX + "," + bY;
    }
    path.setAttribute("d", route);
    path.dataset.status = state.get(to).status;
    path.dataset.tone = stages[to].tone;
    path.classList.toggle("branch-wire", shape === "branch" || to === "hold");
    return path;
  });
  wires.replaceChildren(...paths);
}

const resize = new ResizeObserver(() => requestAnimationFrame(drawWires));
resize.observe(network);
for (const { button } of cards.values()) resize.observe(button);
smallScreen.addEventListener("change", drawWires);

function select(id) {
  if (selected) cards.get(selected).button.setAttribute("aria-pressed", "false");
  selected = id;
  cards.get(id).button.setAttribute("aria-pressed", "true");
  renderDetail();
}

function setFollow(value) {
  followLive = value;
  follow.setAttribute("aria-pressed", String(value));
  if (value && current) select(current);
}
follow.addEventListener("click", () => setFollow(!followLive));
$("map-back").addEventListener("click", () => cards.get(selected).button.focus());

function setZoom(value) {
  zoom = Math.max(0.8, Math.min(1.4, value));
  network.style.zoom = zoom;
  $("map-fit").textContent = Math.round(zoom * 100) + "%";
  $("map-out").disabled = zoom <= 0.8;
  $("map-in").disabled = zoom >= 1.4;
  requestAnimationFrame(drawWires);
}
$("map-out").addEventListener("click", () => setZoom(Math.round((zoom - 0.1) * 10) / 10));
$("map-in").addEventListener("click", () => setZoom(Math.round((zoom + 0.1) * 10) / 10));
$("map-fit").addEventListener("click", () => {
  setZoom(1);
  $("map-viewport").scrollTo(0, 0);
});

function showStatus(value, label) {
  runState = value;
  mapStatus.dataset.status = value;
  mapStatus.lastElementChild.textContent = label;
}

function addLog(label, contents) {
  const row = text("li", "");
  const time = ((performance.now() - startedAt) / 1000).toFixed(1) + "s";
  const content = text("div", "");
  content.append(text("strong", label), text("span", contents));
  row.append(text("time", time), content);
  const followsBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
  log.append(row);
  if (followsBottom) log.scrollTop = log.scrollHeight;
}

function safeLink(url, index) {
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" && target.protocol !== "http:") return null;
    const link = text("a", "Source " + (index + 1) + " · " + target.hostname);
    link.href = target.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  } catch {
    return null;
  }
}

function appendEntries(lines) {
  if (!lines.length) return;
  const list = text("ul", "", "map-evidence");
  list.append(...lines.map(line => text("li", line)));
  detail.append(list);
}

function renderDetail() {
  const stage = stages[selected];
  const step = state.get(selected);
  const data = step.data ?? {};
  detail.replaceChildren(text("h3", stage.label), text("span", labels[step.status], "map-step-status"));
  detail.append(text("p", step.detail || stage.copy));
  if (selected === "requirements") {
    appendEntries([
      data.transport && "Connectivity: " + ({ ble: "Bluetooth Low Energy", wifi: "Wi-Fi", wired: "Wired", wireless: "Wireless" }[data.transport] ?? data.transport),
      Number.isFinite(data.budget_usd_cents) && "Budget: " + (data.budget_exclusive ? "under " : "") + budgets.format(data.budget_usd_cents / 100),
      Number.isFinite(data.wrist_circumference_mm) && "Wrist size: " + data.wrist_circumference_mm + " mm",
      ...(data.gestures ?? []),
      ...(data.unresolved ?? []),
    ].filter(Boolean));
  }
  if (selected === "sourcing") {
    appendEntries([data.controller_id, data.sensor_id, data.rationale].filter(Boolean));
  }
  if (selected === "controller" || selected === "sensor") {
    const chosen = state.get("sourcing").data;
    const chosenId = selected === "controller" ? chosen?.controller_id : chosen?.sensor_id;
    for (const part of step.parts ?? []) {
      const item = text("div", "", "map-part");
      item.append(text("strong", part.name), text("span", part.sku + (chosenId ? (chosenId === part.id ? " · Selected" : " · Alternative") : "")));
      for (const [index, url] of (part.technical_sources ?? []).entries()) {
        const link = safeLink(url, index);
        if (link) item.append(link);
      }
      detail.append(item);
    }
  }
  if (selected === "compatibility" || selected === "geometry") {
    if (data.outcome) detail.append(text("strong", outcomes[data.outcome] ?? data.outcome, "map-outcome"));
    if (Number.isFinite(data.core_subtotal_usd_cents)) {
      detail.append(text("p", "Parts subtotal: " + budgets.format(data.core_subtotal_usd_cents / 100)));
    }
    appendEntries((data.findings ?? []).map(finding => finding.detail ?? String(finding)));
  }
  if (selected === "reviewer") appendEntries(data.next_steps ?? []);
  if (selected === "export" && data.format) {
    appendEntries([data.format + (Number.isFinite(data.byte_count) ? " · " + Math.round(data.byte_count / 1024) + " KiB" : "")]);
  }
}

function update(id, status, message, data, summary, options = {}) {
  const step = state.get(id);
  Object.assign(step, { status, detail: message ?? step.detail, data: data ?? step.data, summary: summary ?? step.summary });
  updateCard(id);
  if (options.focus) {
    current = id;
    if (followLive) select(id);
  }
  if (selected === id || (id === "sourcing" && ["controller", "sensor"].includes(selected))) renderDetail();
  if (options.log) addLog(stages[id].label, message || labels[status]);
  requestAnimationFrame(drawWires);
}

export function showResearchMap(mode, brief) {
  startedAt = performance.now();
  current = "requirements";
  selected = null;
  for (const id of Object.keys(stages)) {
    state.set(id, { status: "pending" });
    cards.get(id).button.setAttribute("aria-pressed", "false");
    updateCard(id);
  }
  $("brief-view").hidden = true;
  $("research-view").hidden = false;
  $("view-research-report").hidden = true;
  $("edit-brief").hidden = true;
  $("stop-research").hidden = false;
  $("map-brief").textContent = brief;
  $("map-mode").textContent = mode === "sample" ? "Offline sample" : "Gemini workflow";
  log.replaceChildren();
  setFollow(true);
  setZoom(1);
  $("map-viewport").scrollTo(0, 0);
  showStatus("running", "Starting research");
  $("research-title").focus();
  addLog("Run requested", "Waiting for the research service.");
}

export function applyResearchEvent(event) {
  if (event.type === "run") {
    showStatus("running", "Research in progress");
    return;
  }
  if (event.type === "catalog_lookup") {
    const id = { controller: "controller", emg_sensor: "sensor" }[event.role];
    if (!id || !Array.isArray(event.parts)) return;
    const step = state.get(id);
    const byId = new Map((step.parts ?? []).map(part => [part.id, part]));
    event.parts.forEach(part => byId.set(part.id, part));
    step.parts = [...byId.values()];
    const count = step.parts.length;
    update(id, "completed", count + (count === 1 ? " catalog entry returned." : " catalog entries returned."), null, count + (count === 1 ? " candidate" : " candidates"), { log: true });
    return;
  }
  if (event.type !== "stage" || !state.has(event.stage) || !labels[event.status]) return;
  const { stage, status, detail: message, data } = event;
  let summary;
  if (stage === "compatibility" && data?.outcome) {
    summary = outcomes[data.outcome];
    const hold = data.outcome !== "candidate";
    update("hold", hold ? "completed" : "skipped", hold ? summary + ". The research report remains available." : "The candidate cleared the compatibility gate.", null, hold ? summary : "Candidate cleared to build");
  }
  if (stage === "geometry" && Number.isFinite(data?.node_count)) summary = data.node_count + " assembly nodes";
  if (stage === "geometry" && ["skipped", "failed"].includes(status) && state.get("hold").status !== "completed") {
    update("hold", "completed", message || "The prototype could not be built. See the geometry findings.", null, "No model generated");
  }
  if (stage === "export" && data?.format) summary = data.format + " ready";
  if (stage === "requirements" && status === "completed" && data?.transport === "ble") summary = "BLE constraints captured";
  update(stage, status, message, data, summary, { focus: status === "running" || (status === "failed" && runState === "running"), log: true });
}

export function finishResearchMap(outcome, message) {
  const descriptions = { completed: "Run complete", failed: "Run failed", stopped: "Run stopped" };
  for (const id of state.keys()) {
    const { status } = state.get(id);
    if (status === "pending") update(id, "skipped", "This step did not run.");
    if (status === "running") update(id, outcome === "stopped" ? "stopped" : "failed", message);
  }
  showStatus(outcome, descriptions[outcome] + (message ? " · " + message : ""));
  addLog(descriptions[outcome], message || "The report is ready.");
  const stoppedFromButton = document.activeElement === $("stop-research");
  $("stop-research").hidden = true;
  $("edit-brief").hidden = false;
  $("view-research-report").hidden = outcome !== "completed";
  if (stoppedFromButton) $("edit-brief").focus();
}

export async function readResearch(mode, brief, signal, onEvent) {
  const response = await fetch("/api/research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mode === "sample" ? { mode } : { mode, brief }),
    signal,
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error("This Studio server needs a restart to load the research map.");
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === "string" ? error.detail : "Could not start research. Check the brief and try again.");
  }
  if (!response.body) throw new Error("The research stream could not be opened.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  function readLine(line) {
    if (!line.trim()) return null;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("FORGE returned an unreadable research event.");
    }
    if (event.type === "error") throw new Error(event.message || "Research could not finish.");
    if (event.type === "report") return event.report;
    onEvent(event);
    return null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const report = readLine(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (report) return report;
      }
      if (done) {
        const report = readLine(buffer);
        if (report) return report;
        throw new Error("The research stream ended before the report arrived. Try again.");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
