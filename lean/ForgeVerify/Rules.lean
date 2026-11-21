/-
  FORGE Formal Hardware Verification Rulebook (Lean 4)
  Immutable domain predicates checked by the Lean 4 kernel.
  All quantities use exact integer units:
    - Voltage: millivolts (mV)
    - Current: milliamps (mA)
    - Cost:    minor currency units (USD cents)
-/
namespace ForgeVerify

abbrev Millivolts := Nat
abbrev Milliamps  := Nat
abbrev Cents      := Nat

def allDistinct (xs : List String) : Bool :=
  match xs with
  | [] => true
  | x :: rest => (!rest.contains x) && allDistinct rest

def allAnalogPinsValid
    (pins : List String)
    (wifiActive : Bool)
    (adcPins wifiConflictPins boardRestrictedAdcPins reservedPins : List String) : Bool :=
  match pins with
  | [] => true
  | p :: rest =>
      let ok :=
        adcPins.contains p &&
        (!reservedPins.contains p) &&
        (!boardRestrictedAdcPins.contains p) &&
        (!(wifiActive && wifiConflictPins.contains p))
      ok && allAnalogPinsValid rest wifiActive adcPins wifiConflictPins boardRestrictedAdcPins reservedPins

def allDigitalOutPinsValid
    (pins : List String)
    (digitalPins inputOnlyPins reservedPins : List String) : Bool :=
  match pins with
  | [] => true
  | p :: rest =>
      let ok :=
        digitalPins.contains p &&
        (!reservedPins.contains p) &&
        (!inputOnlyPins.contains p)
      ok && allDigitalOutPinsValid rest digitalPins inputOnlyPins reservedPins

/-- Controller rail exists on the board and lies within the sensor's rated operating supply range. -/
abbrev sensorSupplySafe
    (railMv minMv maxMv : Millivolts)
    (availableRailsMv : List Millivolts) : Prop :=
  availableRailsMv.contains railMv = true ∧ minMv ≤ railMv ∧ railMv ≤ maxMv

/-- Sensor maximum output voltage does not exceed the controller's rated ADC / I/O ceiling. -/
abbrev adcInputSafe (signalMaxMv adcMaxMv : Millivolts) : Prop :=
  signalMaxMv ≤ adcMaxMv

/-- Required analog channels and optional digital outputs use capable, unreserved, non-conflicting pins. -/
abbrev pinsValidAndDisjoint
    (requiredAnalogCount : Nat)
    (analogPins digitalOutPins : List String)
    (wifiActive : Bool)
    (adcPins digitalPins wifiConflictPins boardRestrictedAdcPins inputOnlyPins reservedPins : List String) : Prop :=
  analogPins.length = requiredAnalogCount ∧
  allAnalogPinsValid analogPins wifiActive adcPins wifiConflictPins boardRestrictedAdcPins reservedPins = true ∧
  allDigitalOutPinsValid digitalOutPins digitalPins inputOnlyPins reservedPins = true ∧
  allDistinct (analogPins ++ digitalOutPins) = true

/-- Total rail current draw does not exceed the controller supply rail current rating. -/
abbrev railCurrentSafe (totalDrawMa railLimitMa : Milliamps) : Prop :=
  totalDrawMa ≤ railLimitMa

/-- Known USD subtotal satisfies the user's strict (<) or inclusive (≤) budget cap. -/
abbrev budgetSatisfied (subtotalCents capCents : Cents) (exclusive : Bool) : Prop :=
  if exclusive then subtotalCents < capCents else subtotalCents ≤ capCents

/-- Controller supports the user's requested transport protocol. -/
abbrev transportSupported (requested : String) (supported : List String) : Prop :=
  (if requested == "wireless" then
    supported.contains "ble" || supported.contains "wifi"
  else
    supported.contains requested) = true

end ForgeVerify
