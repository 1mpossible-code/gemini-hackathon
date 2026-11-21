import type { Board } from '@/data/board'
import type { Verification } from './types'

export type { TheoremResult, Verification } from './types'
export { boardToLean } from './toLean'

/** Ask the dev server to build the Lean certificate for `board` (POST /api/verify). */
export async function verifyBoard(board: Board, signal?: AbortSignal): Promise<Verification> {
  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board }),
      signal,
    })
    const body = (await res.json()) as Verification | { error: string }
    if (!res.ok || 'error' in body) {
      return { status: 'failed', theorems: [], log: 'error' in body ? body.error : `HTTP ${res.status}` }
    }
    return body
  } catch (e) {
    if (signal?.aborted) throw e
    return { status: 'failed', theorems: [], log: `verify request failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
