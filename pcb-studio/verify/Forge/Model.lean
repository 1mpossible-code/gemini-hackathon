/-!
# Forge.Model — a discrete model of a two-layer PCB

Everything is integral so that properties are decidable and can be checked by
evaluation:

* lengths / coordinates: micrometres (µm), `Int`, origin at the board centre,
  `+y` toward the front edge (same convention as `src/data/board.ts`)
* voltages: millivolts (mV), currents: milliamps (mA) or microamps (µA),
  resistance: ohms, thermal resistance: °C/W, temperatures: °C

The model is *extracted* from the TypeScript board description by
`src/verify/toLean.ts`; geometry derived from the footprint library is rounded
to whole µm (bodies and copper are rounded outward, see `Part.body`).
-/

namespace Forge

/-! ## Geometry -/

structure Pt where
  x : Int
  y : Int
deriving Repr, DecidableEq, Inhabited

/-- Closed axis-aligned box `[x0, x1] × [y0, y1]` in µm. -/
structure Box where
  x0 : Int
  y0 : Int
  x1 : Int
  y1 : Int
deriving Repr, DecidableEq, Inhabited

namespace Box

/-- Grow (or, with a negative margin, shrink) a box on every side. -/
def inflate (b : Box) (m : Int) : Box := ⟨b.x0 - m, b.y0 - m, b.x1 + m, b.y1 + m⟩

/-- `a` lies inside `b`. -/
def Within (a b : Box) : Prop := b.x0 ≤ a.x0 ∧ b.y0 ≤ a.y0 ∧ a.x1 ≤ b.x1 ∧ a.y1 ≤ b.y1

/-- The interiors of `a` and `b` are disjoint (touching edges is allowed). -/
def Disjoint (a b : Box) : Prop := a.x1 ≤ b.x0 ∨ b.x1 ≤ a.x0 ∨ a.y1 ≤ b.y0 ∨ b.y1 ≤ a.y0

/-- Point inside (closed) box. -/
def Contains (b : Box) (p : Pt) : Prop := b.x0 ≤ p.x ∧ p.x ≤ b.x1 ∧ b.y0 ≤ p.y ∧ p.y ≤ b.y1

instance (a b : Box) : Decidable (Within a b) := by unfold Within; infer_instance
instance (a b : Box) : Decidable (Disjoint a b) := by unfold Disjoint; infer_instance
instance (b : Box) (p : Pt) : Decidable (Contains b p) := by unfold Contains; infer_instance

/-- Box centred on `c` with half-extents `hx`, `hy`. -/
def around (c : Pt) (hx hy : Int) : Box := ⟨c.x - hx, c.y - hy, c.x + hx, c.y + hy⟩

end Box

/-- Rotate a local offset by `q` quarter turns, matching `toBoard` in
`src/pcb/footprint.ts` (CCW seen from above, board `+y` toward the viewer):
one quarter turn maps `(x, y) ↦ (y, -x)`. -/
def rotQ : Nat → Pt → Pt
  | 0, p => p
  | n + 1, p => rotQ n ⟨p.y, -p.x⟩

/-- Half of a non-negative length, rounded up (outward). -/
def halfUp (n : Nat) : Int := ((n + 1) / 2 : Nat)
/-- Half of a non-negative length, rounded down (inward). -/
def halfDown (n : Nat) : Int := (n / 2 : Nat)

/-! ## Parts, pads, nets, traces -/

structure Pad where
  /-- 1-based pin number (`"U1.2"` ↦ part `U1`, pin `2`) -/
  num : Nat
  /-- local centre offset (µm, part frame) -/
  x : Int
  y : Int
  w : Nat
  h : Nat
  /-- drill diameter in µm, `0` for SMD pads -/
  drill : Nat
deriving Repr, DecidableEq

structure Part where
  ref : String
  kind : String
  /-- board-space centre, µm -/
  x : Int
  y : Int
  /-- rotation in quarter turns (0‥3) -/
  quarter : Nat
  /-- body (courtyard) size in the part frame, µm -/
  bodyW : Nat
  bodyH : Nat
  /-- allowed overhang past the board edge (edge-mount connectors), µm -/
  overhang : Nat
  pads : List Pad
deriving Repr

namespace Part

def centre (p : Part) : Pt := ⟨p.x, p.y⟩

/-- Body bounding box in board space (rounded outward). -/
def body (p : Part) : Box :=
  if p.quarter % 2 = 0 then Box.around p.centre (halfUp p.bodyW) (halfUp p.bodyH)
  else Box.around p.centre (halfUp p.bodyH) (halfUp p.bodyW)

/-- Board-space centre of a pad. -/
def padCentre (p : Part) (d : Pad) : Pt :=
  let o := rotQ (p.quarter % 4) ⟨d.x, d.y⟩
  ⟨p.x + o.x, p.y + o.y⟩

/-- Pad copper extent, rounded outward (used for edge clearance). -/
def padBox (p : Part) (d : Pad) : Box :=
  if p.quarter % 2 = 0 then Box.around (p.padCentre d) (halfUp d.w) (halfUp d.h)
  else Box.around (p.padCentre d) (halfUp d.h) (halfUp d.w)

/-- Pad copper extent, rounded inward (used to decide that a trace reaches a pad). -/
def padCore (p : Part) (d : Pad) : Box :=
  if p.quarter % 2 = 0 then Box.around (p.padCentre d) (halfDown d.w) (halfDown d.h)
  else Box.around (p.padCentre d) (halfDown d.h) (halfDown d.w)

end Part

structure PinRef where
  ref : String
  pin : Nat
deriving Repr, DecidableEq

inductive Layer | top | bottom
deriving Repr, DecidableEq

/-- One routed connection: an ordered list of pins joined by a single
polyline of copper of constant width on one layer. Several connections may
share a net name. -/
structure Conn where
  net : String
  pins : List PinRef
  layer : Layer
  /-- trace width, µm -/
  width : Nat
  pts : List Pt
  /-- worst-case continuous current carried, mA (0 for signal nets) -/
  currentMa : Nat
deriving Repr

/-- A straight copper segment. -/
structure Seg where
  net : String
  layer : Layer
  width : Nat
  a : Pt
  b : Pt
deriving Repr

def segsOfPts (net : String) (l : Layer) (w : Nat) : List Pt → List Seg
  | a :: b :: rest => ⟨net, l, w, a, b⟩ :: segsOfPts net l w (b :: rest)
  | _ => []

def Conn.segs (c : Conn) : List Seg := segsOfPts c.net c.layer c.width c.pts

/-! ## Electrical model -/

/-- A supply rail with its guaranteed voltage window. -/
structure Rail where
  name : String
  minMv : Nat
  maxMv : Nat
deriving Repr

/-- A part's supply (or voltage-rating) requirement on one rail. -/
structure Supply where
  ref : String
  role : String
  rail : String
  minMv : Nat
  maxMv : Nat
deriving Repr

/-- A current draw on a rail. `peakMa` feeds the power budget, `avgMa` the
thermal (steady-state) check. -/
structure Load where
  ref : String
  rail : String
  peakMa : Nat
  avgMa : Nat
deriving Repr

/-- A linear regulator. Dissipation is `(Vin − Vout,min) · I`, evaluated at
`vinLimitMv`: the highest input voltage the thermal claim covers. When this is
below the input rail's maximum, the thermal theorem only covers that envelope
(and the UI statement says so). -/
structure Regulator where
  ref : String
  inRail : String
  outRail : String
  ratingMa : Nat
  vinLimitMv : Nat
  /-- junction-to-ambient thermal resistance, °C/W -/
  thetaJA : Nat
  ambientC : Nat
  tjMaxC : Nat
deriving Repr

/-- A resistor-limited LED: worst-case current is `(Vsrc,max − Vf,min) / R`. -/
structure LedDrive where
  led : String
  res : String
  srcMaxMv : Nat
  vfMinMv : Nat
  ohms : Nat
  /-- LED maximum continuous forward current, µA -/
  ledMaxUa : Nat
  /-- maximum current the source (GPIO pin or rail) may supply, µA -/
  srcMaxUa : Nat
deriving Repr

/-! ## Digital logic -/

/-- Worst-case electrical characteristics of a logic interface (mV).
`voh`/`vol` are the guaranteed output levels, `vih`/`vil` the input
thresholds, `vpeak` the highest voltage the output can reach and `vabs` the
highest voltage the input tolerates. -/
structure Family where
  name : String
  vol : Nat
  voh : Nat
  vil : Nat
  vih : Nat
  vpeak : Nat
  vabs : Nat
deriving Repr, DecidableEq

/-- Logic value carried by a voltage, as read by a receiver of family `f`:
`some b` when the voltage is a valid level, `none` in the forbidden band. -/
def Family.read (f : Family) (v : Nat) : Option Bool :=
  if v ≤ f.vil then some false else if f.vih ≤ v then some true else none

/-- Voltages family `f` may present on an output for logic value `b`. -/
def Family.Emits (f : Family) (b : Bool) (v : Nat) : Prop :=
  if b then f.voh ≤ v ∧ v ≤ f.vpeak else v ≤ f.vol

/-- A driver → receiver link on a named net. -/
structure Link where
  net : String
  drv : String
  rcv : String
  dfam : Family
  rfam : Family
deriving Repr

/-! ### Gate-level model -/

/-- Small combinational gate language for the logic used on the board. -/
inductive Gate
  | input (i : Nat)
  | const (b : Bool)
  | not (g : Gate)
  | and (a b : Gate)
  | or (a b : Gate)
deriving Repr

def Gate.eval (env : Nat → Bool) : Gate → Bool
  | .input i => env i
  | .const b => b
  | .not g => !g.eval env
  | .and a b => a.eval env && b.eval env
  | .or a b => a.eval env || b.eval env

/-- TB6612FNG control logic for one H-bridge channel, per the datasheet truth
table. Inputs: `0 = IN1`, `1 = IN2`, `2 = PWM`, `3 = STBY`.
Each output half-bridge has a high-side and a low-side switch enable.

| IN1 IN2 PWM STBY | OUT1 OUT2 |
|------------------|-----------|
| H   H   x   H    | L    L    (short brake) |
| L   H   H   H    | L    H    (CCW) |
| L   H   L   H    | L    L    (short brake) |
| H   L   H   H    | H    L    (CW) |
| H   L   L   H    | L    L    (short brake) |
| L   L   x   H    | off  off  (stop) |
| x   x   x   L    | off  off  (standby) |
-/
namespace TB6612
def in1 : Gate := .input 0
def in2 : Gate := .input 1
def pwm : Gate := .input 2
def stby : Gate := .input 3
/-- OUT1 high side: IN1 ∧ ¬IN2 ∧ PWM ∧ STBY -/
def hi1 : Gate := .and stby (.and pwm (.and in1 (.not in2)))
/-- OUT2 high side: IN2 ∧ ¬IN1 ∧ PWM ∧ STBY -/
def hi2 : Gate := .and stby (.and pwm (.and in2 (.not in1)))
/-- low sides: on whenever enabled and (IN1 ∨ IN2) and the own high side is off -/
def lo1 : Gate := .and stby (.and (.or in1 in2) (.not hi1))
def lo2 : Gate := .and stby (.and (.or in1 in2) (.not hi2))
end TB6612

/-! ## Design rules and the board -/

structure DesignRules where
  /-- minimum trace width, µm -/
  minTrace : Nat
  /-- minimum copper-to-copper clearance between different nets, µm -/
  minClear : Nat
  /-- minimum copper-to-board-edge clearance, µm -/
  edgeClear : Nat
  /-- minimum annular ring for plated holes, µm -/
  minRing : Nat
  /-- linearised ampacity: required width per amp, µm/A -/
  ampK : Nat
  /-- current up to which the linearisation is valid, mA -/
  ampMaxMa : Nat
  /-- power budget: allowed fraction of the regulator rating, percent -/
  budgetPct : Nat
deriving Repr

structure Hole where
  x : Int
  y : Int
  /-- diameter, µm -/
  d : Nat
deriving Repr

def Hole.box (h : Hole) : Box := Box.around ⟨h.x, h.y⟩ (halfUp h.d) (halfUp h.d)

structure Board where
  name : String
  outline : Box
  holes : List Hole
  parts : List Part
  conns : List Conn
  rails : List Rail
  supplies : List Supply
  loads : List Load
  regs : List Regulator
  leds : List LedDrive
  links : List Link
  rules : DesignRules
deriving Repr

namespace Board

/-- Keep-out boxes: every part body followed by every mounting hole. -/
def keepouts (b : Board) : List Box := b.parts.map Part.body ++ b.holes.map Hole.box

def segs (b : Board) : List Seg := b.conns.flatMap Conn.segs

def loadsOn (b : Board) (rail : String) : List Load := b.loads.filter (·.rail == rail)

end Board

/-- Sum of peak currents. -/
def totalPeak : List Load → Nat
  | [] => 0
  | l :: ls => l.peakMa + totalPeak ls

/-- Sum of average currents. -/
def totalAvg : List Load → Nat
  | [] => 0
  | l :: ls => l.avgMa + totalAvg ls

end Forge
