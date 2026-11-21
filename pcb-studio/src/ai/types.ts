import type { Board, PartKind } from '@/data/board'

export type GenStage = 'plan' | 'select' | 'place' | 'route' | 'check'

/** NDJSON events streamed by POST /api/generate, one JSON object per line. */
export type GenEvent =
  | { type: 'stage'; stage: GenStage; message: string; ms?: number }
  | { type: 'board'; board: Board; warnings: string[]; catalogVersion: string; timings: Record<string, number> }
  | { type: 'done'; ms: number }
  | { type: 'error'; message: string; stage?: GenStage }

export interface GenConstraints {
  /** maximum board size in mm; the packer grows the board up to this limit */
  maxWidth?: number
  maxHeight?: number
  /** preferred supply, e.g. "7.4V LiPo" */
  supply?: string
  notes?: string
}

export interface GenRequest {
  prompt: string
  constraints?: GenConstraints
}

/** Catalog entry normalised to what the generator needs, independent of the catalog module's exact shape. */
export interface CatalogItem {
  id: string
  name: string
  kind: PartKind
  category: string
  description: string
  interfaces: string[]
  voltage?: string
  current?: string
  /** footprint size in mm (from bodyFor when the catalog doesn't say) */
  w: number
  h: number
  /** pad count as rendered (padsFor) */
  pinCount: number
  /** pin names in pin order, when known */
  pinNames?: string[]
  /** the raw catalog entry (passed back to toPart) */
  raw: unknown
}

/** A JSON-schema-ish object in the Gemini `responseSchema` dialect (OpenAPI subset). */
export type Schema = Record<string, unknown>

/** Injected LLM call: returns the parsed JSON response. Lives server-side only. */
export type LlmCall = (opts: { model: 'argon' | 'carbon'; system: string; prompt: string; schema: Schema }) => Promise<unknown>
