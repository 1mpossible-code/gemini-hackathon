// Research run as four phases: Input -> Researching -> Parsing -> Generation.
// The phase rail sits under the bar; live work opens as windows on the desk
// over the graph: one browser per swarm agent, one per source document being
// parsed (Pangram + Reducto), one per compute worker (Modal VM or local
// fallback) and a 3D model viewer. Everything shown comes from stream events.
import {
  Box3,
  Color,
  DirectionalLight,
  GLTFLoader,
  HemisphereLight,
  OrbitControls,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "./vendor/three-runtime.js";

const PHASES = [
  { id: "input", label: "User input", items: [["brief", "Brief"], ["mode", "Run mode"]] },
  { id: "research", label: "Researching", items: [["swarm", "Agent swarm"], ["catalog", "Catalog + review"]] },
  { id: "parsing", label: "Parsing", items: [["pangram", "Pangram scan"], ["reducto", "Reducto parse"], ["crosscheck", "Evidence check"]] },
  { id: "generation", label: "Generation", items: [["assembly", "Assembly"], ["cloud", "Modal VM"], ["export", "Export + verify"]] },
];
const RESEARCH_STAGES = new Set(["requirements", "sourcing", "controller", "sensor", "compatibility", "reviewer"]);
const DONE = new Set(["completed", "failed", "skipped", "cancelled", "accepted", "excluded", "error", "unverified"]);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = id => document.getElementById(id);
function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
const pct = x => (x == null ? "—" : Math.round(x * 100) + "%");
const secs = s => (s == null ? "—" : s < 10 ? s.toFixed(1) + " s" : Math.round(s) + " s");
const kb = n => (n == null ? "—" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " kB");

let state = null;
let tick = 0;

function fresh(mode, brief) {
  const items = {};
  for (const phase of PHASES) for (const [id] of phase.items) items[id] = { status: "pending", note: "" };
  return { mode, brief, started: performance.now(), phases: {}, items, windows: new Map(), order: 0, docs: 0, models: [], viewer: null };
}

// ---------- phase rail ----------
function phaseStatus(phase) {
  const list = phase.items.map(([id]) => state.items[id].status);
  if (list.some(s => s === "running")) return "running";
  if (list.every(s => DONE.has(s))) {
    if (list.some(s => s === "failed")) return "failed";
    return list.every(s => s === "skipped") ? "skipped" : "completed";
  }
  if (list.some(s => DONE.has(s))) return "running";
  return "pending";
}

function renderRail() {
  const rail = $("pd-rail");
  if (!rail || !state) return;
  rail.replaceChildren(...PHASES.map((phase, i) => {
    const status = phaseStatus(phase);
    const col = h("li", "pd-phase");
    col.dataset.status = status;
    const head = h("div", "pd-phase-head");
    head.append(h("span", "pd-num", String(i + 1).padStart(2, "0")), h("strong", null, phase.label), h("span", "pd-state", status));
    const list = h("ul", "pd-items");
    for (const [id, label] of phase.items) {
      const item = state.items[id];
      const row = h("li", "pd-item");
      row.dataset.status = item.status;
      row.append(h("span", "pd-dot"), h("span", "pd-item-label", label), h("span", "pd-item-note", item.note || item.status));
      list.append(row);
    }
    col.append(head, list);
    return col;
  }));
  const running = PHASES.find(p => phaseStatus(p) === "running");
  $("pd-current").textContent = running ? running.label : PHASES.every(p => DONE.has(phaseStatus(p))) ? "Done" : "Queued";
}

function setItem(id, status, note) {
  const item = state.items[id];
  // A finished item only moves on to another finished state (e.g. a later failure).
  if ((item.status === "completed" || item.status === "failed") && !DONE.has(status)) return;
  item.status = status;
  if (note != null) item.note = note;
  renderRail();
}

// ---------- desk windows ----------
function desk() {
  return $("pd-desk");
}

function layout() {
  const area = desk();
  if (!area || !state) return;
  const W = area.clientWidth;
  const H = area.clientHeight;
  const open = [...state.windows.values()].filter(w => !w.minimized && !w.dragged);
  const cols = Math.max(1, Math.min(4, Math.floor(W / 300)));
  const width = Math.min(380, (W - 16 * (cols + 1)) / cols);
  open.forEach((win, i) => {
    const big = win.kind === "model";
    const col = i % cols;
    const row = Math.floor(i / cols);
    const height = big ? Math.min(360, H - 60) : 224;
    win.node.style.width = (big ? Math.min(W - 32, width * 2 + 16) : width) + "px";
    win.node.style.height = height + "px";
    const left = big ? W - Math.min(W - 32, width * 2 + 16) - 16 : 16 + col * (width + 16);
    const top = big ? 16 : 16 + row * 238 + (i % 2) * 8;
    win.node.style.transform = `translate(${Math.max(8, left)}px, ${Math.min(Math.max(8, top), Math.max(8, H - height - 48))}px)`;
  });
  renderDock();
}

function renderDock() {
  const dock = $("pd-dock");
  if (!dock) return;
  const mins = [...state.windows.values()].filter(w => w.minimized);
  dock.hidden = mins.length === 0;
  dock.replaceChildren(...mins.map(win => {
    const chip = h("button", "pd-chip", win.title);
    chip.type = "button";
    chip.dataset.status = win.status;
    chip.addEventListener("click", () => setMinimized(win, false));
    return chip;
  }));
}

function setMinimized(win, minimized) {
  win.minimized = minimized;
  win.node.hidden = minimized;
  if (!minimized) {
    win.dragged = false;
    desk().append(win.node); // bring to front
  }
  layout();
}

function minimizeKind(kinds) {
  // Only tuck away finished windows; anything still streaming stays on the desk.
  for (const win of state.windows.values()) if (kinds.includes(win.kind) && !win.minimized && win.status !== "running" && win.status !== "pending") {
    win.minimized = true;
    win.node.hidden = true;
  }
  layout();
}

function drag(win, handle) {
  handle.addEventListener("pointerdown", event => {
    if (event.target.closest("button")) return;
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(win.node.style.transform) || [0, 0, 0];
    const start = { x: event.clientX, y: event.clientY, left: +match[1], top: +match[2] };
    handle.setPointerCapture(event.pointerId);
    desk().append(win.node);
    const move = e => {
      win.dragged = true;
      win.node.style.transform = `translate(${start.left + e.clientX - start.x}px, ${start.top + e.clientY - start.y}px)`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

function openWindow(key, kind, title, url) {
  let win = state.windows.get(key);
  if (win) return win;
  const node = h("article", "pd-win");
  node.dataset.kind = kind;
  node.dataset.status = "running";
  node.style.setProperty("--delay", (state.order++ % 6) * 70 + "ms");
  const bar = h("header", "pd-win-bar");
  const lights = h("span", "pd-lights");
  lights.append(h("i"), h("i"), h("i"));
  const name = h("span", "pd-win-title", title);
  const min = h("button", "pd-win-min", "–");
  min.type = "button";
  min.setAttribute("aria-label", "Minimize " + title);
  bar.append(lights, name, min);
  const address = h("div", "pd-url");
  address.append(h("span", "pd-lock", kind === "vm" ? "vm" : kind === "doc" ? "pdf" : "tls"), h("span", "pd-url-text", url));
  const load = h("div", "pd-load");
  const body = h("div", "pd-win-body");
  const foot = h("footer", "pd-win-foot");
  node.append(bar, address, load, body, foot);
  win = { key, kind, title, node, body, foot, url: address.lastChild, status: "running", minimized: false, dragged: false };
  min.addEventListener("click", () => setMinimized(win, true));
  drag(win, bar);
  state.windows.set(key, win);
  desk().append(node);
  layout();
  return win;
}

function setWinStatus(win, status) {
  win.status = status;
  win.node.dataset.status = status;
  renderDock();
}

// ---------- researching: agent browsers ----------
function agentWindow(index, agent) {
  const win = openWindow("agent-" + index, "agent", agent.name || agent.role, `forge://swarm/${agent.role}${state.swarmModel ? "?model=" + state.swarmModel : ""}`);
  if (!win.focus) {
    win.focus = h("p", "pd-focus", agent.focus || "");
    win.stream = h("pre", "pd-stream", "Waiting for dispatch…");
    win.body.append(win.focus, win.stream);
  }
  return win;
}

function onSwarm(event) {
  if (event.event === "start") {
    state.swarmModel = event.model;
    state.agents = (event.agents ?? []).map(a => ({ role: a.id, name: a.name, focus: a.focus }));
    setItem("swarm", "running", `${state.agents.length} agents · ${event.engine === "gemini" ? event.model : "offline replay"}`);
    state.agents.forEach((agent, i) => {
      const win = agentWindow(i, agent);
      setWinStatus(win, "pending");
      win.foot.textContent = "queued";
    });
  } else if (event.event === "agent") {
    const agent = state.agents?.[event.index] ?? { role: event.role, name: event.role };
    const win = agentWindow(event.index, agent);
    const result = event.result;
    setWinStatus(win, event.status);
    if (event.status === "running") {
      win.stream.textContent = event.text ? "…" + event.text : "Reasoning…";
      win.stream.dataset.live = "true";
      win.foot.textContent = "streaming";
    } else {
      win.stream.dataset.live = "false";
      win.stream.textContent = result?.summary || result?.text || event.text || "No brief returned.";
      const tokens = (result?.input_tokens ?? 0) + (result?.output_tokens ?? 0);
      win.foot.textContent = [event.status, secs(result?.duration_s), tokens ? tokens.toLocaleString() + " tok" : null].filter(Boolean).join(" · ");
    }
    const done = [...state.windows.values()].filter(w => w.kind === "agent" && DONE.has(w.status)).length;
    setItem("swarm", "running", `${done}/${state.agents?.length ?? 4} agents done`);
  } else if (event.event === "synthesis") {
    const lead = openWindow("lead", "agent", "Lead engineer · synthesis", "forge://swarm/lead");
    if (!lead.stream) {
      lead.stream = h("pre", "pd-stream", "Merging specialist briefs…");
      lead.body.append(lead.stream);
    }
    setWinStatus(lead, event.status);
    if (event.text) lead.stream.textContent = event.text;
    lead.foot.textContent = event.status;
  } else if (event.event === "complete") {
    const report = event.report ?? {};
    setItem("swarm", report.status === "failed" ? "failed" : "completed", `${report.agents?.length ?? 0} briefs merged`);
    if (state.items.assembly.status !== "pending") minimizeKind(["agent", "doc"]);
  }
}

// ---------- parsing: document windows ----------
function meter(label, value, cls) {
  const row = h("div", "pd-meter " + (cls || ""));
  const bar = h("span", "pd-meter-bar");
  const fill = h("i");
  fill.style.width = value == null ? "0%" : Math.round(value * 100) + "%";
  bar.append(fill);
  row.append(h("span", "pd-meter-k", label), bar, h("b", null, pct(value)));
  return row;
}

function docWindow(doc, partId) {
  const key = "doc-" + (doc.url || doc.title);
  const fresh = !state.windows.has(key);
  const win = openWindow(key, "doc", doc.title || "Datasheet", doc.url || "");
  if (fresh) {
    state.docs++;
    win.body.append(h("p", "pd-focus", partId ? "Part · " + partId : "Source document"));
    win.scan = h("div", "pd-scan");
    win.scan.append(h("span", null, "Pangram authorship scan"), h("span", null, "Reducto table + figure parse"));
    win.body.append(win.scan);
    win.foot.textContent = "reading";
  }
  return win;
}

function onSource(event) {
  if (event.event === "reading") {
    setItem("pangram", "running", "scanning");
    setItem("reducto", "running", "parsing");
    const win = docWindow({ url: event.url, title: event.title }, event.part_id);
    win.foot.textContent = `round ${event.round ?? 1} · reading`;
  } else if (event.event === "decision") {
    const src = event.source ?? {};
    const win = docWindow(src.document ?? {}, src.part_id);
    const facts = Array.isArray(src.facts) ? src.facts.length : src.facts ?? null;
    win.scan?.remove();
    const result = h("div", "pd-doc");
    result.append(
      meter("AI-generated", src.ai_fraction, "is-ai"),
      meter("AI-assisted", src.ai_assisted_fraction, "is-assist"),
    );
    const parsed = h("p", "pd-facts");
    parsed.append(h("span", "pd-tag", "Reducto"), document.createTextNode(src.parsed ? `${facts ?? 0} facts extracted` : "not parsed"));
    const verdict = h("p", "pd-verdict", src.decision);
    verdict.dataset.decision = src.decision;
    result.append(parsed, verdict);
    if (src.reason) result.append(h("p", "pd-reason", src.reason));
    win.body.append(result);
    setWinStatus(win, src.decision === "accepted" ? "completed" : src.decision === "error" ? "failed" : "warning");
    win.foot.textContent = `${src.decision} · ${src.scans ?? 0} scan${src.scans === 1 ? "" : "s"}`;
    const docs = [...state.windows.values()].filter(w => w.kind === "doc");
    const accepted = docs.filter(w => w.status === "completed").length;
    setItem("pangram", "running", `${docs.length} docs scanned`);
    setItem("reducto", "running", `${accepted} accepted`);
  } else if (event.event === "retry") {
    setItem("pangram", "running", "retry round " + (event.round ?? ""));
  } else if (event.event === "complete") {
    const audit = event.audit ?? {};
    const status = audit.status === "accepted" ? "completed" : audit.status === "needs_review" ? "skipped" : "failed";
    setItem("pangram", status, audit.status === "needs_review" ? "keys missing / review" : `${audit.sources?.length ?? state.docs} docs`);
    setItem("reducto", status, `${audit.rounds ?? 1} round${audit.rounds === 1 ? "" : "s"}`);
  }
}

// ---------- generation: compute VMs + model ----------
function vmWindow(event) {
  const cloud = event.provider === "modal";
  const win = openWindow("vm-" + event.job, "vm", event.label || (cloud ? "Modal CAD worker" : "Local worker"), cloud ? `modal://forge-cad/${event.function || "generate_enclosure"}` : `local://${location.hostname}/${event.job}`);
  if (!win.spec) {
    const res = event.resources ?? {};
    win.spec = h("dl", "pd-spec");
    for (const [k, v] of [["CPU", res.cpu != null ? res.cpu + " vCPU" : "—"], ["Memory", res.memory_mb ? res.memory_mb / 1024 + " GiB" : "host"], ["GPU", res.gpu || "none (CPU CAD)"], ["Timeout", res.timeout_s ? res.timeout_s + " s" : "—"]]) {
      win.spec.append(h("dt", null, k), h("dd", null, v));
    }
    win.log = h("ol", "pd-log");
    win.clock = h("b", "pd-clock", "0.0 s");
    win.t0 = performance.now();
    win.body.append(win.spec, win.log);
    win.foot.replaceChildren(win.clock);
  }
  return win;
}

function onCompute(event) {
  if (event.event === "ready") {
    loadModel(event.glb_url, "Enclosure · " + event.provider);
    return;
  }
  const cloud = event.provider === "modal";
  const item = event.job === "local-assembly" ? "assembly" : "cloud";
  if (event.event === "skipped") {
    setItem(item, "skipped", "not configured");
    return;
  }
  const win = vmWindow(event);
  win.log.append(h("li", null, event.detail || event.event));
  if (event.event === "provision" || event.event === "running") {
    setWinStatus(win, "running");
    setItem(item, "running", cloud ? "container " + event.event : event.event);
    if (event.event === "provision") win.t0 = performance.now();
  } else {
    win.done = true;
    const stats = event.stats ?? {};
    win.clock.textContent = secs(stats.elapsed_s ?? (performance.now() - win.t0) / 1000);
    setWinStatus(win, event.event === "completed" ? "completed" : event.event === "cancelled" ? "warning" : "failed");
    if (event.event === "completed") {
      const out = h("dl", "pd-spec pd-out");
      for (const [k, v] of [["Elapsed", secs(stats.elapsed_s)], ["Triangles", stats.triangles?.toLocaleString() ?? "—"], ["Nodes", Array.isArray(stats.nodes) ? stats.nodes.length : stats.nodes ?? "—"], ["GLB", kb(stats.bytes?.glb)], ["Cache", stats.cache_hit ? "hit" : "miss"]]) {
        out.append(h("dt", null, k), h("dd", null, String(v)));
      }
      win.body.append(out);
      setItem(item, "completed", cloud ? `modal · ${secs(stats.elapsed_s)}` : `${event.job === "local-assembly" ? "assembly" : "local fallback"} · ${secs(stats.elapsed_s)}`);
      if (event.glb_url) loadModel(event.glb_url, "Assembly");
    } else if (event.event === "cancelled") {
      setItem("cloud", "running", "Modal cancelled → local");
    } else {
      setItem(item, "failed", "failed");
    }
  }
}

function onStage(event) {
  const { stage, status } = event;
  if (RESEARCH_STAGES.has(stage)) {
    const running = status === "running";
    setItem("catalog", stage === "reviewer" && DONE.has(status) ? (status === "failed" ? "failed" : "completed") : "running", running ? stage : `${stage} ${status}`);
  } else if (stage === "evidence") {
    setItem("crosscheck", status, event.detail ? event.detail.slice(0, 48) : status);
  } else if (stage === "geometry") {
    for (const id of ["pangram", "reducto", "crosscheck"]) if (state.items[id].status === "pending") setItem(id, "skipped", "not in this run");
    if (status === "running") minimizeKind(["agent", "doc"]);
    if (status !== "completed") setItem("assembly", status, event.detail?.slice(0, 48));
  } else if (stage === "export") {
    state.exported = status;
    exportItem();
  }
  if (stage === "evidence" && status === "running") minimizeKind(["agent"]);
}

function exportItem() {
  const ex = state.exported;
  const lean = state.lean;
  if (ex === "failed") return setItem("export", "failed", "GLB export failed");
  const done = ex === "completed" && lean && lean !== "running";
  setItem("export", done ? "completed" : "running", [ex === "completed" ? "GLB ready" : "packaging", lean ? "Lean " + lean : null].filter(Boolean).join(" · "));
}

// ---------- model viewer ----------
function modelWindow() {
  const win = openWindow("model", "model", "Generated model", "forge://viewer");
  if (!state.viewer) {
    const stage = h("div", "pd-gl");
    const tabs = h("div", "pd-tabs");
    win.body.append(tabs, stage);
    state.viewer = createViewer(stage);
    state.viewer.tabs = tabs;
  }
  return win;
}

function loadModel(url, label) {
  if (!url || !state) return;
  if (!state.models.some(m => m.url === url)) state.models.push({ url, label });
  const win = modelWindow();
  setWinStatus(win, "running");
  win.foot.textContent = "loading " + label;
  const viewer = state.viewer;
  const show = model => {
    viewer.tabs.replaceChildren(...state.models.map(m => {
      const tab = h("button", "pd-tab", m.label);
      tab.type = "button";
      tab.setAttribute("aria-pressed", String(m.url === model.url));
      tab.addEventListener("click", () => show(m));
      return tab;
    }));
    viewer.load(model.url).then(info => {
      setWinStatus(win, "completed");
      win.foot.textContent = `${model.label} · ${info.meshes} meshes · ${info.size}`;
    }, () => {
      setWinStatus(win, "failed");
      win.foot.textContent = "Could not load " + model.label;
    });
  };
  show(state.models.at(-1));
}

function createViewer(host) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  host.append(renderer.domElement);
  const scene = new Scene();
  scene.add(new HemisphereLight(0xffffff, 0x202020, 2.2));
  const key = new DirectionalLight(0xffffff, 2.4);
  key.position.set(1, 2, 1.5);
  scene.add(key);
  const camera = new PerspectiveCamera(32, 1, 0.001, 50);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = !reduceMotion;
  controls.autoRotateSpeed = 2.4;
  const loader = new GLTFLoader();
  let root = null;
  let parts = [];
  let token = 0;
  let frame = 0;
  const t0 = performance.now();

  function resize() {
    const w = host.clientWidth || 300;
    const hgt = host.clientHeight || 200;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }

  function loop() {
    frame = requestAnimationFrame(loop);
    if (!host.isConnected) return;
    resize();
    const t = (performance.now() - t0) / 1000;
    if (!reduceMotion) {
      // Explode and re-assemble on a loop; each part on its own phase.
      for (const p of parts) {
        const k = 0.5 - 0.5 * Math.cos(t * 1.3 + p.phase);
        p.object.position.copy(p.home).addScaledVector(p.dir, p.reach * k);
        p.object.rotation.set(p.rot.x, p.rot.y + Math.sin(t * 0.9 + p.phase) * 0.25 * k, p.rot.z);
      }
    }
    controls.update();
    renderer.render(scene, camera);
  }
  loop();

  return {
    async load(url) {
      const mine = ++token;
      const gltf = await loader.loadAsync(url);
      if (mine !== token) return { meshes: 0, size: "" };
      if (root) scene.remove(root);
      root = gltf.scene;
      scene.add(root);
      const box = new Box3().setFromObject(root);
      const centre = box.getCenter(new Vector3());
      const size = box.getSize(new Vector3());
      const radius = Math.max(size.length() / 2, 1e-3);
      parts = [];
      let meshes = 0;
      root.traverse(o => { if (o.isMesh) meshes++; });
      // Animate the top-level parts (or the root's children when wrapped in one node).
      let top = root.children;
      while (top.length === 1 && top[0].children.length) top = top[0].children;
      top.forEach((object, i) => {
        const b = new Box3().setFromObject(object);
        const c = b.isEmpty() ? centre.clone() : b.getCenter(new Vector3());
        const dir = c.sub(centre);
        if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
        dir.normalize();
        dir.y = Math.abs(dir.y) + 0.35;
        dir.normalize();
        parts.push({ object, home: object.position.clone(), rot: object.rotation.clone(), dir, reach: radius * 0.45, phase: i * 0.45 });
      });
      root.traverse(o => {
        if (o.isMesh && o.material && "emissive" in o.material && o.material.emissive) o.material.emissive = new Color(0x050505);
      });
      controls.target.copy(centre);
      camera.position.copy(centre).add(new Vector3(radius * 1.9, radius * 1.3, radius * 2.3));
      camera.near = radius / 100;
      camera.far = radius * 40;
      camera.updateProjectionMatrix();
      return { meshes, size: `${(size.x * 1000).toFixed(0)}×${(size.z * 1000).toFixed(0)}×${(size.y * 1000).toFixed(0)} mm` };
    },
    dispose() {
      cancelAnimationFrame(frame);
      renderer.dispose();
    },
  };
}

// ---------- public API ----------
export function resetDeck(mode, brief) {
  if (state?.viewer) state.viewer.dispose();
  desk()?.replaceChildren();
  state = fresh(mode, brief);
  $("pd-deck").hidden = false;
  $("pd-deck").dataset.status = "running";
  setItem("brief", "completed", (brief || "sample brief").slice(0, 40) + ((brief || "").length > 40 ? "…" : ""));
  setItem("mode", "completed", mode === "sample" ? "offline sample" : "live");
  clearInterval(tick);
  tick = setInterval(() => {
    if (!state) return;
    $("pd-clock").textContent = secs((performance.now() - state.started) / 1000);
    for (const win of state.windows.values()) {
      if (win.kind === "vm" && !win.done && win.clock) win.clock.textContent = secs((performance.now() - win.t0) / 1000);
    }
  }, 100);
  renderRail();
}

export function applyDeckEvent(event) {
  if (!state) return;
  if (event.type === "swarm") onSwarm(event);
  else if (event.type === "source_audit") onSource(event);
  else if (event.type === "compute") onCompute(event);
  else if (event.type === "stage") onStage(event);
  else if (event.type === "verification") {
    state.lean = event.status === "completed" ? event.data?.status ?? "done" : event.status;
    exportItem();
  }
  else if (event.type === "catalog_lookup") setItem("catalog", "running", `${event.role} · ${event.parts?.length ?? 0} candidates`);
}

export function finishDeck(outcome, report) {
  if (!state) return;
  clearInterval(tick);
  $("pd-deck").dataset.status = outcome;
  for (const id of Object.keys(state.items)) {
    const item = state.items[id];
    if (item.status === "running") item.status = outcome === "failed" || outcome === "error" ? "failed" : "completed";
    if (item.status === "pending") item.status = "skipped";
  }
  if (report?.project?.glb_url && !state.models.length) loadModel(report.project.glb_url, "Assembly");
  for (const win of state.windows.values()) if (win.status === "running" && win.kind !== "model") setWinStatus(win, "completed");
  renderRail();
}

addEventListener("resize", () => state && layout());
$("pd-toggle")?.addEventListener("click", event => {
  const hidden = desk().classList.toggle("is-hidden");
  event.currentTarget.setAttribute("aria-pressed", String(!hidden));
});
