import { useSyncExternalStore } from 'react'
import { board as defaultBoard, type Board } from '@/data/board'
import { defaultSystem, type SystemDesign } from '@/data/system'

export type ViewMode = '3d' | 'top' | 'bottom'
export type Scale = 'board' | 'system'
export type ExportFormat = 'stl' | 'glb' | 'obj' | 'png' | 'json'

export interface StudioState {
  scale: Scale // 'system' = whole assembly, 'board' = the custom PCB
  mode: 'research' | 'engineer' // research swarm (friend's FastAPI app) or the PCB studio
  pendingPrompt: string | null // board brief waiting for the Gemini prompt bar to run
  system: SystemDesign
  device: string | null // selected system device id
  hoveredDevice: string | null
  board: Board // the board being viewed/edited; AI generation replaces it
  verification: { status: 'idle' | 'running' | 'passed' | 'failed'; theorems: { name: string; statement: string; ok: boolean }[]; log?: string } 
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
  return parts ? `${brief} Build it around: ${parts}.` : brief
}

let state: StudioState = {
  scale: new URLSearchParams(location.search).get('scale') === 'board' || new URLSearchParams(location.search).has('brief') ? 'board' : 'system',
  mode: new URLSearchParams(location.search).get('mode') === 'research' ? 'research' : 'engineer',
  pendingPrompt: briefFromUrl(),
  system: defaultSystem,
  device: null,
  hoveredDevice: null,
  board: defaultBoard,
  verification: { status: 'idle', theorems: [] },
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
