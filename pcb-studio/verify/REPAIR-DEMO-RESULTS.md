# Autonomous repair: actual results

Continuation of 887de9c. No general router, rule changes, or altered test expectations.

## Full rover: still not verified

The two failed theorems are `trace_clearance` and aggregate `all_rules`, NOT two physical crossings. Lean reports **158** violating segment pairs originally and **40** after deterministic repair. Independent fresh-project Lean verification confirms 13/15 after repair. The diagnostic parser previously missed the first line because Lake prefixes it with `info: ...`; that parsing bug is fixed.

The 40 violations involve 12 trace pairs (zero-based net indices):

| Traces | Layer | Violating segment pairs |
|---|---|---:|
| 14 CIN1 / 15 CIN2 | bottom | 7 |
| 15 CIN2 / 16 PWMC | bottom | 7 |
| 18 DIN2 / 19 PWMD | top | 6 |
| 17 DIN1 / 18 DIN2 | top | 5 |
| 6 VM (canonical VIN) / 34 VBUS | bottom | 4 |
| 10 PWMA / 11 BIN1 | top | 3 |
| 12 BIN2 / 39 EN | bottom | 2 |
| 14 CIN1 / 16 PWMC | bottom | 2 |
| 9 AIN2 / 39 EN | bottom | 1 |
| 13 PWMB / 38 EN | top | 1 |
| 17 DIN1 / 40 IO0 | top | 1 |
| 35 SDA / 36 SCL | top | 1 |

All **40 exact segment coordinates and layers**, emitted by an additional Lean diagnostic using the unchanged `segClear` predicate and `Rules.clearReq`, are archived in `rover-violations.json`. The extended diagnostic is separate from the production certificate. The test asserts its count matches Lean's normal summary. The required edge-to-edge separation is 127 µm; trace half-widths are also included in centerline clearance. Local search stalls because it requires a strictly decreasing conflicting-trace-pair count; dense shared escape corridors need coordinated edits.

A real Gemini rover attempt with a compacted prompt and thinking-budget hint completed (Neon 13,514 ms; Hydrogen 3,102 ms), but still had **37** violating segment pairs after deterministic follow-up. This is not a successful full-rover repair.

## API and timeout investigation

Using the configured API key against the actual generateContent endpoint:

- Model listing advertises Neon, Hydrogen, Carbon, and generateContent support. Tiny structured requests succeeded: Neon 3,806 ms; Hydrogen 2,329 ms; Carbon 2,287 ms. Thus model names, credentials, schema support and API availability were functional during testing.
- A 483-character compact repair prompt succeeded: Neon 7,188 ms; Hydrogen 2,182 ms; Carbon 2,776 ms.
- A 4,380-character/2,641-token rover-like prompt timed out on Neon after 35,207 ms and Carbon after 35,134 ms. Hydrogen completed in 17,882 ms, reporting 3,635 reasoning tokens.
- Neon with `thinkingBudget: 256` completed that same rover-like prompt in 11,261 ms. The provider still reported 930 reasoning tokens: treat this configuration as a latency hint, not an enforceable hard cap.
- This implicates task complexity/reasoning and variable inference latency, not excessive context-window size or an unavailable model. The original 12/60-second aborts alone could not identify the cause. These are observational samples, not latency percentiles or proof of service guarantees.

Repair now accepts `model: "neon" | "hydrogen" | "carbon"` (or their full gemini-4 names), with `GEMINI_REPAIR_MODEL` as server default. Unknown models return HTTP 400. No silent model substitution. Requests have a 30-second deadline and explicitly report the actual model, error, prompt characters, tokens and elapsed time. Prompt contents are limited to failed theorem descriptions, six relevant diagnostics, bounded conflicting trace pairs, affected geometry/waypoints and permitted edits, rather than every net plus raw tactic failures.

## Smaller supported demonstration — NOT the full rover

`repair-demo.mjs` defines an 11-part, 14-connection ESP32 USB-UART telemetry node using existing supported ESP32, CH340C, AMS1117, USB-C, passives, LED and connectors. It exercises all 15 emitted Lean theorems, including regulator power/thermal, logic levels and LED current. Existing modelling assumptions and island warnings are not stronger electrical completeness guarantees.

Its deliberate routing defect is exactly one top-layer violating segment pair:

- VBUS: (10000,-6145)–(13300,-9445) µm
- U0TXD: (13300,-8175)–(9565,-8175) µm

Original board: **13/15**, only `trace_clearance` and `all_rules` fail. Each actual model independently chose to move net 8 U0TXD from top to bottom copper, revision A1 → A2. No part moves, topology changes or deterministic adjustments were needed. No AI answer is embedded in the test.

Final repeat run:

| Model | Live call | Repaired Lean | Fresh-project independent Lean |
|---|---:|---|---|
| Neon | 3,436 ms | 15/15, 384 ms | 15/15, 1,300 ms |
| Hydrogen | 2,481 ms | 15/15, 363 ms | 15/15, 1,393 ms |
| Carbon | 2,701 ms | 15/15, 384 ms | 15/15, 1,304 ms |

Each used 1,107 prompt characters / 1,000 input tokens. Earlier run of this same final design also passed all three: Neon 5,595 ms, Hydrogen 3,140 ms, Carbon 4,037 ms. Exploratory two-conflict variants were less reliable: Hydrogen needed deterministic follow-up on some calls and correctly failed the strict zero-adjustment assertion. Those are not counted as pure AI repair successes.

Original source SHA-256: `c40dc4d44fc6941c280ea05f2b4ac1533511df50c6739badff5a0112102a25ef`.
All three repaired/independently regenerated source hashes: `a56dae360bab5e2806ee18756430a8cb972a2998984912774ca26e965b6dcdf9`.

Certificate hashes include revision. Each independent check copies Lean source/config to a fresh directory without build artifacts, regenerates the certificate from the returned board, and matches hashes. Forged caller-supplied passing verification is ignored and tested. Existing serialized builds and fail-closed checker handling are preserved.

## Reproduce

With the API key configured in the environment:

```sh
node pcb-studio/verify/repair-demo.mjs
node pcb-studio/verify/routing-check.mjs
cd pcb-studio && node node_modules/typescript/bin/tsc -b --pretty false
```

All passed in this iteration; `git diff --check` also passed. Live results including changed nets are written to `/tmp/forge-demo-results.json`; full rover results go to `/tmp/forge-routing-results.json`. `DEMO_MODELS=neon` runs just the primary demo. Live assertions intentionally fail if an API call fails or deterministic routing supplies the repair.

Limits: full rover remains invalid; no general router was built. Live AI availability and answers are nondeterministic. Fresh-project reverification is independent of cached build artifacts, not an independently implemented checker or a manufacturing sign-off. Preview remains deterministic-only.
