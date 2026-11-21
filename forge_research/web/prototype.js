const section = document.querySelector("#prototype");
const revision = document.querySelector("#prototype-revision");
const prototypeError = document.querySelector("#prototype-error");
const viewportStatus = document.querySelector("#viewport-status");
const viewportControls = document.querySelector("#viewport-controls");
const parts = document.querySelector("#assembly-parts");
const selectedPart = document.querySelector("#selected-part");
const source = document.querySelector("#selected-source");
const size = document.querySelector("#wrist-size");
const apply = document.querySelector("#apply-wrist");
const editStatus = document.querySelector("#revision-status");
const exportLink = document.querySelector("#download-model");
const fit = document.querySelector("#fit-notes");
const fitItems = document.querySelector("#fit-findings");
const explode = document.querySelector("#explode-view");

const fidelityLabels = {
  dimensioned_proxy: "Dimensioned proxy",
  estimated_detail: "Estimated detail",
  parametric: "Parametric geometry",
};
const findingLabels = { pass: "Checked", fail: "Flagged", unknown: "Needs verification" };
const dimensions = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const partNodes = new Map();
const partButtons = new Map();

let current = null;
let selectedId = null;
let applying = false;
let viewerPromise;
let viewer;
let version = 0;

function choosePart(id) {
  const part = partNodes.get(id);
  if (!part) return;
  selectedId = id;
  for (const [buttonId, button] of partButtons) {
    button.setAttribute("aria-pressed", String(buttonId === id));
  }
  selectedPart.hidden = false;
  document.querySelector("#selected-label").textContent = part.label;
  const extent = part.geometry.size_mm.map(value => dimensions.format(value)).join(" × ");
  document.querySelector("#selected-meta").textContent =
    fidelityLabels[part.fidelity] + " · " + extent + " mm";
  source.hidden = !part.source || !/^https?:\/\//.test(part.source);
  if (!source.hidden) source.href = part.source;
  viewer?.setSelection(id);
}

function renderManifest(prototype, defaultSelection) {
  current = prototype;
  revision.textContent = "Revision " + prototype.revision + " · Parametric preview";
  size.value = prototype.manifest.parameters.wrist_circumference_mm;
  exportLink.href = prototype.glb_url;
  partNodes.clear();
  partButtons.clear();
  for (const node of prototype.manifest.nodes) {
    const id = node.part_instance_id || node.id;
    if (!partNodes.has(id) || node.id === id) partNodes.set(id, node);
  }
  parts.replaceChildren(...Array.from(partNodes, ([id, node]) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "part-button";
    const swatch = document.createElement("span");
    swatch.className = "part-swatch";
    swatch.setAttribute("aria-hidden", "true");
    button.append(swatch, node.label);
    button.addEventListener("click", () => choosePart(id));
    partButtons.set(id, button);
    row.append(button);
    return row;
  }));
  choosePart(partNodes.has(defaultSelection) ? defaultSelection : partNodes.keys().next().value);

  const findings = prototype.manifest.findings;
  fit.hidden = findings.length === 0;
  const unresolved = findings.filter(finding => finding.status !== "pass").length;
  fit.querySelector("summary").textContent = "Fit and fidelity" +
    (unresolved ? " · " + unresolved + " to verify" : "");
  fitItems.replaceChildren(...findings.map(finding => {
    const row = document.createElement("li");
    const status = document.createElement("strong");
    status.textContent = findingLabels[finding.status] + " ";
    row.append(status, finding.detail);
    return row;
  }));
}

function initViewer() {
  viewerPromise ??= import("./assembly-viewer.js")
    .then(({ AssemblyViewer }) => new AssemblyViewer(
      document.querySelector("#assembly-canvas"),
      choosePart,
      () => {
        viewportStatus.textContent = "3D view unavailable. Inspect the parts or download the GLB.";
        viewportControls.hidden = true;
      },
    ))
    .catch(() => null);
  return viewerPromise;
}

export function getPrototype() {
  return current;
}

export async function presentPrototype(prototype, error) {
  const token = ++version;
  applying = false;
  current = null;
  section.hidden = !prototype;
  editStatus.textContent = "";
  apply.disabled = false;
  size.readOnly = false;
  prototypeError.textContent = error ? "Prototype unavailable. " + error : "";
  viewer?.clear();
  if (!prototype) return;

  section.hidden = false;
  viewportStatus.textContent = "Loading 3D assembly…";
  viewportControls.hidden = true;
  apply.disabled = true;
  size.readOnly = true;
  renderManifest(prototype, "board");

  try {
    viewer = await initViewer();
    if (token !== version) return;
    if (!viewer || viewer.contextLost) {
      viewportStatus.textContent = "3D view unavailable. Inspect the parts or download the GLB.";
      return;
    }
    await viewer.load(prototype);
    if (token !== version) return;
    viewer.setSelection(selectedId);
    viewportStatus.textContent = "";
    viewportControls.hidden = false;
  } catch {
    if (token === version) viewportStatus.textContent = "Could not open the 3D assembly. Download GLB to inspect it.";
  } finally {
    if (token === version) {
      apply.disabled = false;
      size.readOnly = false;
    }
  }
}

size.addEventListener("input", () => {
  editStatus.textContent = "";
});

document.querySelector("#wrist-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!current || applying) return;
  const token = version;
  const reported = Number(current.manifest.parameters.wrist_circumference_mm);
  const entered = size.valueAsNumber;
  if (entered === reported) {
    editStatus.textContent = "This size is already applied.";
    return;
  }
  applying = true;
  apply.disabled = true;
  size.readOnly = true;
  editStatus.textContent = "Updating the strap…";
  try {
    const response = await fetch("/api/prototypes/" + encodeURIComponent(current.project_id) + "/revisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_revision: current.revision, wrist_circumference_mm: entered }),
    });
    const updated = await response.json();
    if (token !== version) return;
    if (!response.ok) {
      const message = typeof updated.detail === "string" ? updated.detail : "Check the wrist size and try again.";
      throw new Error(message);
    }
    if (viewer && !viewer.contextLost) {
      try {
        await viewer.load(updated, { keepView: true });
      } catch {
        throw new Error("The revised model could not load. Run the brief again to refresh the assembly.");
      }
    }
    if (token !== version) return;
    renderManifest(updated, selectedId);
    editStatus.textContent = "Strap updated to " + dimensions.format(entered) + " mm.";
    if (viewer?.model && !viewer.contextLost) {
      viewportStatus.textContent = "";
      viewportControls.hidden = false;
    }
  } catch (error) {
    if (token === version) editStatus.textContent = error.message || "Could not update the strap.";
  } finally {
    if (token === version) {
      applying = false;
      apply.disabled = false;
      size.readOnly = false;
    }
  }
});

explode.addEventListener("click", () => {
  const enabled = explode.getAttribute("aria-pressed") === "true";
  explode.setAttribute("aria-pressed", String(!enabled));
  viewer?.setExploded(!enabled);
});

document.querySelector("#reset-view").addEventListener("click", () => viewer?.reset());
