import type { Part, PartKind } from '@/data/board'
import { bodyFor, padsFor } from '@/pcb/footprint'
import { FALLBACK_CATALOG, FALLBACK_VERSION, fallbackToPart, type FallbackEntry } from './fallbackCatalog'
import type { CatalogItem } from './types'

/**
 * Adapter over src/data/catalog (written separately). The module is loaded
 * through import.meta.glob so a missing catalog doesn't break the build; any
 * shape we can't understand falls back to the built-in list.
 */

const KINDS: PartKind[] = ['module', 'ssop', 'soic', 'sot223', 'chip', 'ecap', 'terminal', 'header', 'usbc', 'tact', 'led']
const isKind = (k: unknown): k is PartKind => typeof k === 'string' && (KINDS as string[]).includes(k)

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

const catalogModules = import.meta.glob('../data/catalog/index.{ts,tsx}')

export interface LoadedCatalog {
  version: string
  source: 'catalog' | 'fallback'
  items: CatalogItem[]
  byId: Map<string, CatalogItem>
  /** Part for an item with the given ref, positioned at the origin. */
  makePart: (item: CatalogItem, ref: string) => Part
  search?: (q: string) => CatalogItem[]
  note?: string
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ')
  if (isRec(v)) {
    // {min,max,unit} / {nom,unit} style specs
    const unit = str(v.unit) ?? ''
    if (v.min != null || v.max != null) return `${str(v.min) ?? ''}-${str(v.max) ?? ''}${unit}`
    if (v.nom != null || v.typ != null) return `${str(v.nom ?? v.typ)}${unit}`
    return Object.entries(v).map(([k, x]) => `${k} ${str(x)}`).join(', ')
  }
  return undefined
}

function pick(e: Rec, keys: string[]): unknown {
  for (const k of keys) {
    if (e[k] != null) return e[k]
    for (const nest of ['specs', 'electrical', 'spec', 'params']) {
      const n = e[nest]
      if (isRec(n) && n[k] != null) return n[k]
    }
  }
  return undefined
}

function pinNamesOf(e: Rec): string[] | undefined {
  const raw = pick(e, ['pinNames', 'pinout', 'pinMap', 'pins'])
  if (Array.isArray(raw)) {
    const names = raw.map((p) => (typeof p === 'string' ? p : isRec(p) ? str(p.name ?? p.signal ?? p.label) : str(p)) ?? '?')
    return names.length ? names : undefined
  }
  if (isRec(raw)) {
    // {"1":"GND","2":"VCC"} or {GND: 1, VCC: 2}
    const entries = Object.entries(raw)
    if (entries.every(([k]) => /^\d+$/.test(k))) {
      const out: string[] = []
      for (const [k, v] of entries) out[Number(k) - 1] = str(v) ?? '?'
      return Array.from(out, (x) => x ?? 'NC')
    }
    if (entries.every(([, v]) => typeof v === 'number')) {
      const out: string[] = []
      for (const [k, v] of entries) out[(v as number) - 1] = out[(v as number) - 1] ? `${out[(v as number) - 1]}/${k}` : k
      return Array.from(out, (x) => x ?? 'NC')
    }
  }
  return undefined
}

function itemFrom(raw: unknown, part: Part, id: string): CatalogItem {
  const e = isRec(raw) ? raw : {}
  const body = bodyFor(part)
  const dims = pick(e, ['dims', 'dimensions', 'body', 'sizeMm', 'size_mm'])
  let w = body.w
  let h = body.h
  if (isRec(dims) && typeof dims.w === 'number' && typeof dims.h === 'number') {
    w = dims.w
    h = dims.h
  }
  const ifaces = pick(e, ['interfaces', 'interface', 'protocols', 'bus', 'buses', 'features'])
  return {
    id,
    name: part.name,
    kind: part.kind,
    category: part.category,
    description: part.description,
    interfaces: Array.isArray(ifaces) ? ifaces.map((x) => str(x) ?? '').filter(Boolean) : ifaces ? [str(ifaces) ?? ''] : [],
    voltage: str(pick(e, ['voltage', 'vcc', 'supply', 'supplyVoltage', 'vin', 'voltageRange'])),
    current: str(pick(e, ['current', 'maxCurrent', 'iout', 'currentMax', 'ratedCurrent'])),
    w: +w.toFixed(2),
    h: +h.toFixed(2),
    pinCount: padsFor(part).length,
    pinNames: pinNamesOf(e),
    raw,
  }
}

function sanitizePart(p: unknown, ref: string, id: string): Part | null {
  if (!isRec(p) || !isKind(p.kind)) return null
  const part = { ...(p as unknown as Part) }
  part.ref = ref
  part.x = 0
  part.y = 0
  part.rot = 0
  part.catalogId = id
  part.name = part.name ?? id
  part.mpn = part.mpn ?? ''
  part.manufacturer = part.manufacturer ?? ''
  part.description = part.description ?? ''
  part.pkg = part.pkg ?? ''
  part.category = part.category ?? 'Part'
  // tag the description too, so the id survives anything that strips unknown fields
  if (!part.description.includes(`[${id}]`)) part.description = `${part.description} [${id}]`.trim()
  return part
}

type ToPartFn = (...args: unknown[]) => unknown

function callToPart(toPart: ToPartFn, raw: unknown, id: string, ref: string): Part | null {
  const attempts: unknown[][] = [
    [raw, ref],
    [id, ref],
    [raw, { ref, x: 0, y: 0, rot: 0 }],
    [id, { ref, x: 0, y: 0, rot: 0 }],
    [raw, ref, 0, 0, 0],
    [id, ref, 0, 0, 0],
  ]
  for (const args of attempts) {
    try {
      const p = sanitizePart(toPart(...args), ref, id)
      if (p) return p
    } catch {
      /* try next calling convention */
    }
  }
  return null
}

function fallback(note?: string): LoadedCatalog {
  const items: CatalogItem[] = FALLBACK_CATALOG.map((e) => {
    const part = fallbackToPart(e, 'X1')
    const item = itemFrom(e, part, e.id)
    return { ...item, interfaces: e.interfaces ?? [], voltage: e.voltage, current: e.current, pinNames: e.pinNames }
  })
  return {
    version: FALLBACK_VERSION,
    source: 'fallback',
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    makePart: (item, ref) => {
      const p = fallbackToPart(item.raw as FallbackEntry, ref)
      p.description = `${p.description} [${item.id}]`
      return p
    },
    note,
  }
}

let cached: Promise<LoadedCatalog> | null = null

export function loadCatalog(force = false): Promise<LoadedCatalog> {
  if (!cached || force) cached = load()
  return cached
}

async function load(): Promise<LoadedCatalog> {
  const loader = Object.values(catalogModules)[0]
  if (!loader) return fallback('src/data/catalog not found')
  let mod: Rec
  try {
    mod = (await loader()) as Rec
  } catch (err) {
    return fallback(`catalog failed to load: ${(err as Error).message}`)
  }
  const toPart = mod.toPart as ToPartFn | undefined
  const rawCat = mod.catalog ?? mod.CATALOG ?? mod.parts ?? mod.default
  const version = str(mod.CATALOG_VERSION) ?? 'unversioned'
  const entries: [string, unknown][] = Array.isArray(rawCat)
    ? rawCat.map((e, i) => [str(isRec(e) ? (e.id ?? e.slug ?? e.mpn) : undefined) ?? `item-${i}`, e])
    : isRec(rawCat)
      ? Object.entries(rawCat).map(([k, e]) => [str(isRec(e) ? e.id : undefined) ?? k, e])
      : []
  if (!entries.length) return fallback('catalog export empty or unrecognised')

  const items: CatalogItem[] = []
  const skipped: string[] = []
  for (const [id, raw] of entries) {
    const part = toPart ? callToPart(toPart, raw, id, 'X1') : sanitizePart(isRec(raw) ? { ...raw } : null, 'X1', id)
    if (!part) {
      skipped.push(id)
      continue
    }
    items.push(itemFrom(raw, part, id))
  }
  if (!items.length) return fallback(`no catalog entries convertible to Part (${skipped.length} skipped)`)

  const byId = new Map(items.map((i) => [i.id, i]))
  const searchFn = mod.search as ToPartFn | undefined
  return {
    version,
    source: 'catalog',
    items,
    byId,
    makePart: (item, ref) =>
      (toPart ? callToPart(toPart, item.raw, item.id, ref) : sanitizePart(isRec(item.raw) ? { ...item.raw } : null, ref, item.id)) ??
      (() => {
        throw new Error(`toPart failed for ${item.id}`)
      })(),
    search: searchFn
      ? (q) => {
          try {
            const res = searchFn(q)
            if (!Array.isArray(res)) return []
            return res
              .map((r) => byId.get(typeof r === 'string' ? r : (str(isRec(r) ? (r.id ?? (isRec(r.item) ? r.item.id : undefined)) : undefined) ?? '')))
              .filter((x): x is CatalogItem => !!x)
          } catch {
            return []
          }
        }
      : undefined,
    note: skipped.length ? `${skipped.length} catalog entries skipped (not convertible)` : undefined,
  }
}

/** One line per item, compact enough to put the whole catalog in the planning prompt. */
export function catalogDigest(items: CatalogItem[]): string {
  return items
    .map((i) =>
      [
        i.id,
        i.name,
        i.category,
        i.interfaces.length ? i.interfaces.join('/') : '-',
        i.voltage ?? '-',
        i.current ?? '-',
        `${i.w}x${i.h}mm`,
        `${i.pinCount}p`,
        i.description.replace(/\s*\[[^\]]+\]$/, '').slice(0, 90),
      ].join(' | '),
    )
    .join('\n')
}
