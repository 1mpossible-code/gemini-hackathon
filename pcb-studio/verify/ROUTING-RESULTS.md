# Routing repair validation

This is partial progress, not a successful 15/15 repair. No Lean rules or existing test expectations were changed.

## Changes

- Retain the existing greedy repair, then try both endpoints of every remaining conflict, both copper layers, bounded board-relative detours and perpendicular pad escapes. Accept only strictly fewer conflicting trace pairs. This is local search, not a full router.
- Ignore caller-supplied verification in repair: rebuild the certificate for the actual board/revision. A forged `status: passed` on the invalid board did not bypass repair in the HTTP test.
- Serialize certificate builds per Lean project across repair and verification callers, preventing concurrent writes to Generated.lean.
- Return the exact certificate source SHA-256 (source includes board revision); treat nonzero checker exits without parsed theorem diagnostics as failures for every theorem.
- Request gemini-4-neon explicitly and expose measured call latency/error rather than silently concealing fallback.

## Checks

`node pcb-studio/verify/routing-check.mjs` checks the original invalid default rover PCB, runs deterministic repair, and regenerates/verifies the repaired PCB in a fresh Lean project without a build cache. Assertions check original failure, source/revision change, matching proof results and matching source hashes across independent verification. It writes detailed local results to `/tmp/forge-routing-results.json`. It does **not** assert successful repair: repair remains incomplete.

| Stage | Lean results | Checker time |
| --- | --- | --- |
| Original default board | 13/15 | 2,538 ms |
| Deterministic repair | 13/15 | 2,395 ms |
| Independent fresh-project reverification | 13/15 | 1,718 ms |

Deterministic routing: 11,316 ms. Both remaining failed theorems are `trace_clearance` and aggregate `all_rules`; these are not equivalent to exactly two physical crossings. The supplied default board still produces numerous conflicting segment diagnostics. The reported two-residual-crossing repaired fixture was not provided separately.

Original certificate SHA-256: `20ceb039193b6182932a78d4b511573fe136dd287cd05e8c085122a5ac3a7b5f`.
Repaired and independently regenerated certificate SHA-256: `4140fc0b122294c80b3ade7bb6deb2d4e26226a61ddb1b541a4bc7d90f14424f`.

HTTP repair with the configured API key attempted Neon twice: aborted at 12,006 ms with the original timeout, then at 60,076 ms with the increased timeout. No Neon engineering response was received; both runs truthfully reported deterministic fallback. Final HTTP repair also returned 13/15, `repaired: false`. These are timeout measurements, not successful model inference latency.

`cd pcb-studio && node node_modules/typescript/bin/tsc -b --pretty false` passes. `git diff --check` passes.

## Limits

Local strictly-improving search still stalls. No claim of manufacturability or resolved residual crossings is made. The hashes identify generated certificates, not independent audits of physical footprints or electrical assumptions; existing island warnings and modelling limits remain. Preview mode retains its existing deterministic-only behavior. No frontend, catalog, or unrelated backend services changed.

The worktree used the existing main checkout's node_modules through an ignored symlink: `npm ci` could not run because package.json and package-lock.json were already inconsistent (missing @emnapi entries). No dependency files were changed.
