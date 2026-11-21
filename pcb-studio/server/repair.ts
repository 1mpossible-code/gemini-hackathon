import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { loadEnv, runnerImport, type Plugin } from 'vite'
import { callGemini, resolveApiKey } from './gemini.ts'
import { verifyCertificate } from './verify.ts'
import type { Certificate } from '../src/verify/types.ts'
import type { Board as BoardData, Net as BoardNet } from '../src/data/board.ts'
import { readJson, sendJson } from './http.ts'

interface FootprintMod {
  bodyFor(p: unknown): { w: number; h: number; height: number }
  routeNets(b: unknown): { net: string; width: number; layer: 'top' | 'bottom'; points: [number, number][] }[]
}

const REPAIR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    width: { type: 'NUMBER', description: 'optional expanded board width in mm if needed for outline/overlap' },
    height: { type: 'NUMBER', description: 'optional expanded board height in mm if needed for outline/overlap' },
    partMoves: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'STRING' },
          x: { type: 'NUMBER' },
          y: { type: 'NUMBER' },
        },
        required: ['ref', 'x', 'y'],
      },
    },
    netEdits: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER', description: '0-based index into board.nets' },
          layer: { type: 'STRING', enum: ['top', 'bottom'] },
          width: { type: 'NUMBER' },
        },
        required: ['index'],
      },
    },
    rationale: { type: 'STRING', description: 'concise engineering explanation of how the failed Lean constraints were fixed' },
  },
  required: ['rationale'],
}

function segDistSq(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): number {
  const orient = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const onSeg = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.min(p[0], r[0]) <= q[0] + 1e-6 &&
    q[0] <= Math.max(p[0], r[0]) + 1e-6 &&
    Math.min(p[1], r[1]) <= q[1] + 1e-6 &&
    q[1] <= Math.max(p[1], r[1]) + 1e-6

  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  if (
    ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
  ) {
    return 0
  }
  if (Math.abs(o1) < 1e-6 && onSeg(a, c, b)) return 0
  if (Math.abs(o2) < 1e-6 && onSeg(a, d, b)) return 0
  if (Math.abs(o3) < 1e-6 && onSeg(c, a, d)) return 0
  if (Math.abs(o4) < 1e-6 && onSeg(c, b, d)) return 0

  const ptSegSq = (p: [number, number], u: [number, number], v: [number, number]) => {
    const dx = v[0] - u[0]
    const dy = v[1] - u[1]
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1e-9) return (p[0] - u[0]) ** 2 + (p[1] - u[1]) ** 2
    const t = Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / lenSq))
    const px = u[0] + t * dx
    const py = u[1] + t * dy
    return (p[0] - px) ** 2 + (p[1] - py) ** 2
  }
  return Math.min(ptSegSq(a, c, d), ptSegSq(b, c, d), ptSegSq(c, a, b), ptSegSq(d, a, b))
}

const canonicalNet = (n: string) => (n === 'VM' ? 'VIN' : n)

function findTraceConflicts(b: BoardData, fp: FootprintMod): [number, number][] {
  const routed = fp.routeNets(b)
  const pairs: [number, number][] = []
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      const ti = routed[i]
      const tj = routed[j]
      if (ti.layer !== tj.layer) continue
      if (canonicalNet(ti.net) === canonicalNet(tj.net)) continue
      const req = (ti.width + tj.width) / 2 + 0.135
      const reqSq = req * req
      let hit = false
      for (let si = 0; si < ti.points.length - 1 && !hit; si++) {
        for (let sj = 0; sj < tj.points.length - 1 && !hit; sj++) {
          if (segDistSq(ti.points[si], ti.points[si + 1], tj.points[sj], tj.points[sj + 1]) < reqSq) {
            hit = true
          }
        }
      }
      if (hit) pairs.push([i, j])
    }
  }
  return pairs
}

const REPAIR_MODELS: Record<string, string> = {
  neon: 'gemini-4-neon',
  hydrogen: 'gemini-4-hydrogen',
  carbon: 'gemini-4-carbon',
  'gemini-4-neon': 'gemini-4-neon',
  'gemini-4-hydrogen': 'gemini-4-hydrogen',
  'gemini-4-carbon': 'gemini-4-carbon',
}

function resolveRepairModel(requested: unknown, env: Record<string, string | undefined>): string | null {
  const raw = typeof requested === 'string' && requested.trim() ? requested.trim() : (env.GEMINI_REPAIR_MODEL?.trim() || 'hydrogen')
  return Object.hasOwn(REPAIR_MODELS, raw) ? REPAIR_MODELS[raw] : null
}

function repairNetGeometry(board: BoardData, routed: ReturnType<FootprintMod['routeNets']>, index: number) {
  const n = board.nets[index]
  const pts = routed[index]?.points ?? []
  const pt = (p: [number, number]) => [+p[0].toFixed(2), +p[1].toFixed(2)]
  return {
    index,
    name: n.name,
    path: n.path,
    layer: n.layer ?? 'top',
    width: n.width ?? 0.35,
    ...(n.via?.length ? { via: n.via } : {}),
    ...(pts.length ? { start: pt(pts[0]), end: pt(pts[pts.length - 1]) } : {}),
  }
}

function buildRepairPrompt(
  board: BoardData,
  fp: FootprintMod,
  failedTheorems: { name: string; statement: string }[],
  diagnostics: string[],
) {
  const violations = diagnostics.filter((d) => !d.startsWith('warning|') && !d.startsWith('info|')).slice(0, 6)
  const routed = fp.routeNets(board)
  const conflicts = findTraceConflicts(board, fp)
  const affectedNetIds = new Set<number>()
  for (const [i, j] of conflicts.slice(0, 10)) {
    affectedNetIds.add(i)
    affectedNetIds.add(j)
  }
  const nonClearance = violations.filter((d) => !d.startsWith('trace_clearance|'))
  board.nets.forEach((n, idx) => {
    if (nonClearance.some((v) => v.includes(`|${n.name} `) || v.includes(`|${n.name}:`))) affectedNetIds.add(idx)
  })
  const affectedNets = [...affectedNetIds].sort((a, b) => a - b).slice(0, 16).map((index) => repairNetGeometry(board, routed, index))
  const layoutViolations = violations.filter((d) => d.startsWith('parts_within_outline|') || d.startsWith('no_part_overlap|'))
  const affectedParts = layoutViolations.length
    ? board.parts
        .filter((p) => layoutViolations.some((v) => v.includes(p.ref)))
        .map((p) => ({ ref: p.ref, x: p.x, y: p.y, rot: p.rot }))
    : []
  return {
    boardSize: { width: board.width, height: board.height },
    failedTheorems: failedTheorems.map((t) => ({ name: t.name, statement: t.statement })),
    violations,
    traceConflicts: conflicts.slice(0, 12).map(([a, b]) => ({
      a,
      aNet: board.nets[a].name,
      b,
      bNet: board.nets[b].name,
      layer: board.nets[a].layer ?? 'top',
    })),
    affectedNets,
    ...(affectedParts.length ? { affectedParts } : {}),
    permittedEdits: 'netEdits: change layer ("top"|"bottom") or width (0.15-2.5 mm) by net index; partMoves: {ref,x,y}; optional width/height.',
  }
}

export function stabilizeGeometryAndClearances(board: BoardData, fp: FootprintMod): string[] {
  const notes: string[] = []
  const halfW = board.width / 2
  const halfH = board.height / 2

  // 1. Clamp out-of-bounds parts
  for (const p of board.parts) {
    const body = fp.bodyFor(p)
    const rotQuarter = Math.round(p.rot / 90) % 2 !== 0
    const bw = rotQuarter ? body.h : body.w
    const bh = rotQuarter ? body.w : body.h
    const edgeAllow = p.kind === 'usbc' ? 0.9 : -0.6
    const maxX = halfW - bw / 2 + (p.kind === 'usbc' ? 0 : edgeAllow)
    const maxY = halfH - bh / 2 + edgeAllow
    const nx = Math.max(-(halfW - bw / 2 - 0.6), Math.min(maxX, p.x))
    const ny = Math.max(-(halfH - bh / 2 - 0.6), Math.min(maxY, p.y))
    if (Math.abs(nx - p.x) > 0.05 || Math.abs(ny - p.y) > 0.05) {
      p.x = +nx.toFixed(2)
      p.y = +ny.toFixed(2)
      notes.push(`Clamped ${p.ref} inside board outline (${p.x}, ${p.y} mm)`)
    }
  }

  // 2. Enforce IPC-2221 minimum widths on power & motor nets
  for (const net of board.nets) {
    const minW =
      /^(VIN|VM)$/i.test(net.name)
        ? 0.8
        : /^([AO|BO|CO|DO][12])$/i.test(net.name)
        ? 0.6
        : /^(\+?3V3|VBUS|\+?5V)$/i.test(net.name)
        ? 0.4
        : 0.25
    if ((net.width ?? 0.35) < minW) {
      net.width = minW
      notes.push(`Widened ${net.name} trace to ${minW} mm for IPC-2221 ampacity`)
    }
  }

  // 3. Resolve same-layer trace clearance violations via layer separation & perimeter bypass
  const traceConflicts = (b: BoardData) => findTraceConflicts(b, fp)

  let conflicts = traceConflicts(board)
  if (conflicts.length > 0) {
    // Greedy 2-layer coloring + waypoint detours for crossings on both layers
    for (let pass = 0; pass < 12 && conflicts.length > 0; pass++) {
      const counts = new Map<number, number>()
      for (const [i, j] of conflicts) {
        counts.set(i, (counts.get(i) ?? 0) + 1)
        counts.set(j, (counts.get(j) ?? 0) + 1)
      }
      const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      const target = board.nets[worst]
      const prevLayer = target.layer ?? 'top'
      target.layer = prevLayer === 'top' ? 'bottom' : 'top'
      const afterFlip = traceConflicts(board)
      if (afterFlip.length < conflicts.length) {
        conflicts = afterFlip
        notes.push(`Moved ${target.name} (${target.path.join('→')}) to ${target.layer} copper`)
        continue
      }
      // Flip back and try clean perimeter bypass waypoint
      target.layer = prevLayer
      const candidateVias: [number, number][][] = [
        [[0, -28.2]],
        [[-11, 28.2], [11, 28.2]],
        [[-31, -24], [-14, -24]],
        [[-31, 23], [-17, 23]],
        [[17, 23], [31, 23]],
        [[-20, -10]],
        [[20, -10]],
      ]
      let improved = false
      const origVia = target.via
      for (const layerTry of [prevLayer, prevLayer === 'top' ? 'bottom' : 'top'] as const) {
        for (const viaTry of candidateVias) {
          target.layer = layerTry
          target.via = viaTry
          const nextC = traceConflicts(board)
          if (nextC.length < conflicts.length) {
            conflicts = nextC
            notes.push(`Rerouted ${target.name} (${target.path.join('→')}) via (${viaTry[0].join(', ')}) on ${layerTry}`)
            improved = true
            break
          }
        }
        if (improved) break
      }
      if (!improved) {
        target.layer = prevLayer
        target.via = origVia
        break
      }
    }
    // shortcut: bounded local search can stall; use rip-up routing if detours cannot reduce conflicts.
    // Search both ends of every conflict; one blocked trace must not stop repair.
    for (let pass = 0; pass < 200 && conflicts.length; pass++) {
      let improved = false
      const targets = [...new Set(conflicts.flat())]
      for (const index of targets) {
        const target = board.nets[index]
        const previous = { layer: target.layer, via: target.via }
        const margin = 1 + (target.width ?? 0.35) / 2
        const xs = [-halfW + margin, -halfW / 2, 0, halfW / 2, halfW - margin]
        const ys = [-halfH + margin, -halfH / 2, 0, halfH / 2, halfH - margin]
        const candidates: (BoardNet['via'])[] = [previous.via, [[0, -28.2]], [[-11, 28.2], [11, 28.2]], [[-31, -24], [-14, -24]], [[-31, 23], [-17, 23]], [[17, 23], [31, 23]], [[-20, -10]], [[20, -10]]]
        const points = fp.routeNets(board)[index].points
        const start = points[0]
        const end = points[points.length - 1]
        // Escape fine-pitch pads perpendicular to the row before taking a detour.
        for (const offset of [-2, -1, 1, 2]) {
          for (const y of ys) candidates.push([[start[0], start[1] + offset], [start[0], y], [end[0], y], [end[0], end[1] + offset]])
          for (const x of xs) candidates.push([[start[0] + offset, start[1]], [x, start[1]], [x, end[1]], [end[0] + offset, end[1]]])
        }
        for (const x of xs) for (const y of ys) candidates.push([[x, y]])
        for (const y of ys) candidates.push([[-halfW + margin, y], [halfW - margin, y]])
        for (const x of xs) candidates.push([[x, -halfH + margin], [x, halfH - margin]])
        for (const layer of ['top', 'bottom'] as const) {
          for (const via of candidates) {
            target.layer = layer
            target.via = via
            const next = traceConflicts(board)
            if (next.length >= conflicts.length) continue
            conflicts = next
            notes.push(`Rerouted ${target.name} (${target.path.join('→')}) on ${layer}`)
            improved = true
            break
          }
          if (improved) break
        }
        if (improved) break
        target.layer = previous.layer
        target.via = previous.via
      }
      if (!improved) break
    }
  }
  return notes
}

function nextRevisionTag(rev: string): string {
  const m = /^(.*?)(\d+)$/.exec(rev)
  if (m) return `${m[1]}${Number(m[2]) + 1}`
  return `${rev}.1`
}

export function repairPlugin(): Plugin {
  let env: Record<string, string | undefined> = process.env
  let root = process.cwd()

  return {
    name: 'forge-repair',
    configResolved(config) {
      root = config.root
      const parentEnv = loadEnv(config.mode, path.resolve(config.root, '..'), ['GEMINI_', 'FORGE_'])
      const localEnv = loadEnv(config.mode, config.envDir || config.root, ['GEMINI_', 'FORGE_'])
      env = { ...parentEnv, ...localEnv, ...process.env }
    },
    configureServer(server) {
      const verifyDir = path.join(server.config.root, 'verify')

      server.middlewares.use('/api/repair', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
        try {
          const body = await readJson(req)
          const inputBoard = body.board as BoardData | undefined
          if (!inputBoard || !Array.isArray(inputBoard.parts) || !Array.isArray(inputBoard.nets)) {
            return sendJson(res, 400, { error: 'expected { board }' })
          }

          const toLeanMod = (await server.ssrLoadModule('/src/verify/toLean.ts')) as {
            buildCertificate(b: unknown): Certificate
          }
          const fpMod = (await server.ssrLoadModule('/src/pcb/footprint.ts')) as FootprintMod

          // Never trust a caller's proof: recompute from this exact board and revision.
          const initialVer = await verifyCertificate(toLeanMod.buildCertificate(inputBoard), verifyDir, 60_000)
          if (initialVer.status === 'passed') {
            return sendJson(res, 200, {
              repaired: true,
              attempts: 0,
              actor: 'lean',
              rationale: 'All 15 Lean 4 theorems already pass.',
              board: inputBoard,
              verification: initialVer,
            })
          }

          const model = resolveRepairModel(body.model, env)
          if (!model) {
            return sendJson(res, 400, { error: 'unsupported repair model (expected neon, hydrogen, or carbon)' })
          }

          const working: BoardData = JSON.parse(JSON.stringify(inputBoard))
          const failedTheorems = (initialVer.theorems ?? []).filter((t) => !t.ok)
          const apiKey = resolveApiKey(env)
          let aiRationale = ''
          let geminiLatencyMs: number | null = null
          let geminiError: string | null = null
          let promptTokens: number | null = null
          let outputTokens: number | null = null
          let promptChars: number | null = null
          let actor: 'gemini' | 'deterministic_solver' = 'deterministic_solver'

          if (apiKey) {
            const started = performance.now()
            try {
              const prompt = JSON.stringify(buildRepairPrompt(working, fpMod, failedTheorems, initialVer.diagnostics ?? []))
              promptChars = prompt.length
              const patch = (await callGemini(
                apiKey,
                {
                  model,
                  system:
                    'You are Forge PCB Studio autonomous Lean 4 repair engineer. Given failed formal PCB theorems, violations, and affected nets, ' +
                    'propose minimal netEdits (switching crossing traces between top and bottom copper or widening traces for ampacity) ' +
                    'or partMoves to satisfy all JLCPCB 2-layer and electrical rules. Return compact JSON only.',
                  prompt,
                  schema: REPAIR_SCHEMA,
                  temperature: 0.2,
                  thinkingBudget: 256,
                  signal: AbortSignal.timeout(30_000),
                  timeoutMs: 30_000,
                },
                (u) => {
                  promptTokens = u.promptTokens ?? null
                  outputTokens = u.outputTokens ?? null
                },
              )) as {
                width?: number
                height?: number
                partMoves?: { ref: string; x: number; y: number }[]
                netEdits?: { index: number; layer?: 'top' | 'bottom'; width?: number }[]
                rationale?: string
              }

              actor = 'gemini'
              if (typeof patch.width === 'number' && patch.width >= working.width && patch.width <= 160) {
                working.width = Math.round(patch.width)
              }
              if (typeof patch.height === 'number' && patch.height >= working.height && patch.height <= 140) {
                working.height = Math.round(patch.height)
              }
              for (const mv of patch.partMoves ?? []) {
                const target = working.parts.find((p) => p.ref === mv.ref)
                if (target && Number.isFinite(mv.x) && Number.isFinite(mv.y)) {
                  target.x = +mv.x.toFixed(2)
                  target.y = +mv.y.toFixed(2)
                }
              }
              for (const ne of patch.netEdits ?? []) {
                const net = working.nets[ne.index]
                if (!net) continue
                if (ne.layer === 'top' || ne.layer === 'bottom') net.layer = ne.layer
                if (typeof ne.width === 'number' && ne.width >= 0.15 && ne.width <= 2.5) {
                  net.width = +ne.width.toFixed(2)
                }
              }
              aiRationale = patch.rationale ?? ''
            } catch (error) {
              geminiError = error instanceof Error ? error.message : String(error)
            } finally {
              geminiLatencyMs = Math.round(performance.now() - started)
            }
          }

          const geoNotes = stabilizeGeometryAndClearances(working, fpMod)
          working.revision = nextRevisionTag(working.revision)

          const nextCert = toLeanMod.buildCertificate(working)
          const nextVer = await verifyCertificate(nextCert, verifyDir, 60_000)
          const summaryNotes = [
            aiRationale,
            geoNotes.length ? `Applied ${geoNotes.length} DRC/layer adjustments (${geoNotes.slice(0, 3).join('; ')}).` : '',
          ]
            .filter(Boolean)
            .join(' ')

          return sendJson(res, 200, {
            repaired: nextVer.status === 'passed',
            attempts: 1,
            actor,
            deterministicAdjustments: geoNotes.length,
            gemini: {
              model,
              latencyMs: geminiLatencyMs,
              promptChars,
              promptTokens,
              outputTokens,
              error: geminiError ?? (apiKey ? null : 'No API key configured'),
            },
            rationale: summaryNotes || 'Adjusted copper layers and clearances and re-verified in Lean 4.',
            board: working,
            verification: nextVer,
          })
        } catch (e) {
          return sendJson(res, 500, {
            error: e instanceof Error ? e.message : String(e),
          })
        }
      })
    },
    configurePreviewServer(server) {
      const verifyDir = path.join(root, 'verify')
      server.middlewares.use('/api/repair', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
        try {
          const body = await readJson(req)
          const inputBoard = body.board as BoardData | undefined
          if (!inputBoard) return sendJson(res, 400, { error: 'expected { board }' })
          const { module: toLeanMod } = await runnerImport<{ buildCertificate(b: unknown): Certificate }>(
            path.join(root, '/src/verify/toLean.ts'),
            { configFile: false, root, logLevel: 'error', resolve: { alias: { '@': path.join(root, 'src') } } },
          )
          const { module: fpMod } = await runnerImport<FootprintMod>(
            path.join(root, '/src/pcb/footprint.ts'),
            { configFile: false, root, logLevel: 'error', resolve: { alias: { '@': path.join(root, 'src') } } },
          )
          const working: BoardData = JSON.parse(JSON.stringify(inputBoard))
          const notes = stabilizeGeometryAndClearances(working, fpMod)
          working.revision = nextRevisionTag(working.revision)
          const cert = toLeanMod.buildCertificate(working)
          const verification = await verifyCertificate(cert, verifyDir, 60_000)
          return sendJson(res, 200, {
            repaired: verification.status === 'passed',
            attempts: 1,
            actor: 'deterministic_solver',
            rationale: notes.join('; ') || 'Repaired board clearances.',
            board: working,
            verification,
          })
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}
