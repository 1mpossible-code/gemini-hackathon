# FORGE hackathon MVP plan

## What we need to demonstrate

Build one complete workflow for a wrist-worn gesture detector. A user supplies a plain-language brief, Gemini specialists produce a design, and the prototype views agree on what was designed. The demo succeeds when a reproducible firmware test fails, a Gemini agent uses the failure evidence to propose a focused repair, and the same test passes on the revised design.

The circuit is a virtual reference design. The research harness selects from exact manufacturer SKUs. Its demo proposes an Espressif ESP32-DevKitC-32E and a SparkFun MyoWare 2 Muscle Sensor (DEV-27924). Add a CircuitMind board definition for this DevKitC variant before generating its wiring diagram. Use one analog EMG envelope channel, classify `idle` and `flex` with synthetic input, and emit the events over serial during verification. Preserve the request for individual-finger recognition and BLE in the requirements and show their validation status. [MyoWare module](https://www.sparkfun.com/myoware-2-muscle-sensor.html) · [ESP32-DevKitC V4 board guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html)

## Reuse from CircuitMind

The CircuitMind baseline is commit `d5237ae`, under MIT. Preserve its copyright and permission notice when carrying code into FORGE. [Pinned CircuitMind source](https://github.com/takemygunq/CircuitMind/tree/d5237aefb880bb4dff122f8be45c475b7b84c0c7)

| Upstream entry point | FORGE integration |
| --- | --- |
| `src/core/schema/project.ts` and `library/` | Keep the existing board, part instance, and connection contract for the electrical design. Add vetted wearable catalog entries with provenance. |
| `src/core/erc/` and `src/core/code/pinmap.ts` | Reuse the electrical rules and derive the firmware pin bindings from the nets. Gate on both error and danger counts, since the upstream `ok` flag only covers errors. |
| `src/diagram/` and `src/components/Workspace.tsx` | Reuse wiring and schematic views. Add the 3D tab and link part selection across views by instance ID. |
| `src/app/api/projects/generate/route.ts` | Reuse its NDJSON event pattern for a dedicated FORGE workflow. Keep stable tool outcomes and artifact revisions in the event data. |
| `src/core/sim/` and `src/server/compile/` | Keep existing CircuitMind functionality available. The built-in AVR emulator and default AVR compiler are insufficient for the ESP32 test. |

Bring the pinned CircuitMind base into a tracked FORGE app tree at the start of implementation so the hackathon diff is reproducible. The local reference clone is Git-ignored and can be inspected independently. Attribute CircuitMind in the submission and show the FORGE-specific orchestration, 3D editing, and firmware repair.

## One project model

Use a versioned `DeviceSpec` envelope around CircuitMind's `Project`. The server owns revisions and validates every agent proposal before applying it.

| Field | Owns |
| --- | --- |
| `schemaVersion`, `projectId`, `revision` | Schema compatibility, project identity, and the revision used to generate artifacts and test results |
| `requirements` | Original brief, USD component budget in cents, connectivity, gesture targets, and wrist circumference in millimeters |
| `circuit` | Board ID, part instance IDs, connections, and power assumptions in CircuitMind's format |
| `catalogSnapshot` | Catalog ID to manufacturer SKU, pin/rail references, price quote with source and date, dimensions, and asset reference |
| `firmware` | Board target, ADC and classifier parameters, and transport choice. The firmware renderer derives pin constants from `circuit`. |
| `mechanical` | Enclosure dimensions, clearances, and placement by part instance ID |
| `verification` | Test runner, revision under test, scenario ID, status, and diagnostic or log reference |

Derive the rendered circuit, priced BOM, firmware, 3D scene, and simulator inputs from each validated revision. Use an explicit test-only sensor surrogate in simulation and keep the sourced EMG module in the engineering BOM. Build the bill of materials from the components actually selected. A missing quote makes budget status unknown.

Agents propose scoped patches against an expected revision. Reject stale patches and keep the last published revision available if a candidate fails verification. A component change triggers revalidation of relevant nets, pin bindings, pricing, and 3D fit. An enclosure-only edit regenerates geometry and runs fit checks. The UI shows which checks ran and which remain pending.

## Gemini workflow

The CLI implements the first three research stages in `forge_research/`. Requirements extraction feeds a sourcing agent with catalog tools. Deterministic checks run before the reviewer writes engineering next steps. Its versioned research report is the input for the future electrical stage.

| Role | Deliverable |
| --- | --- |
| Lead engineer | Structured requirements, acceptance targets, and the requested revision scope |
| Research and sourcing | Catalog IDs, sourced technical facts, costs, and alternatives where available |
| Electrical | Power and signal connections that pass deterministic checks for supported parts |
| Mechanical | Placements and enclosure parameters, with clearance findings |
| Firmware | Arduino ESP32 firmware configuration and gesture logic based on the canonical pin bindings |
| QA | Test execution and diagnostics. When a test fails, QA sends the finding to the responsible specialist for a scoped patch. |

Sequence the lead, sourcing, and electrical stages first. Mechanical and firmware can consume the same validated circuit revision independently. QA runs after both finish. Allow up to two repair attempts for the same failure. Record public-facing summaries of tool actions, results, and changes in the activity panel.

Use Google ADK to coordinate Gemini roles. Early in the build, exercise the event-provided Gemini model and one Google-hosted Managed Agent call with the event credentials. Use the hosted agent to ground sourcing decisions or analyze QA failure evidence. A local deterministic verifier decides the outcome. Record the managed interaction and its contribution to the design. If access is unavailable, continue with ADK-orchestrated Gemini agents for the overall demo and describe the runtime used. Confirm prize-specific requirements with organizers. [Google ADK](https://github.com/google/adk-python) · [Managed Agents](https://adk.dev/agents/managed-agents/) · [Official event page](https://cerebralvalley.ai/e/gemini-4-nyc)

## Reproducible firmware repair

1. Write a deterministic baseline firmware sketch and a scenario with idle, flex, and return-to-idle inputs. Add a second fixture covering noise near idle to catch overcorrection.
2. Run the baseline on Wokwi with an ESP32 and an analog surrogate such as a potentiometer. Use automation scenarios to drive the input and assert serial gesture events in order. Verify the simulator token, toolchain, and tailored ADC thresholds early. Wokwi's ESP32 support covers ADC and serial, and its documented peripheral matrix lists Bluetooth as unsupported. [ESP32 simulation](https://docs.wokwi.com/guides/esp32) · [Automation scenarios](https://docs.wokwi.com/wokwi-ci/automation-scenarios) · [Analog surrogate](https://docs.wokwi.com/parts/wokwi-potentiometer)
3. Seed one visible demo fault by setting the flex threshold above the fixture's flex signal. Capture the missing expected event and the actual samples. Send that evidence and the allowed patch fields to QA and Firmware.
4. Validate the proposed parameter change, regenerate the firmware, and rerun the original scenarios with the same inputs and assertions. Show the failure, exact parameter diff, and new output in the activity panel. Publish the revision only after both scenarios pass.

If the Wokwi path misses its time box, compile and run the same C++ classifier on the host with checked-in synthetic fixtures and assert the same sequence plus noise behavior. Present that result as host firmware logic testing. Report ESP32 hardware simulation and BLE connectivity as unverified whenever they were not exercised.

## Build order

| Time box | Deliverable | Done when |
| --- | --- | --- |
| First 45 min | Reuse baseline and integration checks | Upstream launches, Gemini returns one structured result, Managed Agents access is checked, and the firmware test runner can execute a fixed fixture. |
| Next 90 min | Headless design with one catalog | One brief turns into a validated `DeviceSpec`, schematic data, a sourced BOM, and firmware pin bindings. |
| Next 90 min | Fail, repair, rerun | A real test fails on the seeded fault, Gemini proposes a patch based on the evidence, and the same test passes after the change. |
| Next 90 min | Editable prototype workspace | The 3D view rotates, selection exposes a real part's details, and changing wrist circumference produces a visibly revised enclosure. Budget edits show an updated total or unmet constraint. |
| Final 60 min | Rehearse and capture evidence | A fresh live run finishes and the team has the prompt, part sources, revision diff, and before/after test logs for submission. |

Start the 3D scene with a parametric enclosure mesh and bounding boxes based on the selected parts' documented dimensions. Use a licensed model when it matches the exact SKU. Consult Circuitiny for component metadata and 3D placement patterns and Adafruit CAD Parts for matching geometry. Use the supplied Flux screenshot for the three-panel workspace concept and develop a distinct FORGE interface. [Circuitiny](https://github.com/mfranzon/circuitiny) · [Adafruit CAD Parts](https://github.com/adafruit/Adafruit_CAD_Parts) · [Flux workspace reference](https://www.flux.ai/p/blog/flux-public-launch-announcement)

Start with CircuitMind's wiring and schematic engine and a small local catalog. Evaluate tscircuit for PCB visualization or export, pcbparts-mcp for broader live sourcing, and CadQuery for editable solid CAD exports. [tscircuit](https://github.com/tscircuit/tscircuit) · [pcbparts-mcp](https://github.com/Averyy/pcbparts-mcp) · [CadQuery](https://github.com/CadQuery/cadquery)

### First mechanical tool

Use the [prototype pipeline](prototype-pipeline.md) to add the Gemini mechanical stage, assembly generator, and Three.js workspace. Local ADK can call the Python geometry tool directly. A Google-hosted Managed Agent would need it exposed through remote MCP. [Managed Agents limitations](https://adk.dev/agents/managed-agents/#limitations)

## Demo acceptance

- [ ] A fresh prompt reaches Gemini and produces explicit constraints, assumptions, and sourced part selections.
- [ ] The circuit, BOM, firmware pin bindings, and 3D inspector agree on the part and revision being displayed.
- [ ] A reproducible test fails, its diagnostic reaches an agent, and the original test passes after the recorded repair.
- [ ] A user can resize the enclosure and see updated geometry. A budget change reruns the price check and reports an unmet cap when there is no supported solution.
- [ ] The workspace identifies the signal source, test runner, validation status, and what still needs a physical trial.

The scope and judging emphasis follow the supplied project brief and the final prize discussion in the shared chat. [Hackathon strategy chat](https://chatgpt.com/share/6b01c518-799c-83e9-b5cc-a90547464f1a)
