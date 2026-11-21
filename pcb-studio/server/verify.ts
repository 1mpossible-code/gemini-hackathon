// Vite middleware: POST /api/verify {board} → Lean 4 certificate check.
//
// Writes verify/Forge/Generated.lean from the board, runs `lake build Forge.Generated`,
// and maps Lean errors back to theorems by line span (Lean keeps elaborating after a
// failed declaration, so each theorem passes or fails independently).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { Certificate, Verification } from '../src/verify/types.ts'

export interface VerifyOptions {
  /** the lake project directory (default: <root>/verify) */
  projectDir?: string
  timeoutMs?: number
  /** builds the certificate; loaded lazily through Vite's SSR loader so `@/` aliases resolve */
  load?: () => Promise<(board: unknown) => Certificate>
}

const BUILD_TIMEOUT_MS = 180_000

function lakeBin(): string {
  const home = path.join(homedir(), '.elan', 'bin', 'lake')
  return existsSync(home) ? home : 'lake'
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ code: number | null; out: string; timedOut: boolean }>((resolve) => {
    const env = { ...process.env, PATH: `${path.join(homedir(), '.elan', 'bin')}:${process.env.PATH ?? ''}` }
    const child = spawn(cmd, args, { cwd, env })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out: out + String(e), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, timedOut })
    })
  })
}

interface LeanError { line: number; msg: string }

/** Parse `Generated.lean:LINE:COL: error: …` diagnostics (message runs to the next diagnostic). */
export function parseErrors(log: string): LeanError[] {
  const errs: LeanError[] = []
  const re = /Generated\.lean:(\d+):(\d+): (error|warning|info)(?:\([^)]*\))?: ?/g
  const hits = [...log.matchAll(re)]
  hits.forEach((m, i) => {
    if (m[3] !== 'error') return
    const end = i + 1 < hits.length ? hits[i + 1].index! : log.length
    errs.push({ line: Number(m[1]), msg: log.slice(m.index! + m[0].length, end).trim().split('\n').slice(0, 6).join('\n') })
  })
  return errs
}

export function parseDiagnostics(log: string): string[] {
  return [...log.matchAll(/^FORGE\|(.*)$/gm)].map((m) => m[1])
}

/** Run the full pipeline for one certificate. Serialised: lake builds share one directory. */
export async function verifyCertificate(cert: Certificate, projectDir: string, timeoutMs = BUILD_TIMEOUT_MS): Promise<Verification> {
  const t0 = Date.now()
  await mkdir(path.join(projectDir, 'Forge'), { recursive: true })
  await writeFile(path.join(projectDir, 'Forge', 'Generated.lean'), cert.source)
  const { code, out, timedOut } = await run(lakeBin(), ['build', 'Forge.Generated'], projectDir, timeoutMs)
  const errs = parseErrors(out)
  const theorems = cert.theorems.map((t) => {
    const e = errs.find((x) => x.line >= t.startLine && x.line <= t.endLine)
    return { name: t.name, statement: t.statement, ok: !timedOut && code !== -1 && !e, ...(e ? { error: e.msg } : {}) }
  })
  // an error outside every theorem (syntax, model) invalidates the whole certificate
  const stray = errs.filter((x) => !cert.theorems.some((t) => x.line >= t.startLine && x.line <= t.endLine))
  if (stray.length) theorems.forEach((t) => (t.ok = false))
  const passed = code === 0 && !timedOut && theorems.every((t) => t.ok)
  return {
    status: passed ? 'passed' : 'failed',
    theorems,
    log: (timedOut ? `lake build timed out after ${timeoutMs} ms\n` : '') + out.slice(-20_000),
    durationMs: Date.now() - t0,
    diagnostics: parseDiagnostics(out),
    assumptions: cert.assumptions,
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = ''
    req.on('data', (c) => {
      s += c
      if (s.length > 5_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(s))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

export function verifyPlugin(opts: VerifyOptions = {}): Plugin {
  const cache = new Map<string, Verification>()
  let queue: Promise<unknown> = Promise.resolve()
  let projectDir = opts.projectDir ?? ''
  let load = opts.load

  return {
    name: 'forge-verify',
    configureServer(server) {
      projectDir ||= path.join(server.config.root, 'verify')
      load ||= async () => (await server.ssrLoadModule('/src/verify/toLean.ts')).buildCertificate
      server.middlewares.use('/api/verify', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        try {
          const { board } = JSON.parse(await readBody(req))
          if (!board || !Array.isArray(board.parts)) return send(res, 400, { error: 'expected {board}' })
          const cert = (await load!())(board)
          const key = createHash('sha256').update(cert.source).digest('hex')
          const hit = cache.get(key)
          if (hit) return send(res, 200, { ...hit, cached: true })
          const job = queue.then(() => verifyCertificate(cert, projectDir, opts.timeoutMs))
          queue = job.catch(() => undefined)
          const result = await job
          if (result.log && !/timed out/.test(result.log)) cache.set(key, result)
          send(res, 200, result)
        } catch (e) {
          send(res, 500, { status: 'failed', theorems: [], log: e instanceof Error ? (e.stack ?? e.message) : String(e) })
        }
      })
    },
  }
}

export default verifyPlugin
