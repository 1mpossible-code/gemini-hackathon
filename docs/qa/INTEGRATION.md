# Initial integration (historical: routing was pending)

Routing is now integrated; see [FINAL-DEMO.md](FINAL-DEMO.md) for current acceptance evidence and startup instructions.

Branch: `integration/final`, based on the combined `ux/post-merge-refinement` history (`dc858ce`). No merge conflicts occurred; no functionality was discarded.

Included commits:
- `9d439e7`: hardware audit, rover catalog and frontend analysis compatibility.
- `3cb7749`: UX labels, replacement costs and scene behavior.
- `54f96ef`: revision/request-bound verification, repair and generation writes; shared undo history.
- `8cf9163`: conservative procurement identity matching (includes development-board/breakout exclusions from the procurement worker).
- `6090201`: abandoned-check undo regression.
- `4a17ebc`: QA acceptance checks and evidence.

Integration fixes: synchronized npm lockfile (missing emnapi entries); converted the QA stale-certificate reproduction into a regression assertion requiring idle verification and no old theorems after an edit. The test executes the actual application check function with its request guard; no acceptance checks were removed.

## Checks

- `npm --prefix pcb-studio ci`: passed, zero vulnerabilities.
- `GEMINI_API_KEY=' ' GEMINI_API_KEY_FILE=' ' QA_STRICT=1 node tests/qa_pcb_regression.mjs`: 8/8 passed. Explicit blank credentials override local .env credentials for the required missing-key test; live Shopify discovery still exercised.
- `node tests/state_integrity.mjs`: 42 delayed-response cases passed, including edit/undo/new-request/system/budget/offer invalidation and current success/failure, plus certified undo checks.
- `node tests/procurement_matching.mjs`: 8 captured actual offers and 11 ambiguous/accessory/bundle/variant cases passed; rejected offers retain catalog BOM prices.
- `node pcb-studio/tests/hardware.mjs`: passed.
- `npm --prefix pcb-studio run build`: passed; existing large-bundle warning.
- `npm --prefix pcb-studio run lint`: passed, six warnings (Fast Refresh exports and scene immutability).
- `.venv/bin/python -m unittest discover -s tests -v`: 32/32 passed. Tests use unittest; pytest is not installed.
- Chrome headless against this branch's Vite server: passed actual component inspection, label toggle, eight System/Board transitions, cost/budget edit, replace-all, undo and technical details. Updated battery cost correctly yields $54.30 total and $34.30 over a $20 budget. Zero page errors. Evidence: `/tmp/forge-integration/` (local, not committed).
- Additional Chrome interaction: moved U1 on Board (A2 → A3), switched to System, clicked Undo, returned to Board and reselected U1: exact X position and A2 revision restored; zero page errors. The script must reselect the component after changing views; selection intentionally clears.
- `git diff --check`: passed.

The first strict run inherited local AI credentials and therefore could not satisfy the missing-key precondition; the credential-isolated run above passed. An initial browser attempt timed out during dependency reinstallation; the subsequent complete run passed.

## Remaining gate

Do not merge `fix/routing` until its agent report arrives. Current real Lean verification correctly rejects default-board trace clearance and `all_rules`; its passing individual theorems are not an all-board certificate. Copper-island warnings and the documented thermal-envelope assumptions remain visible. Repeat affected routing/certificate tests and integration acceptance after that final merge. No push to main performed.
