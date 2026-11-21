import Forge.Model

/-!
# Forge.Rules — design-rule predicates, executable checkers, and general theorems

Each rule is stated as a `Prop` over `Board` and paired with a `Bool` checker
`checkX`. The lemmas `checkX_iff` prove the checker is *sound and complete*
for its rule once and for all, so a per-board certificate only has to run the
checker (`native_decide`) and apply the lemma. `checkAll_sound` packages all
rules.

General (board-independent) results proved here:

* `pairwiseB_iff` — the pairwise checker decides `List.Pairwise`
* `Box.disjoint_symm`, `noOverlap_symm` — non-overlap is symmetric, so the
  `i < j` certificate gives every ordered pair `i ≠ j`
* `totalPeak_append`, `totalPeak_sublist`, `powerBudget_of_sublist` — the
  power budget sum is additive and monotone: removing loads never breaks it
* `ohm_current_limit`, `ledSafe_of_le_ohms` — Ohm's-law LED current limit and
  its monotonicity in R
* `compat_read`, `Reaches.trans`, `Reaches.relays`, `compat_of_dominates` — logic
  levels: a compatible link transmits every bit exactly; compatibility through
  buffer stages is transitive; a stronger driver stays compatible
* `TB6612.no_shoot_through` — the gate model of the H-bridge never enables both
  switches of one half-bridge
-/

namespace Forge

/-! ## Generic pairwise checker -/

def pairwiseB {α : Type} (r : α → α → Bool) : List α → Bool
  | [] => true
  | a :: l => l.all (r a) && pairwiseB r l

theorem pairwiseB_iff {α : Type} (r : α → α → Bool) (l : List α) :
    pairwiseB r l = true ↔ l.Pairwise (fun a b => r a b = true) := by
  induction l with
  | nil => simp [pairwiseB]
  | cons a l ih => simp [pairwiseB, List.pairwise_cons, ih, List.all_eq_true]

theorem pairwiseB_decide_iff {α : Type} (R : α → α → Prop) [∀ a b, Decidable (R a b)]
    (l : List α) : pairwiseB (fun a b => decide (R a b)) l = true ↔ l.Pairwise R := by
  rw [pairwiseB_iff]; simp

/-- A pairwise property of a symmetric relation holds for every pair of
distinct indices, in either order. -/
theorem pairwise_symm_getElem {α : Type} {R : α → α → Prop} (hs : ∀ a b, R a b → R b a)
    {l : List α} (h : l.Pairwise R) (i j : Nat) (hi : i < l.length) (hj : j < l.length)
    (hne : i ≠ j) : R l[i] l[j] := by
  rw [List.pairwise_iff_getElem] at h
  rcases Nat.lt_or_gt_of_ne hne with hlt | hgt
  · exact h i j hi hj hlt
  · exact hs _ _ (h j i hj hi hgt)

/-! ## Geometry -/

theorem Box.disjoint_symm (a b : Box) : a.Disjoint b ↔ b.Disjoint a := by
  unfold Box.Disjoint; constructor <;> intro h <;> omega

def sq (a : Int) : Int := a * a

/-- Squared Euclidean distance. -/
def dist2 (p q : Pt) : Int := sq (p.x - q.x) + sq (p.y - q.y)

/-- Exact integer test: the Euclidean distance from point `p` to the closed
segment `[a, b]` is at least `r` (for `r ≥ 0`). Uses the projection
parameter `t = (p−a)·(b−a) / |b−a|²` without dividing:
`t ≤ 0` → nearest point `a`; `t ≥ 1` → nearest point `b`; otherwise the
perpendicular distance `|(p−a)×(b−a)| / |b−a|`. -/
def ptSegFar (p a b : Pt) (r : Int) : Bool :=
  let vx := b.x - a.x
  let vy := b.y - a.y
  let wx := p.x - a.x
  let wy := p.y - a.y
  let dot := wx * vx + wy * vy
  let len2 := vx * vx + vy * vy
  if dot ≤ 0 then decide (r * r ≤ wx * wx + wy * wy)
  else if len2 ≤ dot then decide (r * r ≤ dist2 p b)
  else decide (r * r * len2 ≤ sq (wx * vy - wy * vx))

/-- Orientation of `c` relative to the directed line `a → b` (twice the signed area). -/
def orient (a b c : Pt) : Int := (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/-- The two segments cross at a single interior point. -/
def properCross (s t : Seg) : Bool :=
  decide (orient s.a s.b t.a * orient s.a s.b t.b < 0) &&
  decide (orient t.a t.b s.a * orient t.a t.b s.b < 0)

/-- Centre lines of `s` and `t` are at Euclidean distance `≥ r`. For two
non-crossing segments in the plane the minimum distance is attained at an
endpoint, so this is exact. -/
def segClear (s t : Seg) (r : Int) : Bool :=
  !properCross s t &&
  ptSegFar t.a s.a s.b r && ptSegFar t.b s.a s.b r &&
  ptSegFar s.a t.a t.b r && ptSegFar s.b t.a t.b r

theorem properCross_symm (s t : Seg) : properCross s t = properCross t s := by
  simp [properCross, Bool.and_comm]

theorem segClear_symm (s t : Seg) (r : Int) : segClear s t r = segClear t s r := by
  unfold segClear
  rw [properCross_symm]
  cases properCross t s <;>
    cases ptSegFar t.a s.a s.b r <;> cases ptSegFar t.b s.a s.b r <;>
    cases ptSegFar s.a t.a t.b r <;> cases ptSegFar s.b t.a t.b r <;> rfl

/-! ## Power -/

theorem totalPeak_append (l m : List Load) : totalPeak (l ++ m) = totalPeak l + totalPeak m := by
  induction l with
  | nil => simp [totalPeak]
  | cons a l ih => simp [totalPeak, ih]; omega

/-- The power-budget sum is monotone: a sub-list of loads never draws more. -/
theorem totalPeak_sublist {l m : List Load} (h : l.Sublist m) : totalPeak l ≤ totalPeak m := by
  induction h with
  | slnil => exact Nat.le_refl _
  | cons a _ ih => simp only [totalPeak]; omega
  | cons₂ a _ ih => simp only [totalPeak]; omega

theorem totalAvg_sublist {l m : List Load} (h : l.Sublist m) : totalAvg l ≤ totalAvg m := by
  induction h with
  | slnil => exact Nat.le_refl _
  | cons a _ ih => simp only [totalAvg]; omega
  | cons₂ a _ ih => simp only [totalAvg]; omega

/-- Adding a load can only increase the sum. -/
theorem totalPeak_cons_ge (a : Load) (l : List Load) : totalPeak l ≤ totalPeak (a :: l) := by
  simp only [totalPeak]; omega

/-- If a budget holds for a set of loads it holds for any subset of them. -/
theorem powerBudget_of_sublist {l m : List Load} (h : l.Sublist m) (rating pct : Nat)
    (hm : totalPeak m * 100 ≤ rating * pct) : totalPeak l * 100 ≤ rating * pct :=
  Nat.le_trans (Nat.mul_le_mul_right 100 (totalPeak_sublist h)) hm

/-! ## Ohm's law -/

/-- Ohm's law current limit: if `(V − Vf)·1000 ≤ Imax·R` (mV, Ω, µA), the
resistor current `I = (V − Vf)/R` is at most `Imax`. The hypothesis is the
cross-multiplied, division-free form of `(V − Vf)/R ≤ Imax`, which is exact
over the rationals; the conclusion is the same bound for the floor-division
current. -/
theorem ohm_current_limit {v vf r imax : Nat} (h : (v - vf) * 1000 ≤ imax * r) :
    (v - vf) * 1000 / r ≤ imax := by
  rcases Nat.eq_zero_or_pos r with hr | hr
  · subst hr; simp
  · exact (Nat.div_le_iff_le_mul_add_pred hr).2 (by
      have := Nat.mul_comm imax r; omega)

/-- A larger series resistor keeps a safe LED safe. -/
theorem ledSafe_of_le_ohms {v vf r r' imax : Nat} (hr : r ≤ r')
    (h : (v - vf) * 1000 ≤ imax * r) : (v - vf) * 1000 ≤ imax * r' :=
  Nat.le_trans h (Nat.mul_le_mul_left imax hr)

/-- A higher minimum forward voltage keeps a safe LED safe. -/
theorem ledSafe_of_le_vf {v vf vf' r imax : Nat} (hv : vf ≤ vf')
    (h : (v - vf) * 1000 ≤ imax * r) : (v - vf') * 1000 ≤ imax * r :=
  Nat.le_trans (Nat.mul_le_mul_right 1000 (by omega)) h

/-! ## Thermal -/

/-- Linear-regulator dissipation `(Vin − Vout)·I·θ` is monotone in `Vin` and in
`I`, so a bound at the top of the envelope covers every lower input voltage
and every smaller load. -/
theorem thermal_mono {vin vin' vout i i' θ : Nat} (hv : vin ≤ vin') (hi : i ≤ i') :
    (vin - vout) * i * θ ≤ (vin' - vout) * i' * θ :=
  Nat.mul_le_mul_right θ (Nat.mul_le_mul (by omega) hi)

/-! ## Logic levels -/

/-- Driver family `d` is compatible with receiver family `r`: a guaranteed
high is read as high, a guaranteed low as low, the receiver's thresholds are
well-formed, and the driver never exceeds the receiver's absolute maximum. -/
def Compat (d r : Family) : Prop :=
  r.vil < r.vih ∧ r.vih ≤ d.voh ∧ d.vol ≤ r.vil ∧ d.vpeak ≤ r.vabs

instance (d r : Family) : Decidable (Compat d r) := by unfold Compat; infer_instance

/-- Soundness of the static check: every voltage the driver can emit for bit
`b` is read by the receiver as exactly `b`, and is within its absolute max. -/
theorem compat_read {d r : Family} (h : Compat d r) (b : Bool) (v : Nat)
    (hv : d.Emits b v) : r.read v = some b ∧ v ≤ r.vabs := by
  unfold Compat at h
  unfold Family.Emits at hv
  unfold Family.read
  cases b
  · simp at hv
    have h1 : v ≤ r.vil := by omega
    simp [h1]; omega
  · simp at hv
    have h1 : ¬ v ≤ r.vil := by omega
    have h2 : r.vih ≤ v := by omega
    simp [h1, h2]; omega

/-- Driver `d'` is at least as strong as `d`. -/
def Dominates (d' d : Family) : Prop := d.voh ≤ d'.voh ∧ d'.vol ≤ d.vol ∧ d'.vpeak ≤ d.vpeak

theorem compat_of_dominates {d d' r : Family} (hd : Dominates d' d) (h : Compat d r) :
    Compat d' r := by
  unfold Dominates at hd; unfold Compat at *; omega

/-- `Reaches a c`: there is a chain of buffer stages `a → s₁ → … → c` in which
every hop is `Compat`. -/
inductive Reaches : Family → Family → Prop
  | single {a b : Family} : Compat a b → Reaches a b
  | tail {a b c : Family} : Reaches a b → Compat b c → Reaches a c

/-- Compatibility through buffers is transitive. -/
theorem Reaches.trans {a b c : Family} (h₁ : Reaches a b) (h₂ : Reaches b c) : Reaches a c := by
  induction h₂ with
  | single h => exact .tail h₁ h
  | tail _ h ih => exact .tail ih h

/-- `Relays a c bit`: bit `bit`, driven by `a` and re-driven by each buffer as
read, arrives at `c` as `bit` on every hop. -/
inductive Relays : Family → Family → Bool → Prop
  | hop {a c : Family} {bit : Bool} :
      (∀ v, a.Emits bit v → c.read v = some bit ∧ v ≤ c.vabs) → Relays a c bit
  | buf {a m c : Family} {bit : Bool} : Relays a m bit →
      (∀ v, m.Emits bit v → c.read v = some bit ∧ v ≤ c.vabs) → Relays a c bit

/-- A chain of compatible links stays compatible: every bit is relayed intact. -/
theorem Reaches.relays {a c : Family} (h : Reaches a c) (bit : Bool) : Relays a c bit := by
  induction h with
  | single h => exact .hop (compat_read h bit)
  | tail _ h ih => exact .buf ih (compat_read h bit)

/-! ## Gate-level model -/

/-- Environment from the four TB6612 control inputs. -/
def env4 (in1 in2 pwm stby : Bool) : Nat → Bool
  | 0 => in1 | 1 => in2 | 2 => pwm | 3 => stby | _ => false

/-- No shoot-through: for every input combination, neither half-bridge has
both its high-side and low-side switch enabled. -/
theorem TB6612.no_shoot_through (in1 in2 pwm stby : Bool) :
    let e := env4 in1 in2 pwm stby
    (TB6612.hi1.eval e && TB6612.lo1.eval e) = false ∧
    (TB6612.hi2.eval e && TB6612.lo2.eval e) = false := by
  cases in1 <;> cases in2 <;> cases pwm <;> cases stby <;> decide

/-- Outputs are never driven in opposite directions at the same time
(no OUT1-high with OUT2-high, i.e. no ambiguous drive). -/
theorem TB6612.no_double_high (in1 in2 pwm stby : Bool) :
    let e := env4 in1 in2 pwm stby
    (TB6612.hi1.eval e && TB6612.hi2.eval e) = false := by
  cases in1 <;> cases in2 <;> cases pwm <;> cases stby <;> decide

/-- Standby disables every switch. -/
theorem TB6612.standby_off (in1 in2 pwm : Bool) :
    let e := env4 in1 in2 pwm false
    TB6612.hi1.eval e = false ∧ TB6612.lo1.eval e = false ∧
    TB6612.hi2.eval e = false ∧ TB6612.lo2.eval e = false := by
  cases in1 <;> cases in2 <;> cases pwm <;> decide

/-! ## Board rules -/

namespace Rules
variable (b : Board)

/-- Every part body lies inside the outline, grown by that part's permitted
edge overhang (non-zero only for edge-mount connectors). -/
def PartsWithin : Prop := ∀ p ∈ b.parts, p.body.Within (b.outline.inflate p.overhang)

/-- Part bodies and mounting holes pairwise have disjoint interiors. -/
def NoOverlap : Prop := b.keepouts.Pairwise Box.Disjoint

def MinWidth : Prop := ∀ c ∈ b.conns, b.rules.minTrace ≤ c.width

/-- Required centre-line distance between two segments. -/
def clearReq (s t : Seg) : Int := (b.rules.minClear : Int) + halfUp (s.width + t.width)

/-- Any two copper segments of different nets on the same layer keep
`minClear` edge-to-edge (centre lines `≥ minClear + (w₁+w₂)/2` apart). -/
def TraceClearance : Prop :=
  b.segs.Pairwise (fun s t => s.net ≠ t.net → s.layer = t.layer → segClear s t (clearReq b s t) = true)

/-- Every routed connection has copper, and each of its pins exists and has a
vertex of the connection's polyline inside its pad. A polyline is connected,
so every pin of the connection is joined to every other. -/
def NetsConnected : Prop :=
  ∀ c ∈ b.conns, c.pts ≠ [] ∧ ∀ pr ∈ c.pins, ∃ p ∈ b.parts, p.ref = pr.ref ∧
    ∃ d ∈ p.pads, d.num = pr.pin ∧ ∃ v ∈ c.pts, (p.padCore d).Contains v

/-- A pin listed in two connections belongs to the same net in both. -/
def UniquePinNets : Prop :=
  ∀ c₁ ∈ b.conns, ∀ c₂ ∈ b.conns, ∀ pr ∈ c₁.pins, pr ∈ c₂.pins → c₁.net = c₂.net

/-- For every regulator: peak load on its output ≤ `budgetPct` % of its rating. -/
def PowerBudget : Prop :=
  ∀ r ∈ b.regs, totalPeak (b.loadsOn r.outRail) * 100 ≤ r.ratingMa * b.rules.budgetPct

/-- Every supply requirement names an existing rail whose whole voltage
window lies within the part's allowed range. -/
def RailsCompatible : Prop :=
  ∀ s ∈ b.supplies, ∃ r ∈ b.rails, r.name = s.rail ∧ s.minMv ≤ r.minMv ∧ r.maxMv ≤ s.maxMv

def LogicCompatible : Prop := ∀ l ∈ b.links, Compat l.dfam l.rfam

/-- Worst-case LED current `(Vsrc,max − Vf,min)/R` is within both the LED's and
the source's limits. -/
def LedsSafe : Prop :=
  ∀ d ∈ b.leds, 0 < d.ohms ∧ (d.srcMaxMv - d.vfMinMv) * 1000 ≤ d.ledMaxUa * d.ohms ∧
    (d.srcMaxMv - d.vfMinMv) * 1000 ≤ d.srcMaxUa * d.ohms

/-- Junction temperature `Ta + (Vin − Vout,min)·Iavg·θJA ≤ Tj,max`
(mV·mA·°C/W = µ°C) for every input `Vin` from the input rail's minimum up to the
regulator's `vinLimitMv`. Dissipation is monotone in `Vin`, so checking the
top of the envelope suffices (`thermal_mono`). -/
def ThermalOk : Prop :=
  ∀ r ∈ b.regs, ∃ ri ∈ b.rails, ri.name = r.inRail ∧ ri.minMv ≤ r.vinLimitMv ∧
    ∃ ro ∈ b.rails, ro.name = r.outRail ∧
    (r.vinLimitMv - ro.minMv) * totalAvg (b.loadsOn r.outRail) * r.thetaJA + r.ambientC * 1000000
      ≤ r.tjMaxC * 1000000

/-- Every connection's current is within the linearisation range and its width
is at least `ampK · I` (µm/A · mA = µm/1000). -/
def Ampacity : Prop :=
  ∀ c ∈ b.conns, c.currentMa ≤ b.rules.ampMaxMa ∧ b.rules.ampK * c.currentMa ≤ c.width * 1000

/-- Copper (trace vertices with half-width, and pads) stays `edgeClear` inside
the outline. Trace copper between two vertices lies in the hull of the
vertex boxes, so checking vertices suffices. -/
def EdgeClearance : Prop :=
  (∀ c ∈ b.conns, ∀ v ∈ c.pts,
      (Box.around v (halfUp c.width) (halfUp c.width)).Within (b.outline.inflate (-(b.rules.edgeClear : Int)))) ∧
  (∀ p ∈ b.parts, ∀ d ∈ p.pads, (p.padBox d).Within (b.outline.inflate (-(b.rules.edgeClear : Int))))

def AnnularRing : Prop :=
  ∀ p ∈ b.parts, ∀ d ∈ p.pads, 0 < d.drill → d.drill + 2 * b.rules.minRing ≤ min d.w d.h

/-! ### Checkers -/

def checkPartsWithin : Bool := b.parts.all fun p => decide (p.body.Within (b.outline.inflate p.overhang))
def checkNoOverlap : Bool := pairwiseB (fun x y => decide (Box.Disjoint x y)) b.keepouts
def checkMinWidth : Bool := b.conns.all fun c => decide (b.rules.minTrace ≤ c.width)
def checkTraceClearance : Bool :=
  pairwiseB (fun s t => decide (s.net ≠ t.net → s.layer = t.layer → segClear s t (clearReq b s t) = true)) b.segs
def checkNetsConnected : Bool :=
  b.conns.all fun c => !c.pts.isEmpty && c.pins.all fun pr => b.parts.any fun p => decide (p.ref = pr.ref) &&
    p.pads.any fun d => decide (d.num = pr.pin) && c.pts.any fun v => decide ((p.padCore d).Contains v)
def checkUniquePinNets : Bool :=
  b.conns.all fun c₁ => b.conns.all fun c₂ => c₁.pins.all fun pr => decide (pr ∈ c₂.pins → c₁.net = c₂.net)
def checkPowerBudget : Bool :=
  b.regs.all fun r => decide (totalPeak (b.loadsOn r.outRail) * 100 ≤ r.ratingMa * b.rules.budgetPct)
def checkRailsCompatible : Bool :=
  b.supplies.all fun s => b.rails.any fun r => decide (r.name = s.rail ∧ s.minMv ≤ r.minMv ∧ r.maxMv ≤ s.maxMv)
def checkLogicCompatible : Bool := b.links.all fun l => decide (Compat l.dfam l.rfam)
def checkLedsSafe : Bool :=
  b.leds.all fun d => decide (0 < d.ohms ∧ (d.srcMaxMv - d.vfMinMv) * 1000 ≤ d.ledMaxUa * d.ohms ∧
    (d.srcMaxMv - d.vfMinMv) * 1000 ≤ d.srcMaxUa * d.ohms)
def checkThermalOk : Bool :=
  b.regs.all fun r => b.rails.any fun ri => decide (ri.name = r.inRail ∧ ri.minMv ≤ r.vinLimitMv) &&
    b.rails.any fun ro =>
    decide (ro.name = r.outRail ∧ (r.vinLimitMv - ro.minMv) * totalAvg (b.loadsOn r.outRail) * r.thetaJA +
      r.ambientC * 1000000 ≤ r.tjMaxC * 1000000)
def checkAmpacity : Bool :=
  b.conns.all fun c => decide (c.currentMa ≤ b.rules.ampMaxMa ∧ b.rules.ampK * c.currentMa ≤ c.width * 1000)
def checkEdgeClearance : Bool :=
  (b.conns.all fun c => c.pts.all fun v =>
    decide ((Box.around v (halfUp c.width) (halfUp c.width)).Within (b.outline.inflate (-(b.rules.edgeClear : Int))))) &&
  (b.parts.all fun p => p.pads.all fun d => decide ((p.padBox d).Within (b.outline.inflate (-(b.rules.edgeClear : Int)))))
def checkAnnularRing : Bool :=
  b.parts.all fun p => p.pads.all fun d => decide (0 < d.drill → d.drill + 2 * b.rules.minRing ≤ min d.w d.h)

/-! ### Checker soundness and completeness -/

theorem checkPartsWithin_iff : checkPartsWithin b = true ↔ PartsWithin b := by
  simp [checkPartsWithin, PartsWithin]
theorem checkNoOverlap_iff : checkNoOverlap b = true ↔ NoOverlap b :=
  pairwiseB_decide_iff _ _
theorem checkMinWidth_iff : checkMinWidth b = true ↔ MinWidth b := by
  simp [checkMinWidth, MinWidth]
theorem checkTraceClearance_iff : checkTraceClearance b = true ↔ TraceClearance b :=
  pairwiseB_decide_iff _ _
theorem checkNetsConnected_iff : checkNetsConnected b = true ↔ NetsConnected b := by
  simp [checkNetsConnected, NetsConnected, List.isEmpty_iff]
theorem checkUniquePinNets_iff : checkUniquePinNets b = true ↔ UniquePinNets b := by
  simp [checkUniquePinNets, UniquePinNets]
theorem checkPowerBudget_iff : checkPowerBudget b = true ↔ PowerBudget b := by
  simp [checkPowerBudget, PowerBudget]
theorem checkRailsCompatible_iff : checkRailsCompatible b = true ↔ RailsCompatible b := by
  simp [checkRailsCompatible, RailsCompatible]
theorem checkLogicCompatible_iff : checkLogicCompatible b = true ↔ LogicCompatible b := by
  simp [checkLogicCompatible, LogicCompatible]
theorem checkLedsSafe_iff : checkLedsSafe b = true ↔ LedsSafe b := by
  simp [checkLedsSafe, LedsSafe]
theorem checkThermalOk_iff : checkThermalOk b = true ↔ ThermalOk b := by
  simp [checkThermalOk, ThermalOk]
theorem checkAmpacity_iff : checkAmpacity b = true ↔ Ampacity b := by
  simp [checkAmpacity, Ampacity]
theorem checkEdgeClearance_iff : checkEdgeClearance b = true ↔ EdgeClearance b := by
  simp [checkEdgeClearance, EdgeClearance]
theorem checkAnnularRing_iff : checkAnnularRing b = true ↔ AnnularRing b := by
  simp [checkAnnularRing, AnnularRing]

/-- All rules at once. -/
def AllRules : Prop :=
  PartsWithin b ∧ NoOverlap b ∧ MinWidth b ∧ TraceClearance b ∧ NetsConnected b ∧
  UniquePinNets b ∧ PowerBudget b ∧ RailsCompatible b ∧ LogicCompatible b ∧ LedsSafe b ∧
  ThermalOk b ∧ Ampacity b ∧ EdgeClearance b ∧ AnnularRing b

def checkAll : Bool :=
  checkPartsWithin b && checkNoOverlap b && checkMinWidth b && checkTraceClearance b &&
  checkNetsConnected b && checkUniquePinNets b && checkPowerBudget b && checkRailsCompatible b &&
  checkLogicCompatible b && checkLedsSafe b && checkThermalOk b && checkAmpacity b &&
  checkEdgeClearance b && checkAnnularRing b

/-- Checker soundness: a board that passes `checkAll` satisfies every rule. -/
theorem checkAll_sound (h : checkAll b = true) : AllRules b := by
  simp only [checkAll, Bool.and_eq_true] at h
  obtain ⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩, h6⟩, h7⟩, h8⟩, h9⟩, h10⟩, h11⟩, h12⟩, h13⟩, h14⟩ := h
  exact ⟨(checkPartsWithin_iff b).1 h1, (checkNoOverlap_iff b).1 h2, (checkMinWidth_iff b).1 h3,
    (checkTraceClearance_iff b).1 h4, (checkNetsConnected_iff b).1 h5, (checkUniquePinNets_iff b).1 h6,
    (checkPowerBudget_iff b).1 h7, (checkRailsCompatible_iff b).1 h8, (checkLogicCompatible_iff b).1 h9,
    (checkLedsSafe_iff b).1 h10, (checkThermalOk_iff b).1 h11, (checkAmpacity_iff b).1 h12,
    (checkEdgeClearance_iff b).1 h13, (checkAnnularRing_iff b).1 h14⟩

/-- Non-overlap is symmetric: from the `i < j` certificate, every ordered pair
of distinct keep-outs is disjoint. -/
theorem noOverlap_symm (h : NoOverlap b) (i j : Nat) (hi : i < b.keepouts.length)
    (hj : j < b.keepouts.length) (hne : i ≠ j) : Box.Disjoint b.keepouts[i] b.keepouts[j] :=
  pairwise_symm_getElem (fun x y => (Box.disjoint_symm x y).1) h i j hi hj hne

/-- Trace clearance is symmetric in the same sense. -/
theorem traceClearance_symm (h : TraceClearance b) (i j : Nat) (hi : i < b.segs.length)
    (hj : j < b.segs.length) (hne : i ≠ j) :
    b.segs[i].net ≠ b.segs[j].net → b.segs[i].layer = b.segs[j].layer →
      segClear b.segs[i] b.segs[j] (clearReq b b.segs[i] b.segs[j]) = true := by
  refine pairwise_symm_getElem (R := fun s t => s.net ≠ t.net → s.layer = t.layer →
      segClear s t (clearReq b s t) = true) ?_ h i j hi hj hne
  intro s t hst hn hl
  have : clearReq b t s = clearReq b s t := by unfold clearReq; rw [Nat.add_comm]
  rw [segClear_symm, ← this]
  exact hst (Ne.symm hn) hl.symm

end Rules

/-! ## Diagnostics (not part of the trusted argument; for humans) -/

namespace Report

def showPt (p : Pt) : String := s!"({p.x},{p.y})µm"

def lines (b : Board) : List String := Id.run do
  let mut out : List String := []
  for p in b.parts do
    unless decide (p.body.Within (b.outline.inflate p.overhang)) do
      out := out ++ [s!"parts_within_outline|{p.ref} body extends past the outline"]
  let named := b.parts.map (fun p => (p.ref, p.body)) ++ b.holes.map (fun h => (s!"hole{showPt ⟨h.x, h.y⟩}", h.box))
  let rec pairs : List (String × Box) → List String
    | [] => []
    | (n, x) :: rest => (rest.filterMap fun (m, y) =>
        if decide (Box.Disjoint x y) then none else some s!"no_part_overlap|{n} overlaps {m}") ++ pairs rest
  out := out ++ pairs named
  for c in b.conns do
    unless decide (b.rules.minTrace ≤ c.width) do
      out := out ++ [s!"traces_meet_min_width|{c.net} is {c.width}µm < {b.rules.minTrace}µm"]
  let rec segPairs : List Seg → List String
    | [] => []
    | s :: rest => (rest.filterMap fun t =>
        if s.net ≠ t.net ∧ s.layer = t.layer ∧ segClear s t (Rules.clearReq b s t) = false then
          some s!"trace_clearance|{s.net} {showPt s.a}-{showPt s.b} vs {t.net} {showPt t.a}-{showPt t.b} ({repr s.layer})"
        else none) ++ segPairs rest
  out := out ++ (segPairs b.segs).take 20
  for c in b.conns do
    for pr in c.pins do
      let ok := b.parts.any fun p => decide (p.ref = pr.ref) && p.pads.any fun d =>
        decide (d.num = pr.pin) && c.pts.any fun v => decide ((p.padCore d).Contains v)
      unless ok do out := out ++ [s!"every_net_connected|{c.net}: {pr.ref}.{pr.pin} not reached"]
  for c₁ in b.conns do
    for c₂ in b.conns do
      for pr in c₁.pins do
        if pr ∈ c₂.pins ∧ c₁.net ≠ c₂.net ∧ c₁.net < c₂.net then
          out := out ++ [s!"no_pin_in_two_nets|{pr.ref}.{pr.pin} in {c₁.net} and {c₂.net}"]
  for r in b.regs do
    let t := totalPeak (b.loadsOn r.outRail)
    out := out ++ [s!"info|power {r.outRail} peak {t} mA, avg {totalAvg (b.loadsOn r.outRail)} mA"]
  for c in b.conns do
    unless decide (c.currentMa ≤ b.rules.ampMaxMa ∧ b.rules.ampK * c.currentMa ≤ c.width * 1000) do
      out := out ++ [s!"trace_ampacity|{c.net} {c.width}µm for {c.currentMa} mA"]
  for l in b.links do
    unless decide (Compat l.dfam l.rfam) do
      out := out ++ [s!"logic_levels_compatible|{l.net}: {l.drv} ({l.dfam.name}) → {l.rcv} ({l.rfam.name})"]
  for s in b.supplies do
    let ok := b.rails.any fun r => decide (r.name = s.rail ∧ s.minMv ≤ r.minMv ∧ r.maxMv ≤ s.maxMv)
    unless ok do out := out ++ [s!"rail_voltage_compatible|{s.ref} {s.role} on {s.rail} needs {s.minMv}–{s.maxMv} mV"]
  return out

end Report

end Forge
