# FORGE · Autonomous AI Hardware Engineering

FORGE is an autonomous hardware engineering platform where a swarm of Gemini agents transforms natural-language ideas into editable 3D prototypes, selecting compatible components, designing circuits, generating firmware, and validating the results through simulation.

**Hackathon MVP in development.** The prompt studio runs Gemini research and generates an editable 3D preview for the supported wristband assembly. Firmware verification is planned.

## Open the prompt studio

```bash
uv run --locked --python 3.12 python -m forge_research.studio
```

Open `http://127.0.0.1:8000`. **Use wristband brief** fills the editor. **Run offline sample** runs the research harness without a key. The report lists candidate parts, compatibility checks, and sources. Inspect the generated assembly, adjust the wrist circumference, or export the model as GLB and the report as JSON.

For live research, set `GEMINI_API_KEY` and `FORGE_GEMINI_MODEL` in the server environment before starting the studio. The browser sends the brief to the local server, which calls Gemini. The wristband image is an illustrative concept study.

The run graph streams the lead engineer, parts search, compatibility checks, reviewer, assembly, and GLB export as they happen. Select a node to see the associated part sources, decision, or build findings.

## Engineer the PCB

The PCB studio in `pcb-studio/` is the engineering half of FORGE. It opens on a system view of the whole device, with catalog peripherals (motors, sensors, displays, power) wired to a custom PCB by bus. Select a device to compare compatible replacements by price and current draw, or swap it. Scroll into the PCB to work on the board itself, with 3D parts, routed copper, Gemini board generation, Lean 4 design-rule proofs, and STL, GLB, OBJ, PNG and BOM exports.

```bash
uv run --locked --python 3.12 python -m forge_research.studio   # research swarm on :8000
cd pcb-studio && npm install && npm run dev                      # studio on :5173
```

### Local 3D assemblies

The engineering studio builds procedural 3D assemblies locally in the System view. Built-in shapes include a four-wheel rover, wristband, quadcopter, hexacopter, octocopter, and smart glasses. Other briefs use a mounting plate or enclosure with matching catalog components. These assemblies require no 3D-generation API key. Use the existing Export menu to download the assembly as GLB or other supported formats. Arbitrary custom object meshes are not currently generated.

The **Research** tab in the studio shows the research swarm from port 8000. **Engineer PCB** on a finished research run sends the brief and the selected parts to the PCB studio, which generates a board for them. Set `GEMINI_API_KEY` (or `GEMINI_API_KEY_FILE`) before `npm run dev` to enable board generation. Lean proofs need `elan`; see `pcb-studio/verify/README.md`.

## Run the research swarm

The offline wristband scenario runs from the repository root with uv. [uv documentation](https://docs.astral.sh/uv/)

```bash
uv run --locked --python 3.12 python -m forge_research --offline
```

The offline run uses scripted model responses and exercises the actual ADK workflow and lookup tool. It looks up both controller and sensor candidates, checks the proposal against records returned during that run, and prints a versioned JSON report with sources, dated prices, findings, and an agent activity trace.

For a live brief, set `GEMINI_API_KEY` or `GOOGLE_API_KEY` and set `FORGE_GEMINI_MODEL` to the Gemini model ID enabled for your account. Then run the workflow against your brief.

```bash
uv run --locked --python 3.12 python -m forge_research \
  --brief 'Design a BLE wristband using EMG for finger gestures. Keep parts under $80.'
```

The first catalog covers EMG wearables. The report distinguishes the controller and sensor subtotal from the full build budget. Its checks cover catalog evidence, the requested transport, the presence of an ADC input, and the nominal sensor supply. It also records the work still needed to validate signal range, enclosure fit, and BLE on a physical device. Custom briefs use Gemini through local Google ADK. Google-hosted Managed Agents and live supplier lookup are future integrations.

Run the workflow and catalog tests.

```bash
uv run --locked --python 3.12 python -m unittest discover -s tests
```

## Hackathon demo

> Design a wrist-worn finger-gesture detector using muscle sensors for under $100 that sends gesture events to my laptop over Bluetooth Low Energy.

1. **Describe the device.** The lead agent turns the prompt into reviewable requirements for cost, inputs, connectivity, and fit.
2. **Generate a design.** Gemini specialists select parts from a small, sourced catalog. FORGE builds the circuit, firmware, BOM, and adjustable 3D enclosure from one versioned device specification.
3. **Inspect and test it.** Open a part to see its pin assignments, cost, and datasheet. Run firmware against synthetic muscle-signal inputs. Show a failing assertion, the repair an agent proposes, and the result of rerunning the test.
4. **Revise it.** Edit the wrist size or change the budget from $100 to $80. FORGE recomputes the affected artifacts and reports any constraint the supported catalog cannot satisfy.

The demo uses one ESP32 target and synthetic EMG envelope traces. Firmware behavior is the validation target. BLE hardware testing, individual-finger recognition on real users, and fabrication-ready outputs are future milestones.

## Workspace

| Area | What the user sees |
| --- | --- |
| Design controls | Requirements, budget, parts, compatibility, and enclosure dimensions |
| Prototype | Rotatable 3D assembly, wiring and schematic, firmware, and BOM |
| Agent activity | Tool results, design decisions, validation evidence, and revision diffs |

## Local reference checkout

The prep workspace keeps CircuitMind in its own Git checkout at `CircuitMind/`. To recreate the reference checkout, run these commands from the root.

```bash
git clone https://github.com/takemygunq/CircuitMind.git CircuitMind
git -C CircuitMind checkout --detach d5237aefb880bb4dff122f8be45c475b7b84c0c7
```

Use Node.js 24+ and Corepack to start CircuitMind's scripted demo locally.

```bash
cd CircuitMind
corepack pnpm install --frozen-lockfile
CIRCUITMIND_MOCK_AI=1 corepack pnpm dev
```

Open `http://localhost:3000` and try “Build an ESP32 weather station for my balcony.” This exercises the upstream pipeline using scripted model responses. [CircuitMind source and license](https://github.com/takemygunq/CircuitMind/tree/d5237aefb880bb4dff122f8be45c475b7b84c0c7)

The upstream type check passed, and its test suite reported 574 passed and 5 skipped. A local smoke test loaded the homepage and confirmed that the scripted weather-station request streamed a failed electrical check, a repair, and a passing result.

## Build plan

See the [MVP plan](docs/mvp-plan.md) for the integration order and repair scenario, and the [prototype pipeline](docs/prototype-pipeline.md) for the research-to-CAD handoff and editable Three.js workspace.

FORGE's judging demo centers on the autonomous repair loop. The event lists an overall competition and a Best Use of Managed Agents prize. The build plan includes a check for the actual Google Managed Agents integration and event requirements. [Gemini 4 NYC Hackathon](https://cerebralvalley.ai/e/gemini-4-nyc)
