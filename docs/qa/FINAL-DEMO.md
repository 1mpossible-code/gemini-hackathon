# FORGE final demo integration

Integrated routing commits `887de9c` and `29c01eb` via merge `b822993`. No textual conflicts. Existing async request guards, certified Undo, hardware analysis, exact procurement matching, projected labels, camera behavior and UX are retained. No teammate UI changes were available remotely at the previous integration gate; none were discarded here.

## Integration changes

- Compact Gemini repair prompts and configurable neon/hydrogen/carbon selection retained. Default: Hydrogen; override with `GEMINI_REPAIR_MODEL`.
- **Repair demo** loads the same small telemetry PCB used by the real end-to-end test. Loading invalidates pending requests, clears verification and creates unified Undo history. **Full rover PCB** restores the original controller board. The full rover system remains the initial showcase.
- Small-board instructions explicitly say its formal checks do not certify the full rover. No precomputed passing certificate is loaded: Check and Fix with AI use the real services.
- Certificate SHA-256 provenance and the shared per-project proof queue retained. Each build additionally uses an isolated temporary Lean project, preventing separate Vite runtimes/processes from overwriting proof source. Cleanup runs in finally.
- One shared typed demo fixture replaces the test-only fixture; the live test now defaults to two consecutive Hydrogen runs with separately recorded results.
- Board header/footer status now depends on board proof results, not unrelated full-system hardware warnings. System status still includes hardware issues. Example loading selects the top view so the smaller routing example is visible immediately.

## Actual acceptance evidence

Local raw logs and screenshots: `/tmp/forge-routing-final/`.

- Clean `npm ci`: passed, zero vulnerabilities.
- Strict QA: **8/8 passed**, including real Lean, live Shopify, stale-certificate rejection and credential-isolated missing-key behavior.
- Async regression: **42/42 passed**, plus certified Undo and loading-demo invalidation/restoration.
- Procurement: **8 captured offers + 11 ambiguous/accessory/variant/bundle cases passed**.
- Hardware regression: passed.
- Routing regression: passed, including fresh independent reverification and matching certificate hash/theorem results; it continues to report full-rover violations rather than fabricate success.
- Production build: passed. Lint: passed with six existing warnings. Large production-bundle warning remains.
- Python unittest: **32/32 passed**.
- Chrome: actual swaps, budget changes, Undo, repeated System/Board navigation, small-board Check → real Fix with AI → 15/15, certified Undo back to failures and full-rover restoration passed with no page errors. Header/footer passing statuses are asserted separately. The general smoke completed before an ambiguous Fix with AI locator stopped the script; the focused demo test scoped that locator to Board inspector and completed. Screenshots and real model-call evidence are committed in `artifacts/integration-final/`.

### Two consecutive real Hydrogen repairs

`node pcb-studio/verify/repair-demo.mjs` (default: hydrogen, hydrogen).

Both began from the original A1 small board: **13/15**, failing trace_clearance and all_rules. Both returned A2 with **15/15**, actor **gemini**, **zero deterministic adjustments**, no part or topology changes, and fresh independent Lean **15/15** with identical certificate hashes.

| Run | Model latency | Repair Lean | Independent Lean | Prompt/output tokens |
| --- | --- | --- | --- | --- |
| 1 | 2874 ms | 1403 ms | 1598 ms | 1000 / 66 |
| 2 | 2336 ms | 1299 ms | 1406 ms | 1000 / 64 |

Both moved U0TXD to bottom copper, removing the crossing with top-layer VBUS. Certificate SHA-256: `a56dae360bab5e2806ee18756430a8cb972a2998984912774ca26e965b6dcdf9`. Equal hashes are expected: independent requests proposed the same geometry. These are separate model calls and separate fresh proof builds, not cached demonstrations.

## Startup

Prerequisites: Node/npm, elan, and a configured Gemini key (`GEMINI_API_KEY` or `GEMINI_API_KEY_FILE`, including existing local .env configuration). Do not commit credentials.

```bash
elan toolchain install leanprover/lean4:v4.36.0
cd pcb-studio
npm ci
GEMINI_REPAIR_MODEL=hydrogen npm run dev -- --host 127.0.0.1 --port 5188 --strictPort
```

Open `http://127.0.0.1:5188`. From repository root, reproduce the two independent real demonstrations with `node pcb-studio/verify/repair-demo.mjs`.

## Reliable three-minute walkthrough

1. **0:00–0:45 — System:** show the full rover, projected component labels and honest electrical issues. Select a motor, show replacement options, change a part, show Parts & cost and budget propagation, then Undo.
2. **0:45–1:15 — Repair demo:** click the header action, explain that this is a separate smaller PCB, then click Check. Show the two failures (trace clearance and all_rules), not a fake green state.
3. **1:15–2:00 — Fix with AI:** click once; Hydrogen proposes a routing change and Lean verifies it. Show Design checks passed (15/15 rules verified) and Technical details. Live network latency can vary; do not promise the measured timing.
4. **2:00–3:00 — Integrity:** Undo the repair to restore the failing board. Click Full rover PCB, then System. Emphasize that the rover still has unresolved engineering issues: the smaller board's certificate does not certify it.

The full rover is not fabrication-ready: clearance violations and documented power/thermal assumptions remain. The small test fixture has no supplier pricing: its $0 parts subtotal is not a real BOM estimate; demonstrate cost/budget propagation on the priced rover, not the test fixture. No proof rules were weakened. Nothing pushed.
