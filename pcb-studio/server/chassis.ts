// POST /api/chassis: Gemini designs the mechanical body for any product as a list
// of primitive solids. The studio renders them with three.js. No recipe per product.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { callGemini, MODELS, resolveApiKey } from './gemini.ts'
import { readJson, sendJson } from './http.ts'

const SHAPES = ['box', 'cyl', 'ring', 'sphere'] as const
const MATS = ['metal', 'plastic', 'rubber', 'carbon', 'clear'] as const

const SYSTEM = `You are a mechanical designer. Model the physical body of the requested product as primitive solids for a 3D viewer.
Units are millimetres. y is up. The product is centred on the origin. Real-world proportions.
A custom PCB lies flat, centred at the origin, at the given height. Listed devices sit at given x,z positions. Build the body around them: do not bury the PCB inside a closed solid, leave the top open or use 'clear' covers.
Shapes:
- box: size = [width x, height y, depth z]
- cyl: size = [radius, height, 0], axis along y before rotation
- ring: size = [ring radius, tube radius, 0], lies in the x-y plane (faces z) before rotation
- sphere: size = [radius, 0, 0]
rot is [x, y, z] in degrees. Set spin true only for parts that rotate in use (rotors, wheels, fans).
Model what makes the product recognisable: frame, shell walls, arms, wheels, legs, lenses, straps, handles, nozzles. Use 12 to 60 parts. Keep everything within 400 mm of the origin.`

const num3 = { type: 'ARRAY', items: { type: 'NUMBER' }, minItems: 3, maxItems: 3 }
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    parts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          shape: { type: 'STRING', enum: [...SHAPES] },
          size: num3,
          pos: num3,
          rot: num3,
          mat: { type: 'STRING', enum: [...MATS] },
          spin: { type: 'BOOLEAN' },
        },
        required: ['shape', 'size', 'pos', 'mat'],
      },
    },
  },
  required: ['parts'],
}

const vec = (v: unknown, limit: number): [number, number, number] | null => {
  if (!Array.isArray(v) || v.length < 3) return null
  const out = v.slice(0, 3).map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(-limit, Math.min(limit, n)) : NaN))
  return out.some(Number.isNaN) ? null : (out as [number, number, number])
}

/** Keep only well-formed parts, so a bad model answer can never break the viewer. */
export function cleanParts(raw: unknown) {
  const list = Array.isArray((raw as { parts?: unknown })?.parts) ? (raw as { parts: unknown[] }).parts : []
  const parts = []
  for (const p of list.slice(0, 120) as Record<string, unknown>[]) {
    const shape = SHAPES.find((s) => s === p?.shape)
    const mat = MATS.find((m) => m === p?.mat)
    const size = vec(p?.size, 800)
    const pos = vec(p?.pos, 600)
    if (!shape || !mat || !size || !pos || size[0] <= 0) continue
    parts.push({ shape, mat, size, pos, rot: vec(p?.rot, 360) ?? undefined, spin: p?.spin === true || undefined })
  }
  return parts
}

export function chassisHandler(env: () => Record<string, string | undefined>, log: (m: string) => void) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return sendJson(res, 405, { type: 'error', message: 'Use POST' })
    let body: Record<string, unknown>
    try {
      body = (await readJson(req)) as Record<string, unknown>
    } catch (e) {
      return sendJson(res, 400, { type: 'error', message: (e as Error).message })
    }
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : ''
    if (!prompt) return sendJson(res, 400, { type: 'error', message: 'prompt is required' })
    const sent = req.headers['x-gemini-key']
    const apiKey = (typeof sent === 'string' && /^[\w-]{20,200}$/.test(sent) ? sent : '') || resolveApiKey(env())
    if (!apiKey) return sendJson(res, 200, { parts: [], reason: 'no-key' })
    const layout = typeof body.layout === 'string' ? body.layout.slice(0, 3000) : ''
    try {
      const raw = await callGemini(apiKey, { model: MODELS.argon, system: SYSTEM, prompt: `Product: ${prompt}\n\n${layout}`, schema: SCHEMA, timeoutMs: 90_000 })
      const parts = cleanParts(raw)
      log(`chassis: ${parts.length} parts`)
      return sendJson(res, 200, { parts })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      log(`chassis failed (${why})`)
      return sendJson(res, 200, { parts: [], reason: why.slice(0, 200) })
    }
  }
}
