import { Readable } from 'node:stream'
import { resolve } from 'node:path'
import { loadEnv, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, sendJson } from './http.ts'

type Task = { phase: 'preview' | 'refine'; modelUrl?: string }
const tasks = new Map<string, Task>()
const API = 'https://api.meshy.ai/openapi/v2/text-to-3d'
const idPattern = /^[a-zA-Z0-9-]{1,100}$/

export function conceptPlugin(): Plugin {
  let key = ''
  async function meshy(path: string, options: RequestInit = {}) {
    const response = await fetch(API + path, { ...options, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) })
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403 ? 'Meshy rejected the API key. Check MESHY_API_KEY and your account access.' : response.status === 402 ? 'Meshy has insufficient credits.' : response.status === 429 ? 'Meshy is busy or rate limited. Try again shortly.' : `Meshy request failed (HTTP ${response.status}).`
      throw new Error(message)
    }
    return response.json() as Promise<Record<string, unknown>>
  }
  async function handler(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    try {
      if (req.method === 'GET' && path === '/status') return sendJson(res, 200, { configured: Boolean(key) })
      if (!key) return sendJson(res, 503, { error: 'Set MESHY_API_KEY in pcb-studio/.env.local and restart the server to generate 3D concepts.' })
      if (req.method === 'POST' && path === '/') {
        const body = await readJson<{ prompt?: unknown }>(req, 8192)
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (!prompt || prompt.length > 700) return sendJson(res, 400, { error: 'Enter a description between 1 and 700 characters.' })
        const result = await meshy('', { method: 'POST', body: JSON.stringify({ mode: 'preview', ai_model: 'meshy-7.1', prompt: `A complete, fully assembled 3D object: ${prompt}. Show the entire object, isolated.`, target_formats: ['glb'] }) })
        if (typeof result.result !== 'string' || !idPattern.test(result.result)) throw new Error('Meshy returned an invalid task ID.')
        tasks.set(result.result, { phase: 'preview' })
        return sendJson(res, 200, { id: result.result })
      }
      const match = path.match(/^\/([a-zA-Z0-9-]{1,100})(?:\/(refine|model))?$/)
      const task = match && tasks.get(match[1])
      if (!match || !task) return sendJson(res, 404, { error: 'Generation not found. Start a new concept.' })
      const [, id, action] = match
      if (req.method === 'POST' && action === 'refine') {
        if (task.phase !== 'preview' || !task.modelUrl) return sendJson(res, 409, { error: 'The preview is not ready yet.' })
        const result = await meshy('', { method: 'POST', body: JSON.stringify({ mode: 'refine', preview_task_id: id, enable_pbr: true, target_formats: ['glb'] }) })
        if (typeof result.result !== 'string' || !idPattern.test(result.result)) throw new Error('Meshy returned an invalid task ID.')
        tasks.set(result.result, { phase: 'refine' })
        return sendJson(res, 200, { id: result.result })
      }
      if (req.method === 'GET' && action === 'model') {
        if (!task.modelUrl) return sendJson(res, 409, { error: 'The model is not ready yet.' })
        const upstream = await fetch(task.modelUrl, { signal: AbortSignal.timeout(60000) })
        if (!upstream.ok || !upstream.body) throw new Error('Could not download the generated model from Meshy.')
        res.setHeader('Content-Type', 'model/gltf-binary')
        res.setHeader('Cache-Control', 'private, max-age=3600')
        return Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res)
      }
      if (req.method === 'GET' && !action) {
        const data = await meshy(`/${id}`)
        const status = typeof data.status === 'string' ? data.status : 'UNKNOWN'
        if (status === 'SUCCEEDED') {
          const urls = data.model_urls as Record<string, unknown> | undefined
          if (typeof urls?.glb !== 'string' || !urls.glb.startsWith('https://')) throw new Error('Meshy did not return a GLB model.')
          task.modelUrl = urls.glb
        }
        return sendJson(res, 200, { status, progress: typeof data.progress === 'number' ? data.progress : 0, phase: task.phase, modelUrl: task.modelUrl ? `/api/concept/${id}/model` : undefined, error: status === 'FAILED' ? 'Meshy could not generate this model. Try a more descriptive prompt.' : undefined })
      }
      return sendJson(res, 405, { error: 'Method not allowed.' })
    } catch (error) {
      if (!res.headersSent) sendJson(res, 502, { error: error instanceof Error ? error.message : '3D generation failed.' })
      else res.destroy()
    }
  }
  return {
    name: 'forge-concept',
    configResolved(config) {
      const parent = loadEnv(config.mode, resolve(config.root, '..'), ['MESHY_'])
      const local = loadEnv(config.mode, config.envDir || config.root, ['MESHY_'])
      key = (process.env.MESHY_API_KEY || local.MESHY_API_KEY || parent.MESHY_API_KEY || '').trim()
    },
    configureServer(server) { server.middlewares.use('/api/concept', handler) },
    configurePreviewServer(server) { server.middlewares.use('/api/concept', handler) },
  }
}
