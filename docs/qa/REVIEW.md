# FORGE independent QA / judging review

Baseline: `1e8d9ab`. Environment: macOS ARM64, Lean 4.36.0; no Gemini credentials present. No production files changed. No browser automation installed: visual/pointer behavior below is a reproducible manual gate, NOT a claimed browser pass.

## Evidence and replay

- `uv run --locked --python 3.12 python -m unittest discover -s tests`: **32 passed**, 7.679 seconds. ResearchError traceback is an intentional negative-test path; final suite is OK.
- `cd pcb-studio && npm ci`: **fails**; missing `@emnapi/core@2.0.0-beta.2` and `@emnapi/runtime@2.0.0-beta.2` lock entries.
- Workaround used solely for testing: `npm install --no-package-lock` (no tracked changes); `npm run build`: **passes**; main JS 2,118.69 kB, gzip 676.70 kB (bundle warning).
- `node tests/qa_pcb_regression.mjs`: **8 checks pass**, including a known-bug reproduction. PASS on that reproduction means the bug was observed, not fixed. Raw real Lean and live Shopify results: [pcb-evidence.log](pcb-evidence.log).
- `QA_STRICT=1 node tests/qa_pcb_regression.mjs`: acceptance mode rejects the stale-verification bug and any returned development-board/module false exact matches. Shopify results are network/time dependent. Missing-key check requires an environment without GEMINI_API_KEY / GEMINI_API_KEY_FILE. Script uses temporary Lean project, never rewrites tracked proof files.
- Lean: actual `lake build Forge.Generated`, 15 theorem entries, **13 pass / 2 fail** (trace_clearance and aggregate all_rules). 158 same-layer clearance conflicts. VIN has three copper islands; +3V3, EN, IO0 and LED1 have two each. Proof scope explicitly excludes full net connectivity.
- Live Shopify: HTTP 200, real offers, seller URLs, currencies, retrieval timestamp. ESP32 module offers included $4.04 and $4.00; several development boards incorrectly marked exact_match. This is discovery, not confirmation of fulfillment or supplier accuracy.
- Gemini generation: actual HTTP 400 for empty prompt; HTTP 503 for valid prompt without key, explicit missing-key error, no invented board. Live success and live repair **NOT VERIFIED**.

## Ranked critical findings and reproduction

### P1 — Stale certificate can certify a different revision (reproduced)
`src/App.tsx:58–76` publishes asynchronous results without a board identity/revision guard. Start Check Design, edit board before completion, wait: old certificate replaces idle state on the new revision. Automated test executes the actual function body with a delayed verifier (not an invented replacement algorithm), edits A2→A3, then observes old success on A3. Repair and generation likewise snapshot old board/system then unconditionally overwrite current state (`runAiBoardRepair`, `runGenerate`); those two races are source-confirmed, not live-Gemini reproduced.

Acceptance — state/AI agents: every async operation captures a unique board identity/content token; edits, undo and subsequent requests invalidate it. Out-of-order results cannot overwrite newer work, proof, budget, selection or history. Include edit→undo→edit to the same visible revision (revision strings alone are not sufficient). Run delayed success AND delayed failure tests for verification, repair and generation.

### P1 — Discovery admits non-drop-in hardware as exact priced replacement (live reproduced)
POST `/api/shop/search` with `{mpn:"ESP32-WROOM-32E",name:"ESP32",manufacturer:"Espressif"}`. ShillehTek CP2102 USB-C dev board, Vetco D67 development board and Tinker Tailor 30-pin USB-C board were marked `exact_match`. Choosing those offers can replace the price for a bare PCB-mounted module without changing footprint/BOM. Exact-only propagation is correctly enforced by the store, but its upstream label is unreliable.

Acceptance — procurement agent: module vs populated board, package, flash variant, bundle quantity and accessory distinctions must be checked conservatively; ambiguous items must not alter BOM. Fixed fixtures for the observed titles; no false exact matches; original price retained with clear warning. Currency conversion remains absent rather than invented.

### P1 — Default board is not manufacturable/verified (real Lean reproduced)
Open Board → Check Design on fresh Rover, inspect trace_clearance. Actual checker finds 158 conflicts, including VIN vs AIN1 and VIN vs USB_D+. Multiple power islands are reported despite `every_net_connected` passing (the statement is intentionally per routed connection). Default assembly additionally has four overvolted motors, single-cell holder incompatible with 7.4 V assumption, and sonar/LED power/signal warnings.

Acceptance — routing/electrical agent: never call this fabrication-ready or wholly verified. Show failures and disconnected nets prominently; if claiming a valid board, remove shorts/islands and rerun real Lean on the exact exported content. Thermal proof covers ≤7.4 V, not the advertised 12 V input maximum (model estimates 232 °C there). No silencing checks or relabeling assumptions as facts.

### P2 — Clean lockfile install fails (reproduced)
Fresh checkout → `cd pcb-studio && npm ci` → missing emnapi entries. Demo/reviewer boot is not reproducible via clean CI install.

Acceptance — build agent: synchronize manifest/lockfile in a separate production change; clean `npm ci` then build on supported Node version, without ad-hoc installs.

### P2 — Research/engineering handoff is descriptive, not a shared device specification (source-confirmed)
`Research.tsx` sends brief plus part NAMES to generation, not selected IDs, quantities, budget, evidence or electrical constraints. `runGenerate` replaces board but leaves default Rover system devices attached. Repro gate: complete offline wristband research → Engineer PCB with working key → inspect generated Board and return to System. Confirm whether rover parts remain and research-selected parts were actually preserved. End-to-end not run without key.

Acceptance — integration agent: either preserve explicit mapped research component constraints and consistent system/BOM, or clearly disclose that the button starts a new independent board proposal. No claim of one coherent versioned design unless all views refer to the same specification.

### P2 — Post-connect Research outage is not tracked (source-confirmed)
ResearchPane polls only until `up` becomes true. Start backend, open Research, then kill backend: no subsequent health polling changes `up`; iframe API errors must carry the failure. Acceptance — UX agent: bounded timeout/error and visible retry/recovery after initial connection, with prior result retained and not mislabeled live.

## Claims vs implementation

- README opening claims autonomous circuit/firmware generation and simulation. README itself says firmware verification planned; the proposed demo describes synthetic firmware assertions/repair not evidenced by these implemented paths. Do NOT present that proposed narrative as working functionality.
- Real Lean is genuine, not a mocked green badge. It proves bounded encoded geometry/electrical predicates using lookup assumptions, not physical safety, firmware correctness, complete net connectivity or fabrication readiness.
- Shopify discovery is genuinely live. “Compatible replacement” and “exact match” exceed observed classification quality. USD subtotal excludes shipping/tax and missing prices; do not call it landed/full build cost.
- Offline research uses scripted model responses. Do not call it live Gemini. Managed Agents and live supplier lookup for the Python research catalog remain future integrations per README; PCB Shopify is a separate actual live integration.
- Research wristband and PCB Rover are not demonstrated as one continuous preserved design. Parametric/proxy geometry is not supplier CAD or fit validation.
- AI repair is implemented but its successful outcome, latency and reliability were not tested with credentials; never promise all checks pass.

## Reproducible regression checklist / release gates

Record commit, browser, viewport, service URLs, prompt, response timestamps and board content/revision for each run. All unchecked browser gates remain **pending**.

| Area | Procedure | Acceptance |
|---|---|---|
| Navigation | Research → System → Board → Research during running research; repeat five times | No blank canvas/errors; stream survives; tab/selection semantics coherent |
| 3D selection | Click motor, sensor, PCB, board component; deselect; rotate/zoom, toggle labels | Inspector targets clicked object; no orbit-triggered accidental swap; fit works |
| Replacement | Replace one motor, then matching motors; compare inspector and scene | IDs/count correct, model fidelity disclosed, correct costs and electrical warnings |
| Costs/budget | Set budget below/at/above total; select exact available USD offer; try bundle/unavailable/EUR; include repeated MPN | Sum per instance, same totals in all views, unknown price count retained, no accessory/FX invented |
| Undo | Edit board → swap device → change offer → undo until empty; edit during verification | Exact intended snapshots restored; current certificates only; no crash at empty history |
| Warnings | Fresh Rover, inspect motor/battery/sonar/LED; replace with safe motor | Actual voltage/logic assumptions visible; warning count follows state; no false physical-safety guarantee |
| Gemini | Valid key; generate small ESP32 LED board, capture events/latency/model; induce check failure; repair | Actual model request and returned board; bounded failure; failed repair never green; no stale writes |
| Lean | Run real verifier, resize/move component and recheck; remove lake; force timeout | Real build log and theorem failures; no old green badge; unavailable/timeout distinct from physical rule failure |
| Shopify | Search module, board, nonexistent MPN; block network; retry; select valid offer | Live provenance/time, exactness conservative, no fabricated offers; errors visible, catalog fallback labeled |
| Handoff | Offline/live research finished → Engineer PCB | Selected-part mapping traceable or independent proposal disclosed; no accidental default Rover claim |
| Missing services | No :8000; no key; stop research after initial load; disconnect network mid request | Actionable bounded errors, recovery, existing work not destroyed |
| Staleness | Delay each async response; edit/swap/undo; issue newer request first; return old response last | Exact request identity gating; no overwrites or certificate reuse across different content |

## Strongest honest three-minute demo

Preflight (not on stage): start Python research on :8000 and Vite on :5173 using README commands; verify WebGL visually; run tests/build; install/warm Lean; verify Shopify endpoint; use default Rover in fresh tab. Obtain Gemini key and rehearse one exact small prompt + repair twice before including live generation. Have a separate fully labeled offline research tab; never disguise it as live. Do not edit while a check is running until stale-result bug is fixed.

- **0:00–0:20 — Thesis and honest scope.** “FORGE makes hardware proposals inspectable: 3D components, sourced costs and machine-checked design constraints—not a claim that generated hardware is already safe to manufacture.” Start on System.
- **0:20–0:55 — Useful engineering interaction.** Select front-left motor; show 7.4 V vs motor-rating warning. Choose a genuinely higher-rated available catalog motor, show price delta and model disclosure. Undo; show restored motor. Rehearse exact catalog option in browser beforehand.
- **0:55–1:20 — Actual commerce.** Open PCB module sourcing; live search ESP32-WROOM-32E; show seller, price, timestamp. Choose a bare-module listing only after checking title. Say shipping/tax and physical fit are not verified. Network failure: show labeled failure and catalog price, no prerecorded result portrayed as live.
- **1:20–1:55 — Real formal evidence (hero moment).** Board → Check Design. Show actual Lean log and failed trace clearance. “The proof engine refuses our current routed proposal; 158 conflicts are actionable, not a green animation.” Explain bounded assumptions and no fabrication claim.
- **1:55–2:30 — AI, only if preflight passes.** Submit rehearsed small prompt and show genuine stage events/returned board; check exact new board. Repair only if rehearsed successful and bounded within remaining time. If credentials unavailable, show explicit configuration error briefly and instead demonstrate offline research sources, labeled scripted. Never claim a successful repair without showing rerun evidence.
- **2:30–2:50 — Research handoff.** Show finished offline research graph/source findings. If live key ready, Engineer PCB starts a new proposal from brief and part names; disclose current mapping limit. Without key, explain boundary and avoid clicking into a known failing live path.
- **2:50–3:00 — Close.** “Interactive proposals, live product discovery, and genuine falsifiable Lean checks work today. Shared-spec handoff, robust async consistency and manufacturable routing are next.”

Go/no-go: interactive 3D must be manually rehearsed; stale async bug blocks concurrent editing claims; no live-Gemini success claim without credentials/evidence; no fabricated all-green ending. A truthful failed proof is stronger than unsupported autonomy.
