import type { Board, Net, Part } from '@/data/board'
import { padsFor, pinPos, routeNets } from '@/pcb/footprint'

/** A logical net as proposed by the model: a name plus the pins it joins. */
export interface ProposedNet {
  name: string
  pins: string[]
}

export interface NetIssue {
  net: string
  pin?: string
  problem: string
}

export interface ValidatedNets {
  nets: ProposedNet[]
  issues: NetIssue[]
}

const PIN_RE = /^\s*([A-Za-z]{1,4}\d{1,3})\s*(?:[.:\-_/ ]|\bpin\b)\s*(?:pin\s*)?([A-Za-z0-9+\-_#/]+)\s*$/i

/**
 * Validate a proposed netlist against the placed parts: every pin must exist
 * per padsFor, a pin may belong to only one net, and nets need ≥2 pins.
 * Pin names ("U2.AIN1") are resolved to numbers when pinNames are known.
 */
export function validateNets(
  proposed: ProposedNet[],
  parts: Part[],
  pinNames: Map<string, string[] | undefined>,
): ValidatedNets {
  const byRef = new Map(parts.map((p) => [p.ref.toUpperCase(), p]))
  const issues: NetIssue[] = []
  const owner = new Map<string, string>() // "U1.3" -> net name
  const merged = new Map<string, Set<string>>()

  for (const n of proposed) {
    const name = (n.name || 'NET').trim().toUpperCase().replace(/\s+/g, '_').slice(0, 32)
    const set = merged.get(name) ?? new Set<string>()
    merged.set(name, set)
    for (const raw of n.pins ?? []) {
      const m = PIN_RE.exec(String(raw))
      if (!m) {
        issues.push({ net: name, pin: String(raw), problem: 'malformed pin, expected REF.pin' })
        continue
      }
      const part = byRef.get(m[1].toUpperCase())
      if (!part) {
        issues.push({ net: name, pin: String(raw), problem: `unknown ref ${m[1]}` })
        continue
      }
      const count = padsFor(part).length
      let num = /^\d+$/.test(m[2]) ? Number(m[2]) : NaN
      if (Number.isNaN(num)) {
        const names = pinNames.get(part.ref)
        const want = m[2].toUpperCase()
        const candidates = (names ?? []).map((nm, i) => [nm.toUpperCase(), i + 1] as const).filter(([nm]) => nm === want)
        const free = candidates.find(([, i]) => !owner.has(`${part.ref}.${i}`)) ?? candidates[0]
        if (!free) {
          issues.push({ net: name, pin: String(raw), problem: `no pin named ${m[2]} on ${part.ref} (use numbers 1-${count})` })
          continue
        }
        num = free[1]
      }
      if (num < 1 || num > count) {
        issues.push({ net: name, pin: String(raw), problem: `${part.ref} has pins 1-${count}` })
        continue
      }
      const key = `${part.ref}.${num}`
      const prev = owner.get(key)
      if (prev && prev !== name) {
        issues.push({ net: name, pin: key, problem: `pin already used by net ${prev}` })
        continue
      }
      owner.set(key, name)
      set.add(key)
    }
  }

  // switches: a net that joins both sides of a tact switch shorts it permanently
  for (const p of parts) {
    if (p.kind !== 'tact') continue
    const a = owner.get(`${p.ref}.1`) ?? owner.get(`${p.ref}.3`)
    const b = owner.get(`${p.ref}.2`) ?? owner.get(`${p.ref}.4`)
    if (a && a === b) issues.push({ net: a, pin: p.ref, problem: `shorts switch ${p.ref}: pins 1/3 and 2/4 are opposite sides and must be on different nets` })
  }

  const nets: ProposedNet[] = []
  for (const [name, set] of merged) {
    if (set.size < 2) {
      if (set.size === 1) issues.push({ net: name, problem: 'net has only one valid pin' })
      continue
    }
    nets.push({ name, pins: [...set] })
  }
  return { nets, issues }
}

const POWER_RE = /^(\+?\d+V\d*|\+?\d+V|VIN|VBAT|BAT\+?|VM|VMOT|VMOTOR|VCC|VDD|VBUS|VSYS|V\+|PWR|\+?3V3|\+?5V|12V)/i
const isGround = (n: string) => /^(P?GND|AGND|DGND|VSS|0V)/i.test(n)
const isPower = (n: string) => POWER_RE.test(n)

/** Minimum spanning tree over pin positions → list of 2-pin edges. */
function mst(points: [number, number][]): [number, number][] {
  const n = points.length
  const inTree = new Array(n).fill(false)
  const dist = new Array(n).fill(Infinity)
  const from = new Array(n).fill(-1)
  dist[0] = 0
  const edges: [number, number][] = []
  for (let k = 0; k < n; k++) {
    let u = -1
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || dist[i] < dist[u])) u = i
    inTree[u] = true
    if (from[u] >= 0) edges.push([from[u], u])
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue
      const d = Math.hypot(points[u][0] - points[v][0], points[u][1] - points[v][1])
      if (d < dist[v]) {
        dist[v] = d
        from[v] = u
      }
    }
  }
  return edges
}

function segsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = o(c, d, a)
  const d2 = o(c, d, b)
  const d3 = o(a, b, c)
  const d4 = o(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/**
 * Turn logical nets into routable Board nets: each net becomes the edges of its
 * minimum spanning tree; power nets get wide traces; ground goes on the bottom
 * layer; signal traces that would cross an existing top trace drop to bottom.
 */
export function buildBoardNets(board: Omit<Board, 'nets' | 'groundVias'>, logical: ProposedNet[]): Net[] {
  const full = { ...board, nets: [], groundVias: [] } as Board
  const out: Net[] = []
  const order = [...logical].sort((a, b) => Number(isPower(b.name)) - Number(isPower(a.name)) || Number(isGround(a.name)) - Number(isGround(b.name)))
  const placedSegs: Record<'top' | 'bottom', { net: string; a: [number, number]; b: [number, number] }[]> = { top: [], bottom: [] }

  for (const n of order) {
    const pts = n.pins.map((p) => pinPos(full, p))
    const width = isGround(n.name) ? 0.6 : isPower(n.name) ? 0.8 : 0.3
    for (const [i, j] of mst(pts)) {
      const cand: Net = { name: n.name, path: [n.pins[i], n.pins[j]], width }
      const trace = (layer: 'top' | 'bottom') => {
        const t = routeNets({ ...full, nets: [{ ...cand, layer }] })[0]
        const segs = t.points.slice(1).map((pt, k) => ({ net: n.name, a: t.points[k], b: pt }))
        const hits = segs.filter((s) => placedSegs[layer].some((q) => q.net !== n.name && segsIntersect(s.a, s.b, q.a, q.b))).length
        return { segs, hits }
      }
      let layer: 'top' | 'bottom' = isGround(n.name) ? 'bottom' : 'top'
      let res = trace(layer)
      if (res.hits && layer === 'top') {
        const alt = trace('bottom')
        if (alt.hits < res.hits) {
          layer = 'bottom'
          res = alt
        }
      }
      placedSegs[layer].push(...res.segs)
      out.push(layer === 'bottom' ? { ...cand, layer } : cand)
    }
  }
  return out
}
