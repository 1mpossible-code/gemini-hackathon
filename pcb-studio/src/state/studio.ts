import { useSyncExternalStore } from 'react'
import { board as defaultBoard, type Board } from '@/data/board'
import { byId } from '@/data/catalog'
import {
  analyzeDevice,
  defaultSystem,
  modelFidelity,
  systemCost,
  unitPrice,
  type SystemDesign,
} from '@/data/system'
import type { Verification } from '@/verify/types'

export type ViewMode = '3d' | 'top' | 'bottom'
export type Scale = 'board' | 'system'
export type ExportFormat = 'stl' | 'glb' | 'obj' | 'png' | 'json'
export type OfferMatchKind = 'exact_match' | 'bundle_or_pack' | 'variant_or_accessory'
export type LabelMode = 'contextual' | 'all' | 'off'

export interface ShopOffer {
  offerId: string
  productId: string
  variantId: string
  title: string
  sellerName: string
  sellerDomain: string
  priceMinor: number
  currency: string
  formattedPrice: string
  priceUsd: number | null
  available: boolean
  url: string
  matchKind: OfferMatchKind
  matchNote: string
}

export interface ShopSearchEntry {
  mpn: string
  query: string
  status: 'ok' | 'no_results' | 'error'
  offers: ShopOffer[]
  warnings: string[]
  error?: string
  retrievedAt: string
}

export interface HistoryEntry {
  system: SystemDesign
  board: Board
  verification: Verification
  budgetUsd: number | null
  selectedOfferByMpn: Record<string, ShopOffer>
  label: string
}

export interface ChangeFeedback {
  id: number
  summary: string
  tone: 'info' | 'ok' | 'warn'
}

export interface StudioState {
  scale: Scale // 'system' = whole assembly, 'board' = the custom PCB
  mode: 'research' | 'engineer'
  pendingPrompt: string | null
  system: SystemDesign
  device: string | null // selected system device id ('pcb' or device id)
  hoveredDevice: string | null
  board: Board
  verification: Verification
  history: HistoryEntry[]
  lastDiff: string[]
  lastChange: ChangeFeedback | null
  budgetUsd: number | null
  shopByMpn: Record<string, ShopSearchEntry>
  selectedOfferByMpn: Record<string, ShopOffer>
  inspectorTab: 'inspect' | 'bom'
  systemTab: 'inspect' | 'bom'
  leftPanelOpen: boolean
  checksOpen: boolean
  labelMode: LabelMode
  showAllWires: boolean
  selected: string | null // board part ref, e.g. "U1"
  hovered: string | null
  hoveredNet: string | null
  exploded: boolean
  touring: boolean
  view: ViewMode
  showTraces: boolean
  showSilk: boolean
  showCallouts: boolean // legacy alias kept in sync with labelMode !== 'off'
  fitNonce: number
  exportRequest: { format: ExportFormat; nonce: number } | null
}

function briefFromUrl(): string | null {
  const q = new URLSearchParams(location.search)
  const brief = q.get('brief')
  if (!brief) return null
  const parts = q.get('parts')
  return parts ? `${brief} Build it around: ${parts}.` : brief
}

function nextRevision(rev: string): string {
  const m = /^(.*?)(\d+)$/.exec(rev)
  if (m) return `${m[1]}${Number(m[2]) + 1}`
  return `${rev}.1`
}

export function computeBoardBomCost(
  b: Board,
  selectedOfferByMpn: Record<string, ShopOffer> = {},
): { totalUsd: number; unpricedCount: number } {
  let total = 0
  let unpriced = 0
  for (const p of b.parts) {
    const offer = selectedOfferByMpn[p.mpn]
    if (offer && offer.matchKind === 'exact_match' && offer.available && offer.priceUsd != null) {
      total += offer.priceUsd
    } else if (p.pricing?.[0]?.price != null) {
      total += p.pricing[0].price
    } else {
      unpriced++
    }
  }
  return { totalUsd: +total.toFixed(4), unpricedCount: unpriced }
}

export function computeSystemDevicesCost(
  sys: SystemDesign,
  selectedOfferByMpn: Record<string, ShopOffer> = {},
): { totalUsd: number; unpricedCount: number } {
  let total = 0
  let unpriced = 0
  for (const d of sys.devices) {
    const item = byId[d.catalogId]
    if (!item) {
      unpriced++
      continue
    }
    const offer = selectedOfferByMpn[item.mpn]
    if (offer && offer.matchKind === 'exact_match' && offer.available && offer.priceUsd != null) {
      total += offer.priceUsd
    } else if (item.pricing[0]?.unit != null) {
      total += item.pricing[0].unit
    } else {
      unpriced++
    }
  }
  return { totalUsd: +total.toFixed(4), unpricedCount: unpriced }
}

let changeCounter = 0

let state: StudioState = {
  scale:
    new URLSearchParams(location.search).get('scale') === 'board' ||
    new URLSearchParams(location.search).has('brief')
      ? 'board'
      : 'system',
  mode: new URLSearchParams(location.search).get('mode') === 'research' ? 'research' : 'engineer',
  pendingPrompt: briefFromUrl(),
  system: defaultSystem,
  device: null,
  hoveredDevice: null,
  board: defaultBoard,
  verification: { status: 'idle', theorems: [] },
  history: [],
  lastDiff: [],
  lastChange: null,
  budgetUsd: 40,
  shopByMpn: {},
  selectedOfferByMpn: {},
  inspectorTab: 'inspect',
  systemTab: 'inspect',
  leftPanelOpen: true,
  checksOpen: false,
  labelMode: 'contextual',
  showAllWires: false,
  selected: 'U1',
  hovered: null,
  hoveredNet: null,
  exploded: false,
  touring: false,
  view: '3d',
  showTraces: true,
  showSilk: true,
  showCallouts: true,
  fitNonce: 0,
  exportRequest: null,
}

const listeners = new Set<() => void>()

// Monotonic tokens reject stale work even after undo recreates the same revision.
let designEpoch = 0
let requestEpoch = 0

export function beginDesignRequest() {
  const design = designEpoch
  const request = ++requestEpoch
  if (state.verification.status === 'running') {
    setStudio({ verification: { status: 'idle', theorems: [] } })
  }
  return () => design === designEpoch && request === requestEpoch
}

export function setStudio(patch: Partial<StudioState> | ((s: StudioState) => Partial<StudioState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch
  if (['board', 'system', 'budgetUsd', 'selectedOfferByMpn', 'history'].some(
    (key) => key in next && next[key as keyof StudioState] !== state[key as keyof StudioState],
  )) {
    designEpoch++
    if (!next.verification && state.verification.status === 'running') {
      next.verification = { status: 'idle', theorems: [] }
    }
  }
  if (next.board && next.board !== state.board && !next.verification) {
    next.verification = { status: 'idle', theorems: [] }
  }
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

function snapshotHistory(label: string): HistoryEntry {
  return {
    system: JSON.parse(JSON.stringify(state.system)),
    board: JSON.parse(JSON.stringify(state.board)),
    verification: state.verification,
    budgetUsd: state.budgetUsd,
    selectedOfferByMpn: { ...state.selectedOfferByMpn },
    label,
  }
}

export function loadExampleBoard(board: Board) {
  setStudio({
    history: [...state.history.slice(-19), snapshotHistory('Load example board')],
    board,
    verification: { status: 'idle', theorems: [] },
    scale: 'board',
    mode: 'engineer',
    view: 'top',
    selected: null,
    touring: false,
    fitNonce: state.fitNonce + 1,
  })
}

export function commitSystemSwap(
  deviceId: string,
  catalogId: string,
  opts: { applyToMatching?: boolean } = {},
) {
  const target = state.system.devices.find((d) => d.id === deviceId)
  const nextItem = byId[catalogId]
  if (!target || !nextItem) return
  if (target.catalogId === catalogId && !opts.applyToMatching) return

  const prevCatalogId = target.catalogId
  const prevItem = byId[prevCatalogId]
  const prevTotal = systemCost(state.system)

  const matchingIds = opts.applyToMatching
    ? state.system.devices
        .filter((d) => d.bus === target.bus && d.catalogId === prevCatalogId)
        .map((d) => d.id)
    : [deviceId]

  const nextDevices = state.system.devices.map((d) =>
    matchingIds.includes(d.id) ? { ...d, catalogId } : d,
  )
  const nextSystem: SystemDesign = { ...state.system, devices: nextDevices }
  const nextTotal = systemCost(nextSystem)
  const delta = +(nextTotal - prevTotal).toFixed(2)
  const updatedDev = nextDevices.find((d) => d.id === deviceId)!
  const check = analyzeDevice(updatedDev, state.board)
  const fid = modelFidelity(nextItem)

  const deltaTxt =
    Math.abs(delta) < 0.01 ? '$0.00' : `${delta > 0 ? '+' : '−'}$${Math.abs(delta).toFixed(2)}`
  const countPrefix =
    matchingIds.length > 1 ? `${matchingIds.length} ${target.role.toLowerCase()}s replaced` : `${target.label} replaced`
  const statusNote =
    check.severity === 'ok'
      ? 'Compatible'
      : check.severity === 'unverified'
      ? check.headline
      : 'Power compatibility needs review'
  const summary = `${countPrefix} (${nextItem.name}) · ${deltaTxt} · ${statusNote}`

  const diffs = [
    `${countPrefix}: ${prevItem?.name ?? prevCatalogId} → ${nextItem.name}`,
    `System parts ${deltaTxt} (now $${nextTotal.toFixed(2)})`,
    statusNote,
  ]
  if (fid.kind === 'proxy') diffs.push('3D preview uses dimensioned proxy')

  const label = `${countPrefix} → ${nextItem.name}`
  setStudio({
    history: [...state.history.slice(-19), snapshotHistory(label)],
    system: nextSystem,
    lastDiff: diffs,
    lastChange: {
      id: ++changeCounter,
      summary,
      tone: check.severity === 'ok' ? 'ok' : check.severity === 'warning' ? 'warn' : 'info',
    },
    touring: false,
  })
}

export function commitBoardEdit(
  updater: (draft: Board) => void,
  label: string,
  nextVerification?: Verification,
) {
  const prev = state.board
  const draft: Board = JSON.parse(JSON.stringify(prev))
  updater(draft)
  draft.revision = nextRevision(prev.revision)

  const prevCost = computeBoardBomCost(prev, state.selectedOfferByMpn).totalUsd
  const nextCost = computeBoardBomCost(draft, state.selectedOfferByMpn).totalUsd
  const costDelta = +(nextCost - prevCost).toFixed(2)

  const diffs: string[] = [label]
  if (prev.width !== draft.width || prev.height !== draft.height) {
    diffs.push(`Outline ${prev.width}×${prev.height} → ${draft.width}×${draft.height} mm`)
  }
  if (Math.abs(costDelta) >= 0.01) {
    diffs.push(`Parts ${costDelta > 0 ? '+' : '−'}$${Math.abs(costDelta).toFixed(2)}`)
  } else {
    diffs.push('Parts cost unchanged')
  }
  if (!nextVerification && state.verification.status !== 'idle') {
    diffs.push('Design checks need re-run')
  } else if (nextVerification?.status === 'passed') {
    diffs.push('All design checks passed')
  }

  setStudio({
    history: [...state.history.slice(-19), snapshotHistory(label)],
    board: draft,
    verification: nextVerification ?? { status: 'idle', theorems: [] },
    lastDiff: diffs,
    lastChange: {
      id: ++changeCounter,
      summary: diffs.slice(0, 2).join(' · '),
      tone: nextVerification?.status === 'passed' ? 'ok' : 'info',
    },
    touring: false,
  })
}

export function undoLastEdit() {
  if (!state.history.length) return
  const last = state.history[state.history.length - 1]
  setStudio({
    system: last.system,
    board: last.board,
    verification: last.verification.status === 'running'
      ? { status: 'idle', theorems: [] }
      : last.verification,
    budgetUsd: last.budgetUsd,
    selectedOfferByMpn: last.selectedOfferByMpn,
    history: state.history.slice(0, -1),
    lastDiff: [`Undid: ${last.label}`],
    lastChange: {
      id: ++changeCounter,
      summary: `Undid: ${last.label}`,
      tone: 'info',
    },
    touring: false,
  })
}

export const undoBoardEdit = undoLastEdit

export function getStudio() {
  return state
}

export function useStudio<T>(select: (s: StudioState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => select(state),
  )
}

export const requestFit = () => setStudio((s) => ({ fitNonce: s.fitNonce + 1 }))
export const requestExport = (format: ExportFormat) =>
  setStudio((s) => ({ exportRequest: { format, nonce: (s.exportRequest?.nonce ?? 0) + 1 } }))
export const cycleLabelMode = () =>
  setStudio((s) => {
    const order: LabelMode[] = ['contextual', 'all', 'off']
    const next = order[(order.indexOf(s.labelMode) + 1) % order.length]
    return { labelMode: next, showCallouts: next !== 'off' }
  })

export { unitPrice }
