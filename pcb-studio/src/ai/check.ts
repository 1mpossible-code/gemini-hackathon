import type { Board } from '@/data/board'
import { padsFor, pinPos, routeNets } from '@/pcb/footprint'
import { partRect } from './place'

export interface CheckResult {
  errors: string[]
  warnings: string[]
}

/** Structural design-rule check of a generated board. */
export function checkBoard(b: Board): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const hx = b.width / 2
  const hy = b.height / 2

  const refs = new Set<string>()
  for (const p of b.parts) {
    if (refs.has(p.ref)) errors.push(`duplicate ref ${p.ref}`)
    refs.add(p.ref)
    const r = partRect(p)
    const tol = p.kind === 'usbc' ? 1.5 : 0.05
    if (r.x0 < -hx - tol || r.x1 > hx + tol || r.y0 < -hy - tol || r.y1 > hy + tol) errors.push(`${p.ref} outside board outline`)
    if (!p.catalogId) warnings.push(`${p.ref} has no catalog id`)
  }

  for (let i = 0; i < b.parts.length; i++) {
    const a = partRect(b.parts[i])
    for (let j = i + 1; j < b.parts.length; j++) {
      const c = partRect(b.parts[j])
      if (a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1) errors.push(`${b.parts[i].ref} overlaps ${b.parts[j].ref}`)
    }
    for (const h of b.holes) {
      if (h.x + h.d / 2 > a.x0 && h.x - h.d / 2 < a.x1 && h.y + h.d / 2 > a.y0 && h.y - h.d / 2 < a.y1) errors.push(`${b.parts[i].ref} covers a mounting hole`)
    }
  }

  const used = new Set<string>()
  for (const n of b.nets) {
    if (n.path.length < 2) errors.push(`net ${n.name} has fewer than 2 pins`)
    for (const s of n.path) {
      try {
        pinPos(b, s)
        used.add(s.split('.')[0])
      } catch (e) {
        errors.push(`net ${n.name}: ${(e as Error).message}`)
      }
    }
  }
  try {
    routeNets(b)
  } catch (e) {
    errors.push(`routing failed: ${(e as Error).message}`)
  }

  for (const p of b.parts) {
    if (!used.has(p.ref) && padsFor(p).length) warnings.push(`${p.ref} (${p.name}) is not connected`)
  }
  return { errors, warnings }
}
