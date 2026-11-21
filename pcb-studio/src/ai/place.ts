import type { Board, Part } from '@/data/board'
import { bodyFor, padsFor, toBoard } from '@/pcb/footprint'

/**
 * Deterministic placement: connectors flush with the board edges, then the
 * rest packed greedily (closest free grid spot to a target point), largest
 * first, with decoupling parts pulled next to their IC. The board grows until
 * everything fits.
 */

export type Edge = 'front' | 'back' | 'left' | 'right'

export interface PlaceHint {
  ref: string
  role?: 'connector' | 'mcu' | 'ic' | 'power' | 'decoupling' | 'passive' | 'indicator' | 'switch' | 'other'
  /** ref of the part this one should sit next to */
  near?: string
  edge?: Edge
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

const BIG = new Set(['module', 'ssop', 'soic', 'sot223', 'ecap', 'tact', 'terminal', 'usbc', 'header'])
const isBig = (p: Part) => BIG.has(p.kind)

/** Local footprint extent (body ∪ pads) at rot 0. */
function localExtent(p: Part): Rect {
  const b = bodyFor(p)
  let x0 = -b.w / 2
  let x1 = b.w / 2
  let y0 = -b.h / 2
  let y1 = b.h / 2
  for (const pad of padsFor(p)) {
    x0 = Math.min(x0, pad.x - pad.w / 2)
    x1 = Math.max(x1, pad.x + pad.w / 2)
    y0 = Math.min(y0, pad.y - pad.h / 2)
    y1 = Math.max(y1, pad.y + pad.h / 2)
  }
  return { x0, y0, x1, y1 }
}

/** Board-space bounding box of a part at its current x/y/rot. */
export function partRect(p: Part): Rect {
  const e = localExtent(p)
  const pts = [
    toBoard(p, e.x0, e.y0),
    toBoard(p, e.x1, e.y0),
    toBoard(p, e.x0, e.y1),
    toBoard(p, e.x1, e.y1),
  ]
  return {
    x0: Math.min(...pts.map((q) => q[0])),
    x1: Math.max(...pts.map((q) => q[0])),
    y0: Math.min(...pts.map((q) => q[1])),
    y1: Math.max(...pts.map((q) => q[1])),
  }
}

const overlap = (a: Rect, b: Rect, gap: number) =>
  a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap

/** required clearance between two parts (mm) */
function gapFor(a: Part | null, b: Part | null) {
  const ab = a ? isBig(a) : true
  const bb = b ? isBig(b) : true
  if (ab && bb) return 2.5
  if (ab || bb) return 0.7
  return 0.45
}

interface Placed {
  part: Part | null // null = keepout (mounting hole)
  rect: Rect
}

/** Edge-mount rotation so the connector opening faces outward. */
function edgeRot(p: Part, edge: Edge): number {
  if (p.kind === 'usbc') return { front: 0, back: 180, left: -90, right: 90 }[edge]
  if (p.kind === 'terminal') return { front: 180, back: 0, left: 90, right: -90 }[edge]
  // headers: long axis along the edge
  return edge === 'left' || edge === 'right' ? 0 : 90
}

function defaultEdges(p: Part, h: PlaceHint | undefined): Edge[] {
  if (h?.edge) return [h.edge]
  if (p.kind === 'usbc') return ['front', 'back']
  if (p.kind === 'terminal') {
    const text = `${p.name} ${p.description}`.toLowerCase()
    if (/power|input|batt|supply|vin|dc in/.test(text)) return ['left', 'front', 'back', 'right']
    return ['right', 'left', 'back', 'front']
  }
  return ['back', 'right', 'left', 'front']
}

export const isEdgeConnector = (p: Part, h?: PlaceHint) =>
  p.kind === 'usbc' || p.kind === 'terminal' || (p.kind === 'header' && (h?.role === 'connector' || !!h?.edge || h?.role === undefined))

export interface PlaceResult {
  parts: Part[]
  width: number
  height: number
  holes: Board['holes']
  attempts: number
}

function tryPlace(parts: Part[], hints: Map<string, PlaceHint>, W: number, H: number): Part[] | null {
  const placed: Placed[] = []
  const out = new Map<string, Part>()
  const hx = W / 2
  const hy = H / 2
  const margin = 0.8

  // mounting holes
  if (W >= 35 && H >= 30) {
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = sx * (hx - 3.5)
      const y = sy * (hy - 3.5)
      placed.push({ part: null, rect: { x0: x - 3, x1: x + 3, y0: y - 3, y1: y + 3 } })
    }
  }

  const fits = (p: Part, r: Rect, allowOverhang: number) =>
    r.x0 >= -hx + margin - allowOverhang &&
    r.x1 <= hx - margin + allowOverhang &&
    r.y0 >= -hy + margin - allowOverhang &&
    r.y1 <= hy - margin + allowOverhang &&
    !placed.some((q) => overlap(r, q.rect, gapFor(p, q.part)))

  // 1. edge connectors
  const edgeUse: Record<Edge, number> = { front: 0, back: 0, left: 0, right: 0 }
  const connectors = parts.filter((p) => isEdgeConnector(p, hints.get(p.ref)))
  // usb first (fixed front centre), then by footprint size
  connectors.sort((a, b) => (a.kind === 'usbc' ? -1 : b.kind === 'usbc' ? 1 : bodyFor(b).w * bodyFor(b).h - bodyFor(a).w * bodyFor(a).h))
  for (const p0 of connectors) {
    const h = hints.get(p0.ref)
    let edges = defaultEdges(p0, h)
    // balance: among the allowed edges prefer the least used (keeping the first choice on ties)
    if (!h?.edge) edges = [...edges].sort((a, b) => edgeUse[a] - edgeUse[b] || edges.indexOf(a) - edges.indexOf(b))
    let done = false
    for (const edge of edges) {
      const p = { ...p0, rot: edgeRot(p0, edge) }
      p.x = 0
      p.y = 0
      const r0 = partRect(p)
      // perpendicular offset: USB-C overhangs slightly, others sit just inside
      const inset = p.kind === 'usbc' ? -0.3 : p.kind === 'terminal' ? 0.8 : 1.2
      const along = edge === 'front' || edge === 'back' ? W : H
      const allow = p.kind === 'usbc' ? 0.4 : 0
      for (let k = 0; k <= along * 2; k++) {
        const t = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5 // 0, +0.5, -0.5, +1 ...
        if (edge === 'front') {
          p.x = t
          p.y = hy - inset - r0.y1
        } else if (edge === 'back') {
          p.x = t
          p.y = -hy + inset - r0.y0
        } else if (edge === 'left') {
          p.y = t
          p.x = -hx + inset - r0.x0
        } else {
          p.y = t
          p.x = hx - inset - r0.x1
        }
        const r = partRect(p)
        if (fits(p, r, allow + Math.max(0, -inset) + margin)) {
          placed.push({ part: p, rect: r })
          out.set(p.ref, p)
          edgeUse[edge] += edge === 'front' || edge === 'back' ? r.x1 - r.x0 : r.y1 - r.y0
          done = true
          break
        }
        if (Math.abs(t) > along / 2) break
      }
      if (done) break
    }
    if (!done) return null
  }

  // 2. interior parts: MCU first, then by area, decoupling/near parts after their anchor
  const rest = parts.filter((p) => !out.has(p.ref))
  const area = (p: Part) => {
    const e = localExtent(p)
    return (e.x1 - e.x0) * (e.y1 - e.y0)
  }
  const rank = (p: Part) => {
    const h = hints.get(p.ref)
    if (h?.role === 'mcu' || p.kind === 'module') return 0
    if (isBig(p) && !(h?.near && h.role === 'decoupling')) return 1
    return 2
  }
  rest.sort((a, b) => rank(a) - rank(b) || area(b) - area(a) || a.ref.localeCompare(b.ref, 'en', { numeric: true }))
  // a part that hugs another ("near") must come after its anchor
  for (let guard = 0; guard < rest.length * rest.length; guard++) {
    const i = rest.findIndex((p, idx) => {
      const near = hints.get(p.ref)?.near
      const j = near ? rest.findIndex((q) => q.ref === near) : -1
      return j > idx
    })
    if (i < 0) break
    const [p] = rest.splice(i, 1)
    const j = rest.findIndex((q) => q.ref === hints.get(p.ref)!.near)
    rest.splice(j + 1, 0, p)
  }

  const step = 0.5
  for (const p0 of rest) {
    const h = hints.get(p0.ref)
    const anchor = h?.near ? out.get(h.near) : undefined
    const target: [number, number] = anchor
      ? [anchor.x, anchor.y]
      : rank(p0) === 0
        ? [0, -H * 0.08]
        : [0, 0]
    const rots = isBig(p0) && p0.kind !== 'tact' ? [0, 90] : [0, 90]
    let best: { x: number; y: number; rot: number; d: number } | null = null
    for (const rot of rots) {
      const p = { ...p0, rot, x: 0, y: 0 }
      const r0 = partRect(p)
      for (let y = -hy + margin - r0.y0; y + r0.y1 <= hy - margin; y += step) {
        for (let x = -hx + margin - r0.x0; x + r0.x1 <= hx - margin; x += step) {
          // prefer rot 0 slightly so boards look tidy
          const d = Math.hypot(x - target[0], y - target[1]) + (rot ? 0.6 : 0)
          if (best && d >= best.d) continue
          const r = { x0: x + r0.x0, x1: x + r0.x1, y0: y + r0.y0, y1: y + r0.y1 }
          if (!placed.some((q) => overlap(r, q.rect, gapFor(p, q.part)))) best = { x, y, rot, d }
        }
      }
    }
    if (!best) return null
    const p = { ...p0, x: +best.x.toFixed(2), y: +best.y.toFixed(2), rot: best.rot }
    placed.push({ part: p, rect: partRect(p) })
    out.set(p.ref, p)
  }

  return parts.map((p) => {
    const q = out.get(p.ref)!
    return { ...q, x: +q.x.toFixed(2), y: +q.y.toFixed(2) }
  })
}

export function placeParts(
  parts: Part[],
  hints: PlaceHint[],
  limits: { maxWidth?: number; maxHeight?: number } = {},
): PlaceResult {
  const hintMap = new Map(hints.map((h) => [h.ref, h]))
  let footprint = 0
  let maxDim = 0
  for (const p of parts) {
    const e = localExtent(p)
    const g = isBig(p) ? 2.5 : 0.6
    footprint += (e.x1 - e.x0 + g) * (e.y1 - e.y0 + g)
    maxDim = Math.max(maxDim, e.x1 - e.x0, e.y1 - e.y0)
  }
  const round5 = (v: number) => Math.ceil(v / 5) * 5
  let W = Math.max(40, round5(Math.sqrt(footprint * 1.45 * (4 / 3))), round5(maxDim + 16))
  let H = Math.max(30, round5(W * 0.75), round5(maxDim + 10))
  const maxW = limits.maxWidth ?? 220
  const maxH = limits.maxHeight ?? 180
  for (let attempt = 1; attempt <= 24; attempt++) {
    const res = tryPlace(parts, hintMap, W, H)
    if (res) {
      const holes =
        W >= 35 && H >= 30
          ? [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => ({ x: sx * (W / 2 - 3.5), y: sy * (H / 2 - 3.5), d: 3.2 }))
          : []
      return { parts: res, width: W, height: H, holes, attempts: attempt }
    }
    if (W >= maxW && H >= maxH) break
    // grow the shorter-relative side first, keeping roughly 4:3
    if (W / H < 4 / 3 && W < maxW) W = Math.min(maxW, W + 5)
    else if (H < maxH) H = Math.min(maxH, H + 5)
    else W = Math.min(maxW, W + 5)
  }
  throw new Error(`Parts do not fit within ${maxW}×${maxH} mm`)
}

/** Ground stitching vias in free space: away from parts, holes and traces. */
export function groundVias(board: Board, traces: { points: [number, number][] }[]): [number, number][] {
  const rects = board.parts.map(partRect)
  const hx = board.width / 2
  const hy = board.height / 2
  const segDist = (px: number, py: number, a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy)
  }
  const out: [number, number][] = []
  const step = 5
  for (let y = -hy + 3; y <= hy - 3; y += step) {
    for (let x = -hx + 3; x <= hx - 3; x += step) {
      if (rects.some((r) => overlap(r, { x0: x, x1: x, y0: y, y1: y }, 1.0))) continue
      if (board.holes.some((h) => Math.hypot(h.x - x, h.y - y) < h.d / 2 + 1.5)) continue
      if (traces.some((t) => t.points.some((pt, i) => i > 0 && segDist(x, y, t.points[i - 1], pt) < 1.0))) continue
      out.push([+x.toFixed(2), +y.toFixed(2)])
    }
  }
  return out.slice(0, 60)
}
