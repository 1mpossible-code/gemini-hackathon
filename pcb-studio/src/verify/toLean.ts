// Board → Lean 4 certificate (verify/Forge/Generated.lean).
//
// Geometry comes from the same footprint library the 3D view uses (padsFor, bodyFor,
// routeNets), converted to integer micrometres. Electrical data the Board type does not
// carry (supply ranges, currents, logic thresholds) comes from the lookup tables below;
// every value used is listed in `assumptions` so the UI can show what was assumed.
//
// The certificate proves the board satisfies the stated constraints with the stated
// margins. It does not prove the design is optimal, that the footprint library matches
// the real parts, or anything about nets the Board does not describe (e.g. GND pours).

import type { Board, Part } from '@/data/board'
import { bodyFor, padsFor, routeNets } from '@/pcb/footprint'
import type { Certificate, TheoremSpec } from './types'

// ---------------------------------------------------------------------------------------
// Design rules (JLCPCB standard 2-layer, 1 oz outer copper)

export const RULES = {
  minTraceUm: 127, // 0.127 mm (5 mil) minimum track
  minClearUm: 127, // 0.127 mm (5 mil) minimum spacing
  edgeClearUm: 300, // copper to board edge
  minRingUm: 130, // minimum annular ring
  budgetPct: 80, // power budget: use at most 80 % of a regulator's rating
  ampDeltaTC: 20, // IPC-2221 allowed temperature rise
  ampMaxMa: 3000, // linearised ampacity bound is valid up to 3 A
  copperOz: 1,
}

/** IPC-2221 external-layer trace width (µm) for current `amps`: I = 0.048·ΔT^0.44·A^0.725, A in mil². */
export function ipcWidthUm(amps: number, deltaT = RULES.ampDeltaTC, oz = RULES.copperOz): number {
  const areaMil2 = (amps / (0.048 * deltaT ** 0.44)) ** (1 / 0.725)
  const widthMil = areaMil2 / (1.378 * oz)
  return widthMil * 25.4
}

/**
 * Width per amp (µm/A) of the chord from 0 to ampMaxMa. Required width ∝ I^1.379 is convex
 * with w(0) = 0, so the chord lies above the IPC curve on [0, ampMaxMa]: w ≥ k·I there
 * implies the IPC-2221 width is met.
 */
export const AMP_K_UM_PER_A = Math.ceil(ipcWidthUm(RULES.ampMaxMa / 1000) / (RULES.ampMaxMa / 1000))

// ---------------------------------------------------------------------------------------
// Electrical lookup tables (documented assumptions)

/** Net-name aliases: names that denote the same electrical node. */
const NET_ALIASES: Record<string, { to: string; why: string }> = {
  VM: { to: 'VIN', why: 'VM (TB6612 motor supply) is fed straight from the J6 input terminal (J6.1 is on both), so VM ≡ VIN' },
}

interface RailSpec { match: RegExp; minMv: number; maxMv: number; why: string }
const RAILS: RailSpec[] = [
  { match: /^\+?3V3$/i, minMv: 3235, maxMv: 3365, why: '+3V3: AMS1117-3.3 output 3.235–3.365 V (datasheet, full temperature range)' },
  { match: /^(VIN|VM|VMOT)$/i, minMv: 6000, maxMv: 12000, why: 'VIN: 6–12 V (J6 "6–12 V supply input")' },
  { match: /^(VBUS|\+?5V)$/i, minMv: 4750, maxMv: 5250, why: 'VBUS/5V: 4.75–5.25 V (USB 2.0)' },
  { match: /^\+?12V$/i, minMv: 11400, maxMv: 12600, why: '+12V: ±5 %' },
]

interface LogicSpec {
  /** output and input levels as a function of the part's Vcc (mV) */
  voh: (vcc: number) => number
  vol: (vcc: number) => number
  vih: (vcc: number) => number
  vil: (vcc: number) => number
  vabs: (vcc: number) => number
  drives: boolean
  receives: boolean
  /** supply role that sets Vcc */
  role: string
}

interface SupplySpec {
  role: string
  minMv: number
  maxMv: number
  /** pins that carry this supply, when the board's pin numbering matches the datasheet */
  pins?: number[]
  /** rail-name pattern to look for among the part's nets */
  match: RegExp
  /** rail to assume when the supply pin is not routed in the board data */
  assume?: string
  peakMa?: number
  avgMa?: number
}

interface ElecSpec {
  label: string
  supplies: SupplySpec[]
  logic?: LogicSpec
  /** continuous output current per channel into an off-board connector (motor drivers) */
  outputMa?: number
  /** continuous current drawn through each supply connection on a non-regulated rail */
  railCurrentMa?: Record<string, number>
  regulator?: { ratingMa: number; thetaJA: number; ambientC: number; tjMaxC: number; inRole: string; outRole: string }
  source: string
}

const cmos = (frac: { voh: number; vol: number; vih: number; vil: number }, absOver: number, drives: boolean, receives: boolean, role: string): LogicSpec => ({
  voh: (v) => Math.floor(v * frac.voh),
  vol: (v) => Math.ceil(v * frac.vol),
  vih: (v) => Math.ceil(v * frac.vih),
  vil: (v) => Math.floor(v * frac.vil),
  vabs: (v) => v + absOver,
  drives,
  receives,
  role,
})

const BY_MPN: { match: RegExp; spec: ElecSpec }[] = [
  {
    match: /^ESP32-WROOM/i,
    spec: {
      label: 'ESP32-WROOM-32E',
      supplies: [{ role: 'VDD', minMv: 3000, maxMv: 3600, pins: [2], match: /3V3/i, assume: '+3V3', peakMa: 500, avgMa: 240 }],
      logic: cmos({ voh: 0.8, vol: 0.1, vih: 0.75, vil: 0.25 }, 300, true, true, 'VDD'),
      source: 'ESP32-WROOM-32E: VDD 3.0–3.6 V; 500 mA peak (datasheet supply recommendation), 240 mA continuous (802.11b TX); VOH 0.8·VDD, VOL 0.1·VDD, VIH 0.75·VDD, VIL 0.25·VDD, inputs ≤ VDD+0.3 V; GPIO source ≤ 20 mA',
    },
  },
  {
    match: /^CH340/i,
    spec: {
      label: 'CH340C',
      supplies: [{ role: 'VCC', minMv: 3000, maxMv: 5500, pins: [16], match: /3V3|VBUS|5V/i, assume: '+3V3', peakMa: 20, avgMa: 15 }],
      logic: { voh: (v) => v - 400, vol: () => 400, vih: (v) => Math.ceil(v * 0.7), vil: (v) => Math.floor(v * 0.3), vabs: (v) => v + 500, drives: true, receives: true, role: 'VCC' },
      source: 'CH340C: VCC 3.0–5.5 V, 20 mA peak / 15 mA avg; generic CMOS levels VOH ≥ VCC−0.4 V, VOL ≤ 0.4 V, VIH 0.7·VCC, VIL 0.3·VCC, inputs ≤ VCC+0.5 V',
    },
  },
  {
    match: /^TB6612/i,
    spec: {
      label: 'TB6612FNG',
      supplies: [
        { role: 'VM', minMv: 2500, maxMv: 13500, match: /^(VM|VIN|VMOT)$/i, assume: 'VIN' },
        { role: 'VCC', minMv: 2700, maxMv: 5500, match: /3V3|5V/i, assume: '+3V3', peakMa: 2, avgMa: 2 },
      ],
      logic: { voh: () => 0, vol: () => 0, vih: (v) => Math.ceil(v * 0.7), vil: (v) => Math.floor(v * 0.3), vabs: () => 5500, drives: false, receives: true, role: 'VCC' },
      outputMa: 1200,
      railCurrentMa: { VM: 2400 },
      source: 'TB6612FNG: VM 2.5–13.5 V, VCC 2.7–5.5 V at ≤ 2 mA; IOUT 1.2 A continuous per channel (2.4 A per VM feed); VIH 0.7·VCC, VIL 0.3·VCC, inputs ≤ 5.5 V',
    },
  },
  {
    match: /^AMS1117/i,
    spec: {
      label: 'AMS1117-3.3',
      supplies: [
        { role: 'VIN', minMv: 4600, maxMv: 15000, pins: [3], match: /^(VIN|VM)$/i, assume: 'VIN' },
        { role: 'VOUT', minMv: 0, maxMv: 99999, pins: [2, 4], match: /3V3/i, assume: '+3V3' },
      ],
      regulator: { ratingMa: 1000, thetaJA: 90, ambientC: 25, tjMaxC: 125, inRole: 'VIN', outRole: 'VOUT' },
      railCurrentMa: { VIN: 1000 },
      source: 'AMS1117-3.3: VIN 4.6 V (3.3 V + 1.3 V dropout) to 15 V, 1 A rating; SOT-223 θJA 90 °C/W (no added heatsink copper), TA 25 °C, TJ ≤ 125 °C',
    },
  },
  {
    match: /^TYPE-C/i,
    spec: { label: 'USB-C', supplies: [], railCurrentMa: { VBUS: 500 }, source: 'USB-C receptacle: VBUS ≤ 500 mA (USB 2.0 default power)' },
  },
]

const LED = { vfMinMv: 1800, maxUa: 20000, gpioMaxUa: 20000 }
const EDGE_OVERHANG_UM: Partial<Record<Part['kind'], number>> = { usbc: 1000 }

// ---------------------------------------------------------------------------------------

const um = (mm: number) => Math.round(mm * 1000)
const mm2 = (µm: number) => (µm / 1000).toFixed(2)
const v2 = (mv: number) => (mv / 1000).toFixed(2)
const str = (s: string) => JSON.stringify(s)
const int = (n: number) => (n < 0 ? `(${n})` : `${n}`)

function parseOhms(v?: string): number | null {
  if (!v) return null
  const m = /^(\d+(?:\.\d+)?)\s*([RKkMm]?)(\d*)\s*(?:Ω|ohms?)?$/i.exec(v.trim())
  if (!m) return null
  const mult = { '': 1, R: 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]] ?? 1
  const frac = m[3] ? Number(`0.${m[3]}`) : 0
  return Math.round((Number(m[1]) + frac) * mult)
}

const isCap = (p: Part) => p.kind === 'ecap' || p.category === 'Capacitor'
const isRes = (p: Part) => p.kind === 'chip' && p.category === 'Resistor'
const specFor = (p: Part) => BY_MPN.find((e) => e.match.test(p.mpn) || e.match.test(p.name))?.spec

/** Build the Lean certificate for a board. */
export function buildCertificate(board: Board): Certificate {
  const assumptions: string[] = []
  const note = (s: string) => {
    if (!assumptions.includes(s)) assumptions.push(s)
  }
  const partBy = new Map(board.parts.map((p) => [p.ref, p]))
  const traces = routeNets(board)

  const alias = (n: string) => {
    const a = NET_ALIASES[n]
    if (a) note(a.why)
    return a ? a.to : n
  }
  const railSpec = (net: string) => RAILS.find((r) => r.match.test(net))

  // pin → net (after aliasing)
  const netsOfPin = new Map<string, Set<string>>()
  for (const n of board.nets) for (const pin of n.path) {
    if (!netsOfPin.has(pin)) netsOfPin.set(pin, new Set())
    netsOfPin.get(pin)!.add(alias(n.name))
  }
  const pinCount = (p: Part) => padsFor(p).length
  const partNets = (p: Part, pins?: number[]) => {
    const out: string[] = []
    for (let i = 1; i <= pinCount(p); i++) {
      if (pins && !pins.includes(i)) continue
      for (const n of netsOfPin.get(`${p.ref}.${i}`) ?? []) if (!out.includes(n)) out.push(n)
    }
    return out
  }
  const powerNets = (p: Part, pins?: number[]) => partNets(p, pins).filter((n) => railSpec(n))

  const usedRails = new Map<string, RailSpec>()
  const trackRail = (name: string) => {
    const r = railSpec(name)
    if (r) {
      usedRails.set(name, r)
      note(r.why)
    }
    return r
  }

  // ---- supplies, loads, logic families -------------------------------------------------
  interface Sup { ref: string; role: string; rail: string; minMv: number; maxMv: number }
  interface Ld { ref: string; rail: string; peakMa: number; avgMa: number }
  const supplies: Sup[] = []
  const loads: Ld[] = []
  const railOf = new Map<string, Map<string, string>>() // ref → role → rail

  for (const p of board.parts) {
    const spec = specFor(p)
    if (spec) {
      note(spec.source)
      const roles = new Map<string, string>()
      for (const s of spec.supplies) {
        let rail = (s.pins ? powerNets(p, s.pins) : []).find((n) => s.match.test(n)) ?? powerNets(p).find((n) => s.match.test(n))
        if (!rail && s.assume) {
          rail = s.assume
          note(`${p.ref} ${s.role} is not routed in the board data; assumed on ${rail}`)
        }
        if (!rail) continue
        roles.set(s.role, rail)
        if (!trackRail(rail)) continue
        supplies.push({ ref: p.ref, role: s.role, rail, minMv: s.minMv, maxMv: s.maxMv })
        if (s.peakMa) loads.push({ ref: p.ref, rail, peakMa: s.peakMa, avgMa: s.avgMa ?? s.peakMa })
      }
      railOf.set(p.ref, roles)
    } else if (isCap(p)) {
      const m = /(\d+(?:\.\d+)?)\s*V\b/.exec(p.description)
      const rating = m ? Math.round(Number(m[1]) * 1000) : null
      for (const rail of powerNets(p)) {
        trackRail(rail)
        if (rating == null) {
          note(`${p.ref}: no voltage rating in description; not checked`)
          continue
        }
        supplies.push({ ref: p.ref, role: 'rating', rail, minMv: 0, maxMv: rating })
      }
      if (rating != null) note(`Capacitor voltage ratings parsed from part descriptions (e.g. "25 V")`)
    }
  }

  // ---- LEDs: series resistor and source --------------------------------------------------
  interface Led { led: string; res: string; srcMaxMv: number; ohms: number; srcMaxUa: number; src: string }
  const leds: Led[] = []
  for (const d of board.parts.filter((p) => p.kind === 'led')) {
    const anodeNets = board.nets.filter((n) => n.path.includes(`${d.ref}.1`))
    const resPin = anodeNets.flatMap((n) => n.path).find((s) => {
      const part = partBy.get(s.split('.')[0])
      return part && isRes(part)
    })
    if (!resPin) {
      note(`${d.ref}: no series resistor found on its anode; LED current not checked`)
      continue
    }
    const [rRef, rPin] = resPin.split('.')
    const r = partBy.get(rRef)!
    // an unreadable value is certified as 0 Ω, so led_current_safe fails rather than skipping the LED
    const ohms = parseOhms(r.value) ?? 0
    if (!ohms) note(`${rRef} value "${r.value ?? ''}" is not a readable resistance; ${d.ref} treated as unlimited (fails led_current_safe)`)
    const other = `${rRef}.${rPin === '1' ? 2 : 1}`
    const srcNets = board.nets.filter((n) => n.path.includes(other))
    let src = ''
    let srcMaxMv = 0
    let srcMaxUa = LED.maxUa
    const rail = srcNets.map((n) => alias(n.name)).find((n) => railSpec(n))
    const gpio = srcNets.flatMap((n) => n.path).map((s) => partBy.get(s.split('.')[0])).find((p) => p && specFor(p)?.logic?.drives)
    if (rail) {
      src = rail
      srcMaxMv = trackRail(rail)!.maxMv
    } else if (gpio) {
      const vcc = railOf.get(gpio.ref)?.get(specFor(gpio)!.logic!.role) ?? '+3V3'
      src = `${gpio.ref} GPIO`
      srcMaxMv = trackRail(vcc)!.maxMv
      srcMaxUa = LED.gpioMaxUa
    } else {
      src = '+3V3'
      srcMaxMv = trackRail('+3V3')!.maxMv
      note(`${other} (${d.ref} resistor) is not routed in the board data; assumed tied to +3V3`)
    }
    leds.push({ led: d.ref, res: rRef, srcMaxMv, ohms, srcMaxUa, src })
    const ua = ohms ? Math.ceil(((srcMaxMv - LED.vfMinMv) * 1000) / ohms) : 0
    const mA = Math.ceil(ua / 1000)
    loads.push({ ref: d.ref, rail: rail ?? (gpio ? (railOf.get(gpio.ref)?.get('VDD') ?? '+3V3') : '+3V3'), peakMa: mA, avgMa: mA })
  }
  if (leds.length) note(`LEDs: Vf ≥ ${v2(LED.vfMinMv)} V (lowest common indicator Vf, conservative for any colour), IF ≤ ${LED.maxUa / 1000} mA; GPIO source ≤ ${LED.gpioMaxUa / 1000} mA`)

  // resistors from a rail to a non-rail node draw at most Vmax/R
  for (const r of board.parts.filter(isRes)) {
    const n1 = partNets(r, [1]).filter((n) => railSpec(n))
    const n2 = partNets(r, [2]).filter((n) => railSpec(n))
    if (leds.some((l) => l.res === r.ref)) continue
    const ohms = parseOhms(r.value)
    if (!ohms || n1.length + n2.length !== 1) continue
    const rail = [...n1, ...n2][0]
    const mA = Math.ceil(trackRail(rail)!.maxMv / ohms)
    loads.push({ ref: r.ref, rail, peakMa: mA, avgMa: mA })
  }

  // ---- regulators -------------------------------------------------------------------------
  interface Reg { ref: string; inRail: string; outRail: string; ratingMa: number; vinLimitMv: number; thetaJA: number; ambientC: number; tjMaxC: number }
  const regs: Reg[] = []
  for (const p of board.parts) {
    const spec = specFor(p)
    if (!spec?.regulator) continue
    const roles = railOf.get(p.ref)!
    const g = spec.regulator
    regs.push({ ref: p.ref, inRail: roles.get(g.inRole)!, outRail: roles.get(g.outRole)!, ratingMa: g.ratingMa, vinLimitMv: 0, thetaJA: g.thetaJA, ambientC: g.ambientC, tjMaxC: g.tjMaxC })
  }
  // thermal envelope: the highest VIN (≤ the input rail max, rounded down to 0.1 V) at which
  // TJ ≤ TJmax for the steady-state load. Computed after loads are known (below).
  const settleThermal = () => {
    for (const r of regs) {
      const vin = usedRails.get(r.inRail)
      const vout = usedRails.get(r.outRail)
      if (!vin || !vout) continue
      const iAvg = loads.filter((l) => l.rail === r.outRail).reduce((a, l) => a + l.avgMa, 0)
      const room = iAvg * r.thetaJA > 0 ? Math.floor(((r.tjMaxC - r.ambientC) * 1e6) / (iAvg * r.thetaJA)) : Infinity
      const safe = Math.floor((vout.minMv + room) / 100) * 100
      r.vinLimitMv = Math.min(vin.maxMv, safe)
      if (r.vinLimitMv < vin.maxMv) {
        note(`THERMAL ENVELOPE: ${r.ref} would exceed TJ ${r.tjMaxC} °C above VIN ${v2(r.vinLimitMv)} V at ${iAvg} mA average load; the thermal theorem covers VIN ${v2(vin.minMv)}–${v2(r.vinLimitMv)} V only, not the full ${v2(vin.maxMv)} V input range`)
      }
    }
  }
  // the regulator's own output pin is not a requirement on the rail
  const supplyList = supplies.filter((s) => !(regs.some((r) => r.ref === s.ref) && s.role === 'VOUT'))

  // ---- logic links ------------------------------------------------------------------------
  interface Fam { name: string; vol: number; voh: number; vil: number; vih: number; vpeak: number; vabs: number }
  interface Lk { net: string; drv: string; rcv: string; d: Fam; r: Fam }
  const famOf = (p: Part): Fam | null => {
    const spec = specFor(p)
    if (!spec?.logic) return null
    const railName = railOf.get(p.ref)?.get(spec.logic.role)
    const rail = railName ? railSpec(railName) : undefined
    if (!rail) return null
    const L = spec.logic
    // worst case: weakest outputs at Vcc,min / Vcc,max; strictest thresholds over the window
    return {
      name: `${spec.label} @ ${railName}`,
      voh: L.voh(rail.minMv),
      vol: L.vol(rail.maxMv),
      vih: L.vih(rail.maxMv),
      vil: L.vil(rail.minMv),
      vpeak: rail.maxMv,
      vabs: L.vabs(rail.minMv),
    }
  }
  const links: Lk[] = []
  for (const n of board.nets) {
    const parts = [...new Set(n.path.map((s) => s.split('.')[0]))].map((r) => partBy.get(r)!).filter(Boolean)
    for (const a of parts) for (const c of parts) {
      if (a === c) continue
      const sa = specFor(a)?.logic
      const sc = specFor(c)?.logic
      if (!sa?.drives || !sc?.receives) continue
      const d = famOf(a)
      const r = famOf(c)
      if (!d || !r) continue
      if (links.some((l) => l.net === n.name && l.drv === a.ref && l.rcv === c.ref)) continue
      links.push({ net: n.name, drv: a.ref, rcv: c.ref, d, r })
    }
  }
  if (links.length) note('Logic links: every net joining two logic parts is checked in each direction the parts can drive (pin direction is not in the board data)')

  // ---- connections, currents ------------------------------------------------------------
  const connCurrent = (i: number): number => {
    const n = board.nets[i]
    const net = alias(n.name)
    const parts = n.path.map((s) => partBy.get(s.split('.')[0])!).filter(Boolean)
    if (railSpec(net)) {
      const reg = regs.find((r) => r.outRail === net)
      if (reg) return reg.ratingMa
      const per = parts.map((p) => specFor(p)?.railCurrentMa?.[n.name] ?? specFor(p)?.railCurrentMa?.[net] ?? 0)
      return Math.max(0, ...per)
    }
    const drv = parts.find((p) => specFor(p)?.outputMa)
    if (drv && parts.some((p) => p.kind === 'terminal')) return specFor(drv)!.outputMa!
    return 0
  }
  const currents = board.nets.map((_, i) => connCurrent(i))
  // rail segments that touch no known consumer carry the largest current seen on that rail
  board.nets.forEach((n, i) => {
    const net = alias(n.name)
    if (railSpec(net) && currents[i] === 0) {
      currents[i] = Math.max(0, ...board.nets.map((m, j) => (alias(m.name) === net ? currents[j] : 0)))
    }
  })
  note(`Trace ampacity: IPC-2221 external, ${RULES.copperOz} oz, ΔT ${RULES.ampDeltaTC} °C, linearised as w ≥ ${AMP_K_UM_PER_A} µm/A · I (chord of the convex IPC curve, valid ≤ ${RULES.ampMaxMa / 1000} A); currents: regulator rating on its output rail, 1.2 A per motor output, 2.4 A per VM feed, 1 A into the regulator, 500 mA VBUS`)

  settleThermal()

  // ---- emit -------------------------------------------------------------------------------
  const L: string[] = []
  const push = (s = '') => L.push(...s.split('\n'))

  const W = um(board.width) / 2
  const H = um(board.height) / 2
  push(`-- AUTO-GENERATED by src/verify/toLean.ts — do not edit.`)
  push(`-- Board: ${board.name} rev ${board.revision}`)
  push(`import Forge.Rules`)
  push(``)
  push(`namespace Forge.Generated`)
  push(`open Forge`)
  push(``)

  const partLean = board.parts.map((p) => {
    const b = bodyFor(p)
    const q = (((Math.round(p.rot / 90) % 4) + 4) % 4)
    if (Math.abs(p.rot / 90 - Math.round(p.rot / 90)) > 1e-9) note(`${p.ref}: rotation ${p.rot}° snapped to ${q * 90}° (model supports quarter turns)`)
    const ov = EDGE_OVERHANG_UM[p.kind] ?? 0
    if (ov) note(`${p.ref} (${p.kind}) is edge-mounted and may overhang the outline by ≤ ${mm2(ov)} mm`)
    const pads = padsFor(p).map((d, i) => `⟨${i + 1}, ${int(um(d.x))}, ${int(um(d.y))}, ${um(d.w)}, ${um(d.h)}, ${um(d.drill ?? 0)}⟩`)
    return `  { ref := ${str(p.ref)}, kind := ${str(p.kind)}, x := ${int(um(p.x))}, y := ${int(um(p.y))}, quarter := ${q},\n    bodyW := ${um(b.w)}, bodyH := ${um(b.h)}, overhang := ${ov},\n    pads := [${pads.join(', ')}] }`
  })
  push(`def parts : List Part := [\n${partLean.join(',\n')}\n]`)
  push(``)

  const connLean = board.nets.map((n, i) => {
    const t = traces[i]
    const pts: [number, number][] = []
    for (const [x, y] of t.points) {
      const p: [number, number] = [um(x), um(y)]
      const last = pts[pts.length - 1]
      if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p)
    }
    const pins = n.path.map((s) => {
      const [r, k] = s.split('.')
      return `⟨${str(r)}, ${Number(k)}⟩`
    })
    return `  { net := ${str(alias(n.name))}, pins := [${pins.join(', ')}], layer := .${t.layer}, width := ${um(t.width)},\n    pts := [${pts.map(([x, y]) => `⟨${int(x)}, ${int(y)}⟩`).join(', ')}], currentMa := ${currents[i]} }`
  })
  push(`def conns : List Conn := [\n${connLean.join(',\n')}\n]`)
  push(``)

  const fam = (f: Fam) => `{ name := ${str(f.name)}, vol := ${f.vol}, voh := ${f.voh}, vil := ${f.vil}, vih := ${f.vih}, vpeak := ${f.vpeak}, vabs := ${f.vabs} }`
  push(`def board : Board := {`)
  push(`  name := ${str(board.name)}`)
  push(`  outline := ⟨${int(-W)}, ${int(-H)}, ${W}, ${H}⟩`)
  push(`  holes := [${board.holes.map((h) => `⟨${int(um(h.x))}, ${int(um(h.y))}, ${um(h.d)}⟩`).join(', ')}]`)
  push(`  parts := parts`)
  push(`  conns := conns`)
  push(`  rails := [${[...usedRails].map(([n, r]) => `⟨${str(n)}, ${r.minMv}, ${r.maxMv}⟩`).join(', ')}]`)
  push(`  supplies := [\n${supplyList.map((s) => `    ⟨${str(s.ref)}, ${str(s.role)}, ${str(s.rail)}, ${s.minMv}, ${s.maxMv}⟩`).join(',\n')}]`)
  push(`  loads := [\n${loads.map((l) => `    ⟨${str(l.ref)}, ${str(l.rail)}, ${l.peakMa}, ${l.avgMa}⟩`).join(',\n')}]`)
  push(`  regs := [${regs.map((r) => `⟨${str(r.ref)}, ${str(r.inRail)}, ${str(r.outRail)}, ${r.ratingMa}, ${r.vinLimitMv}, ${r.thetaJA}, ${r.ambientC}, ${r.tjMaxC}⟩`).join(', ')}]`)
  push(`  leds := [${leds.map((d) => `⟨${str(d.led)}, ${str(d.res)}, ${d.srcMaxMv}, ${LED.vfMinMv}, ${d.ohms}, ${LED.maxUa}, ${d.srcMaxUa}⟩`).join(', ')}]`)
  push(`  links := [\n${links.map((l) => `    { net := ${str(l.net)}, drv := ${str(l.drv)}, rcv := ${str(l.rcv)},\n      dfam := ${fam(l.d)},\n      rfam := ${fam(l.r)} }`).join(',\n')}]`)
  push(`  rules := { minTrace := ${RULES.minTraceUm}, minClear := ${RULES.minClearUm}, edgeClear := ${RULES.edgeClearUm}, minRing := ${RULES.minRingUm},`)
  push(`             ampK := ${AMP_K_UM_PER_A}, ampMaxMa := ${RULES.ampMaxMa}, budgetPct := ${RULES.budgetPct} }`)
  push(`}`)
  push(``)

  // ---- theorems --------------------------------------------------------------------------
  const theorems: TheoremSpec[] = []
  const thm = (name: string, statement: string, prop: string, proof: string) => {
    push(`/-- ${statement.replace(/-\/|\/-/g, '- /')} -/`)
    const start = L.length + 1
    push(`theorem ${name} : ${prop} :=\n  ${proof}`)
    theorems.push({ name, statement, startLine: start, endLine: L.length })
    push(``)
  }
  const via = (rule: string) => `(Rules.check${rule}_iff board).1 (by native_decide)`

  const nParts = board.parts.length
  const overhangs = board.parts.filter((p) => EDGE_OVERHANG_UM[p.kind])
  thm('parts_within_outline',
    `All ${nParts} part bodies lie within the ${board.width} × ${board.height} mm outline` +
      (overhangs.length ? ` (edge-mount ${overhangs.map((p) => p.ref).join(', ')} may overhang ≤ ${mm2(Math.max(...overhangs.map((p) => EDGE_OVERHANG_UM[p.kind]!)))} mm)` : ''),
    'Rules.PartsWithin board', via('PartsWithin'))

  thm('no_part_overlap',
    `No two of the ${nParts} part bodies and ${board.holes.length} mounting holes overlap (axis-aligned body boxes, all pairs)`,
    'Rules.NoOverlap board', via('NoOverlap'))

  const widths = board.nets.map((_, i) => um(traces[i].width))
  const minW = Math.min(...widths)
  thm('traces_meet_min_width',
    `All ${board.nets.length} traces ≥ ${mm2(RULES.minTraceUm)} mm wide (JLCPCB 2-layer); narrowest ${mm2(minW)} mm`,
    `Rules.MinWidth board ∧ (∀ c ∈ board.conns, ${minW} ≤ c.width) ∧ ∃ c ∈ board.conns, c.width = ${minW}`,
    `⟨${via('MinWidth')}, by native_decide, by native_decide⟩`)

  const nSegs = traces.reduce((a, t) => a + Math.max(0, t.points.length - 1), 0)
  thm('trace_clearance',
    `Same-layer traces of different nets are ≥ ${mm2(RULES.minClearUm)} mm apart edge-to-edge (exact segment-to-segment distance over all ${nSegs} trace segments; pads and vias not included)`,
    'Rules.TraceClearance board', via('TraceClearance'))

  const nPins = board.nets.reduce((a, n) => a + n.path.length, 0)
  thm('every_net_connected',
    `Each of the ${board.nets.length} routed connections reaches all its pins (${nPins} pin visits): a vertex of its trace lies inside every listed pin's pad. Per connection, not per net: nets split into copper islands are reported as warnings`,
    'Rules.NetsConnected board', via('NetsConnected'))

  const aliased = Object.entries(NET_ALIASES).filter(([k]) => board.nets.some((n) => n.name === k))
  thm('no_pin_in_two_nets',
    `No pin is on two different nets` + (aliased.length ? ` (${aliased.map(([k, v]) => `${k} ≡ ${v.to}`).join(', ')})` : ''),
    'Rules.UniquePinNets board', via('UniquePinNets'))

  const peak = (rail: string) => loads.filter((l) => l.rail === rail).reduce((a, l) => a + l.peakMa, 0)
  const avg = (rail: string) => loads.filter((l) => l.rail === rail).reduce((a, l) => a + l.avgMa, 0)
  if (regs.length) {
    thm('power_budget',
      regs.map((r) => {
        const p = specFor(partBy.get(r.ref)!)!.label
        return `Power budget ${r.outRail}: ${peak(r.outRail)} mA ≤ ${(r.ratingMa * RULES.budgetPct) / 100} mA (${RULES.budgetPct}% of ${p} ${r.ratingMa} mA rating)`
      }).join('; '),
      `Rules.PowerBudget board ∧ ${regs.map((r) => `totalPeak (board.loadsOn ${str(r.outRail)}) = ${peak(r.outRail)}`).join(' ∧ ')}`,
      `⟨${via('PowerBudget')}, ${regs.map(() => 'by native_decide').join(', ')}⟩`)
  }

  thm('rail_voltage_compatible',
    `Each of ${supplyList.length} supply/rating requirements contains its rail's whole window (${[...usedRails].map(([n, r]) => `${n} ${v2(r.minMv)}–${v2(r.maxMv)} V`).join(', ')})`,
    'Rules.RailsCompatible board', via('RailsCompatible'))

  if (links.length) {
    const groups = new Map<string, number>()
    for (const l of links) {
      const k = `${specFor(partBy.get(l.drv)!)!.label}→${specFor(partBy.get(l.rcv)!)!.label}`
      groups.set(k, (groups.get(k) ?? 0) + 1)
    }
    const worstHi = links.reduce((a, l) => (l.d.voh - l.r.vih < a.d.voh - a.r.vih ? l : a))
    thm('logic_levels_compatible',
      `${links.length} logic links compatible (${[...groups].map(([k, n]) => `${k} ×${n}`).join(', ')}): VOH ≥ VIH, VOL ≤ VIL, peak ≤ abs max; tightest high margin ${l2(worstHi)}`,
      'Rules.LogicCompatible board', via('LogicCompatible'))
  }

  if (leds.length) {
    thm('led_current_safe',
      `LED current I = (V − Vf)/R: ${leds.map((d) => `${d.led} ≤ ${d.ohms ? ((d.srcMaxMv - LED.vfMinMv) / d.ohms).toFixed(2) : "∞"} mA (${d.src}, ${d.ohms} Ω)`).join(', ')}; limits ${LED.maxUa / 1000} mA LED, ${LED.gpioMaxUa / 1000} mA GPIO`,
      'Rules.LedsSafe board', via('LedsSafe'))
  }

  if (regs.length) {
    thm('thermal_margin',
      regs.map((r) => {
        const railMax = usedRails.get(r.inRail)!.maxMv
        const vin = r.vinLimitMv
        const vout = usedRails.get(r.outRail)!.minMv
        const tj = r.ambientC + ((vin - vout) * avg(r.outRail) * r.thetaJA) / 1e6
        const p = specFor(partBy.get(r.ref)!)!.label
        const env = vin < railMax
          ? ` — holds only for VIN ≤ ${v2(vin)} V; at the ${v2(railMax)} V input maximum TJ would be ${(r.ambientC + ((railMax - vout) * avg(r.outRail) * r.thetaJA) / 1e6).toFixed(0)} °C`
          : ''
        return `${p} TJ = ${r.ambientC} °C + (${v2(vin)} − ${v2(vout)} V) × ${avg(r.outRail)} mA × ${r.thetaJA} °C/W = ${tj.toFixed(0)} °C ≤ ${r.tjMaxC} °C${env}`
      }).join('; '),
      `Rules.ThermalOk board ∧ ${regs.map((r) => `totalAvg (board.loadsOn ${str(r.outRail)}) = ${avg(r.outRail)} ∧ (∃ r ∈ board.regs, r.ref = ${str(r.ref)} ∧ r.vinLimitMv = ${r.vinLimitMv})`).join(' ∧ ')}`,
      `⟨${via('ThermalOk')}, ${regs.map(() => 'by native_decide').join(', ')}⟩`)
  }

  const power = board.nets.map((n, i) => ({ n, i, w: widths[i], I: currents[i] })).filter((x) => x.I > 0)
  const tight = power.reduce<(typeof power)[number] | null>((a, x) => (!a || x.w - (AMP_K_UM_PER_A * x.I) / 1000 < a.w - (AMP_K_UM_PER_A * a.I) / 1000 ? x : a), null)
  thm('trace_ampacity',
    `${power.length} power traces meet width ≥ ${(AMP_K_UM_PER_A / 1000).toFixed(3)} mm/A × I (IPC-2221 external, ${RULES.copperOz} oz, ΔT ${RULES.ampDeltaTC} °C, linearised ≤ ${RULES.ampMaxMa / 1000} A)` +
      (tight ? `; tightest ${alias(tight.n.name)} ${mm2(tight.w)} mm ≥ ${mm2((AMP_K_UM_PER_A * tight.I) / 1000)} mm at ${(tight.I / 1000).toFixed(1)} A` : ''),
    'Rules.Ampacity board', via('Ampacity'))

  thm('copper_edge_clearance',
    `All trace and pad copper stays ≥ ${mm2(RULES.edgeClearUm)} mm inside the board edge`,
    'Rules.EdgeClearance board', via('EdgeClearance'))

  thm('annular_ring',
    `Every plated hole has an annular ring ≥ ${mm2(RULES.minRingUm)} mm`,
    'Rules.AnnularRing board', via('AnnularRing'))

  thm('all_rules',
    `checkAll soundness: the board passes all 14 checkers, hence satisfies every rule above`,
    'Rules.AllRules board', `Rules.checkAll_sound board (by native_decide)`)

  push(`-- Diagnostics: violations and computed totals (printed by \`lake build\`).`)
  push(`#eval IO.println (String.intercalate "\\n" ((Report.lines board).map ("FORGE|" ++ ·)))`)
  push(``)
  push(`end Forge.Generated`)

  return { source: L.join('\n') + '\n', theorems, assumptions }

  function l2(l: Lk) {
    return `${l.drv}→${l.rcv} on ${l.net}: VOH ${v2(l.d.voh)} V ≥ VIH ${v2(l.r.vih)} V`
  }
}

/** Lean source of the certificate for `board` (contents of verify/Forge/Generated.lean). */
export function boardToLean(board: Board): string {
  return buildCertificate(board).source
}
