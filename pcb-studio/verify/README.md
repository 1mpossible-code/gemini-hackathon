# Forge formal verification (Lean 4)

This directory holds a Lean 4 project that checks a Forge PCB design against
design rules and electrical constraints. It uses only core Lean 4, with no
Mathlib, so it builds in seconds.

```
Forge/Model.lean      discrete board model (µm, mV, mA, °C), logic families, gate model
Forge/Rules.lean      rule predicates, Bool checkers, general theorems (proved once)
Forge/Generated.lean  per-board certificate, written by src/verify/toLean.ts (git-ignored)
gen.mjs               CLI: regenerate / build / print results for the example board
```

```sh
node verify/gen.mjs --build --assumptions   # from pcb-studio/
cd verify && lake build Forge.Generated     # after Generated.lean exists
```

The studio calls `POST /api/verify {board}` (`server/verify.ts`). The server
writes `Generated.lean`, runs `lake build Forge.Generated` (timeout 180 s), maps
each Lean error to the theorem whose line span contains it, and returns
`{status, theorems:[{name, statement, ok}], log, durationMs, diagnostics, assumptions}`.
Results are cached by the SHA-256 of the generated source. Lean keeps
elaborating after a failed declaration, so each theorem passes or fails on its
own, and one failure does not hide the others.

## Model

- Geometry uses integer micrometres. Part bodies are axis-aligned boxes. Rotations
  are quarter turns (other angles are snapped, and the snap is listed as an
  assumption). Pads come from `padsFor`, bodies from `bodyFor`, and trace
  polylines from `routeNets`, which is the same data the 3D view renders.
  Bodies and pad copper are rounded outward. The pad core used for connectivity
  is rounded inward.
- A connection is one `board.nets[i]` entry: an ordered pin list joined by one
  polyline with a width and a layer. Several connections may share a net name.
- Electrical data has these parts: rails with a guaranteed window, per-part
  supply ranges, loads (peak and average), linear regulators (rating, θJA,
  TJmax), LED drives (V, Vf, R), and logic links (driver family to receiver
  family). The `Board` type has no electrical fields, so `toLean.ts` fills them
  from lookup tables keyed by MPN.
- Digital logic has two parts. `Family` holds VOL/VOH/VIL/VIH, the peak output
  voltage and the input absolute maximum. `Family.read` maps a voltage to
  `some bit` or to `none` (the forbidden band). `Gate` is a small combinational
  language. The TB6612FNG channel logic (IN1/IN2/PWM/STBY to the H-bridge switch
  enables) is modelled in `Gate`.

## General theorems (Rules.lean, proved for all boards)

| theorem | content |
|---|---|
| `checkAll_sound` | `checkAll b = true → AllRules b` (all 14 rules) |
| `checkX_iff` (×14) | each Bool checker decides its rule (sound and complete) |
| `pairwiseB_iff` | the pairwise checker decides `List.Pairwise` |
| `Box.disjoint_symm`, `noOverlap_symm`, `traceClearance_symm` | non-overlap and clearance are symmetric, so the `i<j` certificate covers every ordered pair `i≠j` |
| `totalPeak_append`, `totalPeak_sublist`, `powerBudget_of_sublist` | the load sum is additive and monotone, so removing loads never breaks a budget |
| `ohm_current_limit`, `ledSafe_of_le_ohms`, `ledSafe_of_le_vf` | Ohm's-law LED limit; a larger R or a higher Vf stays safe |
| `thermal_mono` | regulator dissipation is monotone in VIN and in I, so checking the top of the envelope suffices |
| `compat_read` | if a link is compatible, every voltage the driver emits for bit *b* is read as *b* and stays within the receiver's absolute maximum |
| `compat_of_dominates`, `Reaches.trans`, `Reaches.relays` | a stronger driver stays compatible; compatibility through buffers is transitive and relays every bit intact |
| `TB6612.no_shoot_through`, `no_double_high`, `standby_off` | the gate model never enables both switches of a half-bridge, never drives both outputs high, and STBY=L turns every switch off |

## Per-board theorems (Generated.lean)

Each per-board theorem is `(Rules.checkX_iff board).1 (by native_decide)`: the
checker runs on the concrete board, and the general lemma turns the result into
a proof of the rule. `native_decide` trusts the Lean compiler. That is the
standard trade-off for checks over large finite data.

| name | what is proven |
|---|---|
| `parts_within_outline` | every body box lies inside the outline. Edge-mount `usbc` parts may overhang by ≤ 1 mm. |
| `no_part_overlap` | the body boxes and mounting-hole boxes have pairwise disjoint interiors |
| `traces_meet_min_width` | width ≥ 0.127 mm for every trace; also states the narrowest trace |
| `trace_clearance` | same-layer segments of different nets keep ≥ 0.127 mm edge to edge. The distance is the exact segment-to-segment Euclidean distance in integers: a crossing test, then endpoint-to-segment distances. Pads and vias are not included. |
| `every_net_connected` | for each connection, a vertex of its trace lies in the (inward-rounded) pad of every listed pin |
| `no_pin_in_two_nets` | a pin that appears in two connections has the same net name in both (after aliases) |
| `power_budget` | Σ peak loads on each regulator output ≤ 80 % of its rating; also states the sum |
| `rail_voltage_compatible` | each supply or rating requirement contains its rail's whole guaranteed window |
| `logic_levels_compatible` | for every driver→receiver link: VOH ≥ VIH, VOL ≤ VIL, peak ≤ the receiver's absolute maximum (worst case over the rail window) |
| `led_current_safe` | (Vsrc,max − Vf,min)/R ≤ the LED's IF,max and the source's limit |
| `thermal_margin` | TA + (VIN − VOUT,min)·Iavg·θJA ≤ TJmax for VIN up to a stated limit. If the limit is below the input rail's maximum, the statement says so. |
| `trace_ampacity` | width ≥ k·I with k from IPC-2221, and I ≤ 3 A |
| `copper_edge_clearance` | trace vertices (± half width) and pad boxes stay ≥ 0.3 mm inside the edge |
| `annular_ring` | (min(pad w,h) − drill)/2 ≥ 0.13 mm for plated holes |
| `all_rules` | `checkAll board = true`, so `AllRules board` (via `checkAll_sound`) |

## Assumptions (lookup tables in `src/verify/toLean.ts`)

- **Design rules:** JLCPCB standard 2-layer: 0.127 mm track and space,
  0.3 mm copper to edge, 0.13 mm annular ring.
- **Rails:** +3V3 is 3.235–3.365 V (AMS1117-3.3 over temperature). VIN is
  6–12 V (the J6 label). VBUS is 4.75–5.25 V. `VM` is aliased to `VIN`
  because J6.1 is on both nets.
- **Parts:**
  - ESP32-WROOM-32E: 3.0–3.6 V; 500 mA peak, 240 mA average; CMOS levels
    0.8/0.1/0.75/0.25·VDD; inputs ≤ VDD + 0.3 V.
  - CH340C: 3.0–5.5 V; 20/15 mA; VOH ≥ VCC − 0.4 V; VIH/VIL 0.7/0.3·VCC.
  - TB6612FNG: VM 2.5–13.5 V; VCC 2.7–5.5 V at 2 mA; inputs 0.7/0.3·VCC,
    ≤ 5.5 V; 1.2 A per output.
  - AMS1117-3.3: VIN 4.6–15 V, 1 A rating; θJA 90 °C/W (SOT-223 with no
    extra copper); TA 25 °C; TJ ≤ 125 °C.
- **LEDs:** Vf ≥ 1.8 V (the lowest common indicator Vf, which overestimates
  current); IF ≤ 20 mA; GPIO source ≤ 20 mA. The source is the rail or GPIO
  found on the far side of the series resistor. If that side is unrouted, it is
  assumed to be +3V3.
- **Capacitors:** voltage ratings are parsed from the part description.
- **Unrouted supply pins** (the board data does not route every power pin):
  the part is assumed to sit on the rail in its table entry. Each such
  assumption is listed per part.
- **Ampacity:** IPC-2221 external layer, 1 oz copper, ΔT 20 °C. The required
  width grows as I^1.379, which is convex with w(0) = 0, so the chord from 0 to
  3 A lies above the curve. The check `w ≥ k·I` with k = ⌈w(3 A)/3 A⌉ therefore
  implies the IPC width for every I ≤ 3 A. Currents: the regulator rating on
  its output rail, 2.4 A per VM feed, 1.2 A per motor output, 1 A into the
  regulator, 500 mA on VBUS.
- **Logic links:** the board data does not record pin direction. Every net
  that joins two logic parts is therefore checked in each direction both parts
  can drive.

## Scope

These theorems show that the design, as modelled, meets the stated constraints
with the stated margins. They do **not** prove:

- that the design is optimal;
- that the footprint library matches the real parts;
- that the table values match a specific datasheet revision;
- anything about copper the board data does not describe, such as GND pours,
  stitching vias, or vias and pads in the clearance check;
- that traces are connected to each other (connectivity is checked per
  connection; nets split into separate copper islands are reported as warnings).
