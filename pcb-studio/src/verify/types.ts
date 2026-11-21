// Shared by the client (src/verify/verify.ts) and the Vite middleware (server/verify.ts).
// Keep this file free of imports so the node-side tsconfig can type-check it.

export interface TheoremResult {
  /** Lean theorem name, e.g. `power_budget` */
  name: string
  /** precise human-readable statement of what is proved */
  statement: string
  ok: boolean
  /** first Lean error for this theorem, when it failed */
  error?: string
}

export interface Verification {
  status: 'idle' | 'running' | 'passed' | 'failed'
  theorems: TheoremResult[]
  log?: string
  durationMs?: number
  /** checker diagnostics printed by `Forge.Report` (violations, computed totals) */
  diagnostics?: string[]
  /** modelling assumptions used for this board (lookup-table values, aliases) */
  assumptions?: string[]
  cached?: boolean
  /** SHA-256 of the exact Lean source checked, including board revision. */
  certificateSha256?: string
}

/** One theorem in the generated certificate, with its 1-based line span in Generated.lean. */
export interface TheoremSpec {
  name: string
  statement: string
  startLine: number
  endLine: number
}

export interface Certificate {
  source: string
  theorems: TheoremSpec[]
  assumptions: string[]
}
