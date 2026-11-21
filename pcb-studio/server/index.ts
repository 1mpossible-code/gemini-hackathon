import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { loadEnv, runnerImport, type Plugin } from 'vite'
import { callGemini, MODELS, resolveApiKey, type GeminiUsage } from './gemini.ts'

/**
 * Vite dev + preview middleware for AI board generation.
 *
 *   POST /api/generate  {prompt: string, constraints?: {...}}
 *   → 200 application/x-ndjson, one event per line:
 *     {type:'stage', stage:'plan'|'select'|'place'|'route'|'check', message, ms}
 *     {type:'board', board, warnings, catalogVersion, timings}
 *     {type:'done', ms}
 *   or {type:'error', message, stage?} (in-stream), or a 4xx/5xx JSON body before streaming starts.
 *
 * The pipeline lives in src/ai/pipeline.ts and is loaded through Vite's SSR
 * module loader so it shares the app's TS + `@` alias; the Gemini key is only
 * read here and injected as a call function.
 */

// Shape of src/ai/pipeline.ts as seen from here (kept structural so the node
// tsconfig doesn't have to type-check the app sources).
type Stage = 'plan' | 'select' | 'place' | 'route' | 'check'
type GenEvent = { type: string; stage?: Stage; [k: string]: unknown }
interface PipelineModule {
  runPipeline(
    req: { prompt: string; constraints?: Record<string, unknown> },
    deps: {
      llm: (o: { model: 'argon' | 'carbon'; system: string; prompt: string; schema: Record<string, unknown> }) => Promise<unknown>
      emit: (e: GenEvent) => void
      signal?: AbortSignal
    },
  ): Promise<{ board: unknown; warnings: string[]; catalogVersion: string; timings: Record<string, number> }>
}

const PIPELINE = '/src/ai/pipeline.ts'
const MAX_BODY = 32 * 1024
const MAX_CONCURRENT = 3

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

export function forgeAi(): Plugin {
  let env: Record<string, string | undefined> = process.env
  let root = process.cwd()
  let inFlight = 0

  const makeHandler = (load: () => Promise<PipelineModule>, log: (m: string) => void) =>
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return sendJson(res, 405, { type: 'error', message: 'Use POST' })
      }
      let body: Record<string, unknown>
      try {
        body = (await readJson(req)) as Record<string, unknown>
      } catch (e) {
        return sendJson(res, 400, { type: 'error', message: (e as Error).message })
      }
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
      if (!prompt || prompt.length > 2000) return sendJson(res, 400, { type: 'error', message: 'prompt must be a non-empty string up to 2000 characters' })
      const constraints = body.constraints && typeof body.constraints === 'object' ? (body.constraints as Record<string, unknown>) : undefined
      const apiKey = resolveApiKey(env)
      if (!apiKey) return sendJson(res, 503, { type: 'error', message: 'AI generation is not configured on this server (GEMINI_API_KEY missing)' })
      if (inFlight >= MAX_CONCURRENT) return sendJson(res, 429, { type: 'error', message: 'Too many generations in progress, try again shortly' })

      inFlight++
      const ac = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) ac.abort()
      })
      res.statusCode = 200
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('cache-control', 'no-cache, no-transform')
      res.setHeader('x-accel-buffering', 'no')
      res.flushHeaders?.()
      let lastStage: Stage | undefined
      const send = (e: GenEvent) => {
        if (e.stage) lastStage = e.stage
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`)
      }
      const started = Date.now()
      const usage: GeminiUsage[] = []
      try {
        const mod = await load()
        const result = await mod.runPipeline(
          { prompt, constraints },
          {
            signal: ac.signal,
            emit: send,
            llm: (o) => callGemini(apiKey, { ...o, model: MODELS[o.model], signal: ac.signal }, (u) => usage.push(u)),
          },
        )
        send({ type: 'board', ...result, timings: { ...result.timings, llm: usage.reduce((a, u) => a + u.ms, 0) } })
        send({ type: 'done', ms: Date.now() - started })
        log(`generated board in ${Date.now() - started} ms (${usage.map((u) => `${u.model} ${u.ms}ms`).join(', ')})`)
      } catch (e) {
        const message = ac.signal.aborted ? 'aborted' : (e as Error).message || 'generation failed'
        send({ type: 'error', message, stage: lastStage })
        if (!ac.signal.aborted) log(`generation failed at ${lastStage ?? 'start'}: ${message}`)
      } finally {
        inFlight--
        res.end()
      }
    }

  return {
    name: 'forge-ai',
    configResolved(config) {
      root = config.root
      env = { ...loadEnv(config.mode, config.envDir || config.root, ['GEMINI_']), ...process.env }
    },
    configureServer(server) {
      const log = (m: string) => server.config.logger.info(`[forge-ai] ${m}`, { timestamp: true })
      server.middlewares.use('/api/generate', makeHandler(() => server.ssrLoadModule(PIPELINE) as Promise<PipelineModule>, log))
    },
    configurePreviewServer(server) {
      const log = (m: string) => server.config.logger.info(`[forge-ai] ${m}`, { timestamp: true })
      let mod: Promise<PipelineModule> | null = null
      const load = () =>
        (mod ??= runnerImport<PipelineModule>(join(root, PIPELINE), {
          configFile: false,
          root,
          logLevel: 'error',
          resolve: { alias: { '@': join(root, 'src') } },
        }).then((r) => r.module))
      server.middlewares.use('/api/generate', makeHandler(load, log))
    },
  }
}
