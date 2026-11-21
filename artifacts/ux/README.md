# Focused FORGE frontend refinement

Branch: `fix/ux`. No merge or push. Hardware data, compatibility logic, repair backend and Lean rules are unchanged.

## Changes
- Replaced all three Drei Html call sites with one shared projected DOM overlay. Labels use no secondary React roots; cleanup removes only their own DOM nodes. Positions follow the real animated world transforms, and offscreen anchors are hidden.
- Preserved camera framing, workspace layout, contextual labels and existing action entry points. Removed redundant device-name subtitles and numbered board labels.
- Replacement cards wrap names, explicitly identify per-part savings/additions, and show all returned warnings instead of only the first. Batch replacement still shows the aggregate delta.
- Proxy-model information is available under 3D model details. Warnings without a suggested replacement link to board wiring; engineering explanations and technical details remain available.
- Budget overruns also appear next to the header cost. Both budget inputs have accessible names and accept zero consistently with existing validation.

## Verification
`npm run build`, `npm run lint`, and `git diff --check` pass. Lint reports six warnings (one new Fast Refresh context-export warning); the existing large bundle warning remains.

Browser regression script: `check.py` (Python Playwright, installed Google Chrome, Vite at port 5175). It checks eight completed Board/System transitions with all labels enabled, one canvas, selected-label rendering, budget overruns, batch replacement, Undo, technical details, and uncaught page errors. Screenshots include initial System, replacement inspector, Board, exceeded budget, replaced assembly and expanded technical details. A separate 900×900 tablet check found no document horizontal overflow.

Final browser run passed with zero uncaught page errors. Readiness was 3366 ms including settling; completed transition samples ranged from 2400–6319 ms. RAF mean was 16.67 ms and p95 16.70 ms (~60 Hz).

Performance samples are in `results.json`. Readiness includes an intentional 2500 ms settle; transition samples include 850 ms settle and Playwright interaction overhead. RAF measurements describe browser frame scheduling, not GPU render time or a before/after benchmark. These are local development/headless-Chrome measurements, not production-device guarantees.

## Remaining limits
- Live merchant offers, AI repair and Lean execution were not exercised; their controls and existing integration code are preserved.
- Existing cinematic transitions remain relatively slow (2.4–6.3 s including test overhead); their camera choreography was preserved.
- Opt-in All labels can still overlap; default Focus mode remains intentionally sparse. Labels do not perform depth occlusion, matching the previous non-occluding labels.
- No mobile-phone or cross-browser certification; tablet and desktop screenshots only.
- Existing main JS bundle is large (~2.11 MB, ~674 KB gzip); no unrelated dependency or bundling redesign was attempted.
