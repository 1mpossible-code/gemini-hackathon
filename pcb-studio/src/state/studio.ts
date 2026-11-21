import { useSyncExternalStore } from 'react'
import { board as defaultBoard, type Board } from '@/data/board'
import { defaultSystem, systemFromPrompt, type SystemDesign } from '@/data/system'
import type { Verification } from '@/verify/types'
import type { OfferMatchKind, ShopOffer, ShopSearchEntry } from '@/data/shop'

export type { OfferMatchKind, ShopOffer, ShopSearchEntry }

export type ViewMode = '3d' | 'top' | 'bottom'
export type Scale = 'board' | 'system'
export type ExportFormat = 'stl' | 'glb' | 'obj' | 'png' | 'json'

export interface HistoryEntry {
  board: Board
  verification: Verification
  label: string
}

export interface StudioState {
  scale: Scale // 'system' = whole assembly, 'board' = the custom PCB
  mode: 'research' | 'engineer' // research swarm (friend's FastAPI app) or the PCB studio
  pendingPrompt: string | null // board brief waiting for the Gemini prompt bar to run
  system: SystemDesign
  device: string | null // selected system device id
  hoveredDevice: string | null
  board: Board // the board being viewed/edited; AI generation replaces it
  verification: Verification
  history: HistoryEntry[]
  lastDiff: string[]
  budgetUsd: number | null
  shopByMpn: Record<string, ShopSearchEntry>
  selectedOfferByMpn: Record<string, ShopOffer>
  inspectorTab: 'inspect' | 'bom'
  selected: string | null // part ref, e.g. "U1"
  hovered: string | null
  hoveredNet: string | null
  exploded: boolean // components lift off the board
  touring: boolean // cinematic showcase tour is playing
  view: ViewMode
  showTraces: boolean
  showSilk: boolean
  showCallouts: boolean // numbered "01" leader tags on major parts
  fitNonce: number // bump to request camera fit
  exportRequest: { format: ExportFormat; nonce: number } | null
}

function briefFromUrl(): string | null {
  const q = new URLSearchParams(location.search)
  const brief = q.get('brief')
  if (!brief) return null
  const parts = q.get('parts')
  return (parts ? `${brief} Build it around: ${parts}.` : brief).slice(0, 2000)
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

let state: StudioState = {
  scale: new URLSearchParams(location.search).get('scale') === 'board' || new URLSearchParams(location.search).has('brief') ? 'board' : 'system',
  mode: new URLSearchParams(location.search).get('mode') === 'engineer' || new URLSearchParams(location.search).has('brief') ? 'engineer' : 'research',
  pendingPrompt: briefFromUrl(),
  system: briefFromUrl() ? systemFromPrompt(briefFromUrl()!) : defaultSystem,
  device: null,
  hoveredDevice: null,
  board: defaultBoard,
  verification: { status: 'idle', theorems: [] },
  history: [],
  lastDiff: [],
  budgetUsd: 15,
  shopByMpn: {},
  selectedOfferByMpn: {},
  inspectorTab: 'inspect',
  selected: 'U1',
  hovered: null,
  hoveredNet: null,
  exploded: false,
  touring: true,
  view: '3d',
  showTraces: true,
  showSilk: true,
  showCallouts: true,
  fitNonce: 0,
  exportRequest: null,
}

const listeners = new Set<() => void>()

export function setStudio(patch: Partial<StudioState> | ((s: StudioState) => Partial<StudioState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  listeners.forEach((l) => l())
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
    diffs.push(`BOM ${costDelta > 0 ? '+' : '-'}$${Math.abs(costDelta).toFixed(2)}`)
  } else {
    diffs.push('Hardware BOM unchanged')
  }
  if (!nextVerification && state.verification.status !== 'idle') {
    diffs.push('Proofs invalidated — re-verify')
  } else if (nextVerification?.status === 'passed') {
    diffs.push('Lean 4 proofs ✓')
  }

  setStudio({
    history: [...state.history.slice(-19), { board: prev, verification: state.verification, label }],
    board: draft,
    verification: nextVerification ?? { status: 'idle', theorems: [] },
    lastDiff: diffs,
    touring: false,
  })
}

export function undoBoardEdit() {
  if (!state.history.length) return
  const last = state.history[state.history.length - 1]
  setStudio({
    board: last.board,
    verification: last.verification,
    history: state.history.slice(0, -1),
    lastDiff: [`Reverted: ${last.label}`],
    touring: false,
  })
}

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

/** Ask for a scale change; the 3D views animate the camera, the veil swaps the scene. */
export function goScale(scale: Scale) {
  const s = getStudio()
  if (s.mode !== 'engineer') return setStudio({ mode: 'engineer', scale })
  if (s.scale === scale) return
  if (scale === 'board') window.dispatchEvent(new Event('forge:dive'))
  else window.dispatchEvent(new CustomEvent('forge:scale', { detail: 'system' }))
}

