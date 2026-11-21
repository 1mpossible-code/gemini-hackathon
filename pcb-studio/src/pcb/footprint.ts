import type { Board, Part } from '@/data/board'

export interface Pad {
  /** local mm, part centre origin, +y toward board front */
  x: number
  y: number
  w: number
  h: number
  shape: 'rect' | 'round'
  drill?: number
}

export interface Body {
  w: number
  h: number
  height: number
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

/** Pads in pin order (pin n = index n-1). */
export function padsFor(p: Part): Pad[] {
  switch (p.kind) {
    case 'module': {
      // ESP32-WROOM: 14 left (top→bottom), 10 bottom (left→right), 14 right (bottom→top)
      const left = range(14).map((i) => ({ x: -8.75, y: -3.9 + i * 1.27, w: 1.6, h: 0.9, shape: 'rect' as const }))
      const bottom = range(10).map((i) => ({ x: -5.715 + i * 1.27, y: 12.75, w: 0.9, h: 1.6, shape: 'rect' as const }))
      const right = range(14).map((i) => ({ x: 8.75, y: -3.9 + (13 - i) * 1.27, w: 1.6, h: 0.9, shape: 'rect' as const }))
      return [...left, ...bottom, ...right]
    }
    case 'ssop': {
      const left = range(12).map((i) => ({ x: -3.6, y: -3.575 + i * 0.65, w: 1.4, h: 0.38, shape: 'rect' as const }))
      const right = range(12).map((i) => ({ x: 3.6, y: 3.575 - i * 0.65, w: 1.4, h: 0.38, shape: 'rect' as const }))
      return [...left, ...right]
    }
    case 'soic': {
      const left = range(8).map((i) => ({ x: -2.7, y: -4.445 + i * 1.27, w: 1.55, h: 0.6, shape: 'rect' as const }))
      const right = range(8).map((i) => ({ x: 2.7, y: 4.445 - i * 1.27, w: 1.55, h: 0.6, shape: 'rect' as const }))
      return [...left, ...right]
    }
    case 'sot223':
      return [
        { x: -2.3, y: 3.15, w: 0.95, h: 2, shape: 'rect' },
        { x: 0, y: 3.15, w: 0.95, h: 2, shape: 'rect' },
        { x: 2.3, y: 3.15, w: 0.95, h: 2, shape: 'rect' },
        { x: 0, y: -3.15, w: 3.25, h: 2, shape: 'rect' },
      ]
    case 'chip':
    case 'led': {
      const s = p.size === '0603' ? { d: 0.8, w: 0.8, h: 0.95 } : { d: 0.95, w: 1.0, h: 1.3 }
      return [
        { x: -s.d, y: 0, w: s.w, h: s.h, shape: 'rect' },
        { x: s.d, y: 0, w: s.w, h: s.h, shape: 'rect' },
      ]
    }
    case 'ecap':
      return [
        { x: -1.75, y: 0, w: 1.6, h: 1.6, shape: 'rect', drill: 0.8 },
        { x: 1.75, y: 0, w: 1.6, h: 1.6, shape: 'round', drill: 0.8 },
      ]
    case 'terminal':
      return range(p.pins ?? 2).map((i) => ({
        x: (i - ((p.pins ?? 2) - 1) / 2) * 5.08,
        y: 0,
        w: 2.4,
        h: 2.4,
        shape: i === 0 ? ('rect' as const) : ('round' as const),
        drill: 1.3,
      }))
    case 'header':
      return range(p.pins ?? 6).map((i) => ({
        x: 0,
        y: (i - ((p.pins ?? 6) - 1) / 2) * 2.54,
        w: 1.7,
        h: 1.7,
        shape: i === 0 ? ('rect' as const) : ('round' as const),
        drill: 1.0,
      }))
    case 'usbc': {
      const sig = range(12).map((i) => ({ x: -2.75 + i * 0.5, y: -3.4, w: 0.3, h: 1.1, shape: 'rect' as const }))
      const shell = [
        { x: -4.32, y: -2.9, w: 1.0, h: 1.8, shape: 'round' as const, drill: 0.6 },
        { x: 4.32, y: -2.9, w: 1.0, h: 1.8, shape: 'round' as const, drill: 0.6 },
        { x: -4.32, y: 1.0, w: 1.0, h: 1.6, shape: 'round' as const, drill: 0.6 },
        { x: 4.32, y: 1.0, w: 1.0, h: 1.6, shape: 'round' as const, drill: 0.6 },
      ]
      return [...sig, ...shell]
    }
    case 'tact':
      return [
        { x: -3.9, y: -2.25, w: 1.4, h: 1.1, shape: 'rect' },
        { x: 3.9, y: -2.25, w: 1.4, h: 1.1, shape: 'rect' },
        { x: -3.9, y: 2.25, w: 1.4, h: 1.1, shape: 'rect' },
        { x: 3.9, y: 2.25, w: 1.4, h: 1.1, shape: 'rect' },
      ]
  }
}

export function bodyFor(p: Part): Body {
  switch (p.kind) {
    case 'module': return { w: 18, h: 25.5, height: 3.1 }
    case 'ssop': return { w: 5.3, h: 7.8, height: 1.5 }
    case 'soic': return { w: 3.9, h: 9.9, height: 1.6 }
    case 'sot223': return { w: 6.5, h: 3.5, height: 1.7 }
    case 'chip': return p.size === '0603' ? { w: 1.6, h: 0.8, height: 0.45 } : { w: 2.0, h: 1.25, height: 0.6 }
    case 'led': return { w: 1.6, h: 0.8, height: 0.6 }
    case 'ecap': return { w: 8, h: 8, height: 10.2 }
    case 'terminal': return { w: (p.pins ?? 2) * 5.08, h: 7.6, height: 10 }
    case 'header': return { w: 2.54, h: (p.pins ?? 6) * 2.54, height: 2.5 }
    case 'usbc': return { w: 8.94, h: 7.3, height: 3.2 }
    case 'tact': return { w: 6, h: 6, height: 3.4 }
  }
}

export function toBoard(p: Part, lx: number, ly: number): [number, number] {
  // rotation is CCW seen from above; board +y points to the viewer's front so flip sign
  const r = (-p.rot * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [p.x + lx * c - ly * s, p.y + lx * s + ly * c]
}

export function pinPos(boardDef: Board, spec: string): [number, number] {
  const [ref, pin] = spec.split('.')
  const part = boardDef.parts.find((p) => p.ref === ref)
  if (!part) throw new Error(`Unknown part ${ref}`)
  const pad = padsFor(part)[Number(pin) - 1]
  if (!pad) throw new Error(`Unknown pin ${spec}`)
  return toBoard(part, pad.x, pad.y)
}

/** Route a → b with a single 45° chamfer: straight along the dominant axis, then diagonal. */
function chamfer(a: [number, number], b: [number, number]): [number, number][] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < 1e-3 || ay < 1e-3 || Math.abs(ax - ay) < 1e-3) return [a, b]
  if (ax > ay) {
    const run = ax - ay
    return [a, [a[0] + Math.sign(dx) * run, a[1]], b]
  }
  const run = ay - ax
  return [a, [a[0], a[1] + Math.sign(dy) * run], b]
}

export interface Trace {
  net: string
  width: number
  layer: 'top' | 'bottom'
  points: [number, number][]
  vias: [number, number][]
}

export function routeNets(b: Board): Trace[] {
  return b.nets.map((n) => {
    const pins = n.path.map((s) => pinPos(b, s))
    const stops: [number, number][] = [pins[0], ...(n.via ?? []), ...pins.slice(1)]
    const pts: [number, number][] = [stops[0]]
    for (let i = 1; i < stops.length; i++) pts.push(...chamfer(stops[i - 1], stops[i]).slice(1))
    const layer = n.layer ?? 'top'
    // bottom-layer nets drop through a via next to each SMD end
    const vias = layer === 'bottom' ? [pins[0], pins[pins.length - 1]] : []
    return { net: n.name, width: n.width ?? 0.35, layer, points: pts, vias }
  })
}

export function traceLength(t: Trace) {
  let l = 0
  for (let i = 1; i < t.points.length; i++) l += Math.hypot(t.points[i][0] - t.points[i - 1][0], t.points[i][1] - t.points[i - 1][1])
  return l
}
