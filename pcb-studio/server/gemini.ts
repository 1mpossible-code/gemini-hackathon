import { readFileSync } from 'node:fs'

/**
 * Minimal Gemini REST client (generateContent + structured output).
 * The API key stays in this process: it is never logged, echoed in errors,
 * or sent anywhere but generativelanguage.googleapis.com.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

export const MODELS = {
  argon: process.env.GEMINI_PLAN_MODEL || 'gemini-4-argon',
  carbon: process.env.GEMINI_FAST_MODEL || 'gemini-4-carbon',
} as const

/** GEMINI_API_KEY, or (outside production) the file named by GEMINI_API_KEY_FILE. */
export function resolveApiKey(env: Record<string, string | undefined>): string | null {
  const direct = env.GEMINI_API_KEY?.trim()
  if (direct) return direct
  const file = env.GEMINI_API_KEY_FILE?.trim()
  if (file && env.NODE_ENV !== 'production') {
    try {
      const k = readFileSync(file, 'utf8').trim()
      if (k) return k
    } catch {
      /* unreadable key file: treated as missing */
    }
  }
  return null
}

export interface GeminiCallOpts {
  model: string
  system: string
  prompt: string
  schema: Record<string, unknown>
  temperature?: number
  thinkingBudget?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export interface GeminiUsage {
  model: string
  ms: number
  promptTokens?: number
  outputTokens?: number
}

export class GeminiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export async function callGemini(apiKey: string, o: GeminiCallOpts, onUsage?: (u: GeminiUsage) => void): Promise<unknown> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: o.system }] },
    contents: [{ role: 'user', parts: [{ text: o.prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: o.schema,
      temperature: o.temperature ?? 0.3,
      ...(typeof o.thinkingBudget === 'number' ? { thinkingConfig: { thinkingBudget: o.thinkingBudget } } : {}),
    },
  })
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now()
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 180_000)
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
    try {
      const res = await fetch(`${ENDPOINT}/${encodeURIComponent(o.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal,
      })
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`
        try {
          const j = (await res.json()) as { error?: { message?: string; status?: string } }
          if (j.error?.message) msg = `${res.status} ${j.error.status ?? ''} ${j.error.message}`.replace(/\s+/g, ' ')
        } catch {
          /* non-JSON error body */
        }
        const err = new GeminiError(`Gemini ${o.model}: ${msg.slice(0, 300)}`, res.status)
        if (res.status === 429 || res.status >= 500) {
          lastErr = err
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
          continue
        }
        throw err
      }
      const j = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
        promptFeedback?: { blockReason?: string }
      }
      onUsage?.({ model: o.model, ms: Date.now() - started, promptTokens: j.usageMetadata?.promptTokenCount, outputTokens: j.usageMetadata?.candidatesTokenCount })
      const cand = j.candidates?.[0]
      const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('')
      if (!text) throw new GeminiError(`Gemini ${o.model}: empty response (${cand?.finishReason ?? j.promptFeedback?.blockReason ?? 'no candidates'})`)
      try {
        return JSON.parse(text)
      } catch {
        lastErr = new GeminiError(`Gemini ${o.model}: response was not valid JSON (${cand?.finishReason ?? 'unknown'})`)
        continue
      }
    } catch (e) {
      if (o.signal?.aborted) throw new GeminiError('aborted')
      if (e instanceof GeminiError && e.status && e.status < 500 && e.status !== 429) throw e
      lastErr = e instanceof Error && e.name === 'TimeoutError' ? new GeminiError(`Gemini ${o.model}: timed out`) : e
    }
  }
  throw lastErr instanceof Error ? lastErr : new GeminiError(`Gemini ${o.model}: request failed`)
}
