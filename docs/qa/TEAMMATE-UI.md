# Teammate demo/UI integration

Incoming: David Ren's `0bcad3c` from `origin/forge-pcb-studio`.

Adopted the research-first landing page, animated research map, workbench styling/navigation, shared research-to-PCB handoff, reconstruction catalog and model assets. Research stays mounted across mode switches. Retained our rover engineering panels, replacement/price/budget logic, projected labels, camera framing, request-epoch guards, certified unified Undo, conservative offer classification, Hydrogen repair demo and isolated certificate builds.

Five overlapping files were resolved by inspected hunk decisions, not whole-file ours/theirs selection: App, SystemPanels, System scene, studio state and CSS. Shared navigation, shop types and bus colors were combined with our engineering implementations. The incoming StrictMode generation deduplication now calls our guarded runGenerate function; no duplicate research iframe or obsolete generation function was retained. Incoming HTTP/type refactors retain our model selection and repair/certificate integrity logic.

## Actual checks

- Strict QA 8/8 passed (credential-isolated missing-key precondition).
- All 42 async cases, demo loading/Undo checks, procurement and hardware regressions passed.
- Production build and lint passed (remaining React scene/export warnings; large bundle warning).
- Python unittest: 39/39 passed, including seven new reconstruction checks.
- Chrome: new landing, finished sample and research flow, rover, component substitution, budget propagation, Undo and eight System/Board transitions passed. Both pageerror and console-error listeners were used; zero errors on these flows. Screenshots: `artifacts/teammate-ui/`.
- Two real Hydrogen repairs after merging: both 15/15, zero deterministic adjustments, matching independent fresh Lean certificate hashes. Raw log: `/tmp/forge-teammate/repair.log`.
- Git whitespace checks only report whitespace inside the incoming vendored Three.js shader strings; these were not rewritten.

Prior small-board-to-rover NaN geometry console error was not retested through the browser here; it remains a known rendering risk, not a proof failure.

## Run the teammate UI

From repository root, terminal 1:

```bash
uv run --locked --python 3.12 python -m forge_research.studio
```

Terminal 2:

```bash
cd pcb-studio
npm ci
npm run dev -- --host 127.0.0.1 --port 5188 --strictPort
```

Open `http://127.0.0.1:5188/` for the teammate landing/demo. Use `http://127.0.0.1:5188/?mode=engineer` to go straight to the rover and our verified small-PCB repair demonstration. The existing Gemini/Lean credentials and toolchain requirements still apply. Nothing pushed.
