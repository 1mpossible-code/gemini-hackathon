import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, Box, Boxes, Cable, Check, CheckCircle2, ChevronRight, CircuitBoard, Cpu,
  Download, Expand, ExternalLink, FileJson, Image as ImageIcon, Layers, Loader2,
  Maximize, PanelLeftClose, PanelLeftOpen, Pause, Play, RotateCw, Search, ShieldCheck,
  ShoppingBag, Sparkles, Tag, Undo2, Wrench, X,
} from 'lucide-react'
import { PcbScene } from '@/scene/Scene'
import {
  commitBoardEdit, commitSystemSwap, computeBoardBomCost, computeSystemDevicesCost,
  beginDesignRequest, cycleLabelMode, getStudio, goScale, loadExampleBoard, requestExport, requestFit, setStudio, undoLastEdit, useStudio,
  type ExportFormat, type ShopOffer, type ShopSearchEntry,
} from '@/state/studio'
import { board as roverBoard, type Board, type Part } from '@/data/board'
import { buildTelemetryDemoBoard } from '@/data/repairDemo'
import { byId } from '@/data/catalog'
import { alternativesFor, analyzeDevice, analyzeSystem, unitPrice } from '@/data/system'
import type { Verification as VerificationData } from '@/verify/types'
import { routeNets, traceLength } from '@/pcb/footprint'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tip, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ResearchPane } from '@/components/Research'
import { ScaleSwitch, ScaleTransition, SystemInspector, SystemLibrary } from '@/components/SystemPanels'

const ease = [0.16, 1, 0.3, 1] as const
const usd = (n: number) => `$${n.toFixed(2)}`

const aiModules = import.meta.glob('./ai/generate.ts')
const verifyModules = import.meta.glob('./verify/verify.ts')

type GenLog = { stage: string; message: string }

function useBoardStats(board: Board) {
  const selectedOfferByMpn = useStudio((s) => s.selectedOfferByMpn)
  return useMemo(() => {
    const traces = routeNets(board)
    const length = traces.reduce((s, t) => s + traceLength(t), 0)
    const vias = traces.reduce((s, t) => s + t.vias.length, 0) + board.groundVias.length
    const { totalUsd, unpricedCount } = computeBoardBomCost(board, selectedOfferByMpn)
    return { traces: traces.length, length, vias, cost: totalUsd, unpricedCount }
  }, [board, selectedOfferByMpn])
}

async function fetchShopSearch(p: { mpn: string; name: string; manufacturer: string; query?: string }): Promise<ShopSearchEntry> {
  const res = await fetch('/api/shop/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  })
  const data = (await res.json()) as ShopSearchEntry
  setStudio((s) => ({ shopByMpn: { ...s.shopByMpn, [p.mpn]: data } }))
  return data
}

async function runBoardDesignChecks() {
  const isCurrent = beginDesignRequest()
  const board = getStudio().board
  setStudio({ verification: { status: 'running', theorems: [] } })
  try {
    const loader = verifyModules['./verify/verify.ts']
    if (!loader) throw new Error('Design verification service unavailable')
    const mod = (await loader()) as { verifyBoard: (b: Board) => Promise<VerificationData> }
    const result = await mod.verifyBoard(board)
    if (!isCurrent()) return
    setStudio({ verification: result })
    return result
  } catch (e) {
    if (!isCurrent()) return
    const fallback: VerificationData = {
      status: 'failed',
      theorems: [],
      log: e instanceof Error ? e.message : String(e),
    }
    setStudio({ verification: fallback })
    return fallback
  }
}

async function runAiBoardRepair(): Promise<{ repaired: boolean; rationale: string }> {
  const isCurrent = beginDesignRequest()
  const current = getStudio().board
  const prevVer = getStudio().verification
  const prevSys = getStudio().system
  const res = await fetch('/api/repair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board: current, verification: prevVer }),
  })
  const data = (await res.json()) as {
    repaired?: boolean
    rationale?: string
    board?: Board
    verification?: VerificationData
    error?: string
  }
  if (!isCurrent()) return { repaired: false, rationale: 'Discarded obsolete AI fix; design changed.' }
  if (!res.ok || data.error || !data.board || !data.verification) {
    throw new Error(data.error ?? `AI fix failed (HTTP ${res.status})`)
  }
  const passedCount = data.verification.theorems.filter((t) => t.ok).length
  const totalCount = data.verification.theorems.length
  setStudio((s) => ({
    history: [
      ...s.history.slice(-19),
      {
        system: JSON.parse(JSON.stringify(prevSys)),
        board: JSON.parse(JSON.stringify(current)),
        verification: prevVer,
        budgetUsd: s.budgetUsd,
        selectedOfferByMpn: { ...s.selectedOfferByMpn },
        label: 'AI board fix',
      },
    ],
    board: data.board!,
    verification: data.verification!,
    lastDiff: [
      `AI updated board → Rev ${data.board!.revision}`,
      data.repaired ? `All ${totalCount} design checks passed` : `${passedCount}/${totalCount} checks passed`,
    ],
    lastChange: {
      id: Date.now(),
      summary: data.repaired
        ? `Fixed with AI (Rev ${data.board!.revision}) · All ${totalCount} design checks passed`
        : `AI updated board (Rev ${data.board!.revision}) · ${totalCount - passedCount} issue(s) remain`,
      tone: data.repaired ? 'ok' : 'warn',
    },
    touring: false,
  }))
  return {
    repaired: Boolean(data.repaired),
    rationale: data.rationale ?? 'Updated board routing and re-ran design checks.',
  }
}

function TopBar() {
  const board = useStudio((s) => s.board)
  const sys = useStudio((s) => s.system)
  const scale = useStudio((s) => s.scale)
  const mode = useStudio((s) => s.mode)
  const v = useStudio((s) => s.verification)
  const checksOpen = useStudio((s) => s.checksOpen)
  const historyLen = useStudio((s) => s.history.length)
  const selectedOffers = useStudio((s) => s.selectedOfferByMpn)
  const budget = useStudio((s) => s.budgetUsd)

  const health = useMemo(() => analyzeSystem(sys, board), [sys, board])
  const devCost = useMemo(() => computeSystemDevicesCost(sys, selectedOffers).totalUsd, [sys, selectedOffers])
  const pcbCost = useMemo(() => computeBoardBomCost(board, selectedOffers).totalUsd, [board, selectedOffers])
  const shownCost = scale === 'system' ? devCost + pcbCost : pcbCost

  const boardFailed = v.theorems.filter((t) => !t.ok).length
  const totalIssues = (scale === 'system' ? health.warningCount : 0) + boardFailed
  const checkSummary =
    v.status === 'running'
      ? { label: 'Checking changes…', tone: 'muted' as const }
      : totalIssues > 0
      ? { label: `${totalIssues} ${totalIssues === 1 ? 'issue' : 'issues'} need attention`, tone: 'warn' as const }
      : v.status === 'passed' && (scale === 'board' || health.unverifiedCount === 0)
      ? { label: 'Design checks passed', tone: 'ok' as const }
      : { label: scale === 'system' ? 'Checks pending' : 'Run design checks', tone: 'muted' as const }

  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-3">
      <div className="flex items-center gap-2">
        <div className="grid size-7 place-items-center rounded-md bg-foreground text-background">
          <CircuitBoard className="size-4" strokeWidth={2.2} />
        </div>
        <span className="text-sm font-semibold tracking-tight">Forge</span>
      </div>

      <ChevronRight className="size-3.5 text-muted-foreground" />
      <button
        onClick={() => goScale('system')}
        className={cn('truncate text-sm', scale === 'system' && mode === 'engineer' ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
      >
        {sys.name}
      </button>
      <AnimatePresence initial={false}>
        {scale === 'board' && mode === 'engineer' && (
          <motion.span
            key="crumb"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }}
            transition={{ duration: 0.25, ease }}
            className="flex min-w-0 items-center gap-2"
          >
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{board.name}</span>
          </motion.span>
        )}
      </AnimatePresence>
      <Badge className="label-mono hidden sm:inline-flex !text-foreground">Rev {board.revision}</Badge>

      {mode === 'engineer' && (
        <div className="ml-2 hidden items-center gap-1.5 lg:flex">
          <button
            onClick={() => setStudio({ checksOpen: !checksOpen })}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
              checkSummary.tone === 'warn'
                ? 'border-amber-400/35 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                : checkSummary.tone === 'ok'
                ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground',
            )}
          >
            {v.status === 'running' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : checkSummary.tone === 'warn' ? (
              <AlertTriangle className="size-3.5 text-amber-400" />
            ) : checkSummary.tone === 'ok' ? (
              <CheckCircle2 className="size-3.5 text-emerald-400" />
            ) : (
              <ShieldCheck className="size-3.5" />
            )}
            <span>{checkSummary.label}</span>
          </button>

          <button
            onClick={() => setStudio(scale === 'system' ? { systemTab: 'bom' } : { inspectorTab: 'bom' })}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 font-mono text-xs text-foreground tabular hover:bg-accent"
            title="Open Parts & cost"
          >
            <span>{usd(shownCost)}</span>
            <span className="text-[10px] text-muted-foreground">parts</span>
            {budget != null && shownCost > budget && (
              <span className="text-[11px] font-semibold text-amber-300" role="status">{usd(shownCost - budget)} over budget</span>
            )}
          </button>
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {mode === 'engineer' && historyLen > 0 && (
          <Tip label="Undo last change">
            <Button size="sm" variant="ghost" onClick={undoLastEdit}>
              <Undo2 className="size-3.5" /> Undo
            </Button>
          </Tip>
        )}
        <Button size="sm" variant="ghost" onClick={() => loadExampleBoard(
          board.name.includes('Telemetry Node') ? structuredClone(roverBoard) : buildTelemetryDemoBoard(),
        )}>
          {board.name.includes('Telemetry Node') ? 'Full rover PCB' : 'Repair demo'}
        </Button>
        <ScaleSwitch />
        <ExportMenu />
      </div>
    </header>
  )
}

function DesignChecksDrawer() {
  const open = useStudio((s) => s.checksOpen)
  const sys = useStudio((s) => s.system)
  const board = useStudio((s) => s.board)
  const v = useStudio((s) => s.verification)
  const [fixing, setFixing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const health = useMemo(() => analyzeSystem(sys, board), [sys, board])

  if (!open) return null

  const passed = v.theorems.filter((t) => t.ok).length
  const failedTheorems = v.theorems.filter((t) => !t.ok)

  const handleFixBoard = async () => {
    setFixing(true)
    setNote(null)
    try {
      const res = await runAiBoardRepair()
      setNote(res.rationale)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setFixing(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2, ease }}
      className="absolute right-3 top-14 z-30 w-[min(420px,calc(100%-24px))] rounded-xl border border-border bg-popover/95 p-4 shadow-2xl backdrop-blur-md"
      role="dialog"
      aria-label="Design checks summary"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4" />
          <h3 className="text-sm font-semibold">Design checks</h3>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => setStudio({ checksOpen: false })} aria-label="Close design checks">
          <X className="size-3.5" />
        </Button>
      </div>

      {/* System electrical summary */}
      <div className="mt-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="label-mono">Assembly electrical checks</span>
          <span className="font-mono text-[10.5px] text-muted-foreground">
            {health.warningCount} warnings · {health.unverifiedCount} unverified
          </span>
        </div>
        {health.issues.length === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-500/10 p-2 text-xs text-emerald-200">
            <CheckCircle2 className="size-4 text-emerald-400" />
            All assembly connections look electrically compatible.
          </div>
        ) : (
          <div className="max-h-40 space-y-1.5 overflow-y-auto">
            {health.issues.map((issue) => (
              <div key={issue.deviceId} className="rounded-md border border-border bg-card p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{issue.deviceLabel}</span>
                  <button
                    onClick={() => setStudio({ scale: 'system', device: issue.deviceId, systemTab: 'inspect', checksOpen: false })}
                    className="font-mono text-[10.5px] text-muted-foreground underline hover:text-foreground"
                  >
                    Inspect
                  </button>
                </div>
                <p className="mt-0.5 text-[11px] text-amber-200/90">{issue.headline}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Board formal checks summary */}
      <div className="mt-4 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="label-mono">Circuit board checks</span>
          <div className="flex items-center gap-1.5">
            {failedTheorems.length > 0 && (
              <Button size="sm" variant="default" className="h-7 text-xs" onClick={handleFixBoard} disabled={fixing || v.status === 'running'}>
                {fixing ? <Loader2 className="size-3 animate-spin" /> : <Wrench className="size-3" />}
                Fix with AI
              </Button>
            )}
            <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={runBoardDesignChecks} disabled={v.status === 'running' || fixing}>
              {v.status === 'running' ? <Loader2 className="size-3 animate-spin" /> : 'Check now'}
            </Button>
          </div>
        </div>

        <p className="mt-1.5 text-xs text-muted-foreground">
          {v.status === 'running'
            ? 'Checking clearances, wiring, power limits, and thermals…'
            : v.status === 'passed'
            ? `All ${v.theorems.length} circuit board rules passed.`
            : v.status === 'failed'
            ? `${failedTheorems.length} of ${v.theorems.length} board checks failed (${failedTheorems.map((t) => t.name.replaceAll('_', ' ')).join(', ')}).`
            : 'Circuit board formal checks have not been run on this revision yet.'}
        </p>

        {note && (
          <p className="mt-2 rounded border border-border bg-muted/40 p-2 font-mono text-[10.5px] text-muted-foreground">{note}</p>
        )}

        {v.theorems.length > 0 && (
          <details className="mt-2 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer font-mono hover:text-foreground">
              Technical details (Lean 4 · {passed}/{v.theorems.length})
            </summary>
            <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded border border-border bg-muted/30 p-2 font-mono text-[10.5px]">
              {v.theorems.map((t) => (
                <li key={t.name} className="flex items-center gap-2" title={t.statement}>
                  {t.ok ? <Check className="size-3 text-emerald-400" /> : <X className="size-3 text-red-300" />}
                  <span className={t.ok ? 'text-foreground' : 'text-red-300'}>{t.name}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </motion.div>
  )
}

function ExportMenu() {
  const [open, setOpen] = useState(false)
  const items: { f: ExportFormat; label: string; sub: string; icon: typeof Box }[] = [
    { f: 'stl', label: 'STL', sub: '3D print / enclosure fit', icon: Box },
    { f: 'glb', label: 'GLB', sub: 'Full-color 3D model', icon: Boxes },
    { f: 'obj', label: 'OBJ', sub: 'CAD mesh export', icon: Layers },
    { f: 'png', label: 'PNG', sub: 'Viewport image', icon: ImageIcon },
    { f: 'json', label: 'Parts & cost', sub: 'JSON BOM & checks', icon: FileJson },
  ]
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen((v) => !v)}>
        <Download className="size-3.5" /> Export
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.2, ease }}
            className="absolute right-0 top-10 z-50 w-60 origin-top-right rounded-lg border border-border bg-popover p-1 shadow-2xl"
          >
            {items.map((it) => (
              <button
                key={it.f}
                onClick={() => {
                  requestExport(it.f)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-accent"
              >
                <it.icon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{it.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">{it.sub}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Library() {
  const board = useStudio((s) => s.board)
  const selected = useStudio((s) => s.selected)
  const hovered = useStudio((s) => s.hovered)
  const open = useStudio((s) => s.leftPanelOpen)
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const m = new Map<string, Part[]>()
    for (const p of board.parts) {
      const s = `${p.ref} ${p.name} ${p.mpn} ${p.value ?? ''}`.toLowerCase()
      if (q && !s.includes(q.toLowerCase())) continue
      m.set(p.category, [...(m.get(p.category) ?? []), p])
    }
    return [...m]
  }, [board, q])

  if (!open) return null

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border max-lg:hidden" aria-label="Board components">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="label-mono">Board Parts</span>
        <div className="flex items-center gap-1.5">
          <span className="label-mono tabular">{board.parts.length}</span>
          <Tip label="Hide parts list">
            <Button size="icon-sm" variant="ghost" className="size-6" onClick={() => setStudio({ leftPanelOpen: false })} aria-label="Hide parts list">
              <PanelLeftClose className="size-3.5" />
            </Button>
          </Tip>
        </div>
      </div>
      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute left-5.5 top-2 size-3.5 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search board parts" className="h-8 pl-8 text-xs" />
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {groups.map(([cat, parts]) => (
          <div key={cat} className="mt-2">
            <div className="label-mono px-2 py-1">{cat}</div>
            {parts.map((p) => (
              <button
                key={p.ref}
                onClick={() => setStudio({ selected: p.ref, inspectorTab: 'inspect', touring: false })}
                onMouseEnter={() => setStudio({ hovered: p.ref })}
                onMouseLeave={() => setStudio({ hovered: null })}
                className={cn(
                  'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  selected === p.ref ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  hovered === p.ref && selected !== p.ref && 'bg-accent/60',
                )}
              >
                {selected === p.ref && (
                  <motion.span layoutId="lib-sel" transition={{ duration: 0.3, ease }} className="absolute inset-0 rounded-md bg-accent" />
                )}
                <span className="relative min-w-0 flex-1 truncate text-foreground">{p.name}</span>
                <span className="relative shrink-0 font-mono text-[10px] text-muted-foreground">{p.ref}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

function Toolbar() {
  const view = useStudio((s) => s.view)
  const scale = useStudio((s) => s.scale)
  const exploded = useStudio((s) => s.exploded)
  const showTraces = useStudio((s) => s.showTraces)
  const showAllWires = useStudio((s) => s.showAllWires)
  const labelMode = useStudio((s) => s.labelMode)
  const touring = useStudio((s) => s.touring)
  const views = ['3d', 'top', 'bottom'] as const
  const labelCaption = labelMode === 'contextual' ? 'Focus' : labelMode === 'all' ? 'All' : 'Off'

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease }}
      className="absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-xl border border-border bg-background/85 p-1 shadow-2xl backdrop-blur-md"
    >
      <div className="relative flex shrink-0 rounded-lg bg-secondary p-0.5">
        {views.map((v) => (
          <button key={v} onClick={() => setStudio({ view: v })} className="label-mono relative px-2.5 py-1.5 !text-[10px]">
            {view === v && <motion.span layoutId="view-pill" transition={{ duration: 0.3, ease }} className="absolute inset-0 rounded-md bg-foreground" />}
            <span className={cn('relative', view === v ? 'text-background' : 'text-muted-foreground')}>{v}</span>
          </button>
        ))}
      </div>
      <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
      <Tip label="Explode assembly (E)">
        <Button size="sm" variant={exploded ? 'default' : 'ghost'} aria-label="Explode assembly" onClick={() => setStudio((s) => ({ exploded: !s.exploded, touring: false }))}>
          <Expand className="size-3.5" /> <span className="hidden xl:inline">Explode</span>
        </Button>
      </Tip>
      <Tip label="Fit entire model (F)">
        <Button size="sm" variant="ghost" aria-label="Fit entire model" onClick={requestFit}>
          <Maximize className="size-3.5" /> <span className="hidden xl:inline">Fit</span>
        </Button>
      </Tip>
      <Tip label="Showcase tour (T)">
        <Button size="sm" variant={touring ? 'default' : 'ghost'} aria-label="Showcase tour" onClick={() => setStudio((s) => ({ touring: !s.touring }))}>
          {touring ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} <span className="hidden xl:inline">Tour</span>
        </Button>
      </Tip>
      <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
      <Tip label={`Component labels: ${labelCaption} (click to cycle)`}>
        <Button size="sm" variant={labelMode === 'all' ? 'secondary' : 'ghost'} aria-label={`Component labels: ${labelCaption}`} onClick={cycleLabelMode}>
          <Tag className="size-3.5" /> <span className="hidden md:inline">{labelCaption}</span>
        </Button>
      </Tip>
      {scale === 'system' ? (
        <Tip label={showAllWires ? 'Showing all bus wires' : 'Showing focused wires only'}>
          <Button size="sm" variant={showAllWires ? 'secondary' : 'ghost'} aria-label="Toggle all wiring" onClick={() => setStudio((s) => ({ showAllWires: !s.showAllWires }))}>
            <Cable className="size-3.5" /> <span className="hidden lg:inline">Wiring</span>
          </Button>
        </Tip>
      ) : (
        <Tip label="Toggle copper traces">
          <Button size="sm" variant={showTraces ? 'secondary' : 'ghost'} aria-label="Toggle copper traces" onClick={() => setStudio((s) => ({ showTraces: !s.showTraces }))}>
            <Layers className="size-3.5" /> <span className="hidden lg:inline">Traces</span>
          </Button>
        </Tip>
      )}
    </motion.div>
  )
}

function ChangeToast() {
  const change = useStudio((s) => s.lastChange)
  const historyLen = useStudio((s) => s.history.length)
  if (!change) return null
  return (
    <motion.div
      key={change.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2, ease }}
      className={cn(
        'absolute bottom-16 left-1/2 z-20 flex max-w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs shadow-xl backdrop-blur-md',
        change.tone === 'warn'
          ? 'border-amber-400/35 bg-amber-950/85 text-amber-100'
          : change.tone === 'ok'
          ? 'border-emerald-400/35 bg-emerald-950/85 text-emerald-100'
          : 'border-border bg-background/90 text-foreground',
      )}
      role="status"
      aria-live="polite"
    >
      <span className="truncate">{change.summary}</span>
      {historyLen > 0 && (
        <button onClick={undoLastEdit} className="shrink-0 font-mono text-[11px] underline hover:opacity-80">
          Undo
        </button>
      )}
      <button onClick={() => setStudio({ lastChange: null })} className="ml-1 shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss message">
        <X className="size-3.5" />
      </button>
    </motion.div>
  )
}

function CopilotBar() {
  const scale = useStudio((s) => s.scale)
  const sys = useStudio((s) => s.system)
  const board = useStudio((s) => s.board)
  const deviceId = useStudio((s) => s.device)
  const selectedPartRef = useStudio((s) => s.selected)
  const v = useStudio((s) => s.verification)
  const leftOpen = useStudio((s) => s.leftPanelOpen)
  const pending = useStudio((s) => s.pendingPrompt)
  const started = useRef<string | null>(null)

  const [promptOpen, setPromptOpen] = useState(false)
  const [explainText, setExplainText] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<GenLog[]>([])
  const [error, setError] = useState<string | null>(null)

  const selectedDev = useMemo(() => sys.devices.find((d) => d.id === deviceId), [sys.devices, deviceId])
  const selectedCheck = useMemo(() => (selectedDev ? analyzeDevice(selectedDev, board) : null), [selectedDev, board])
  const health = useMemo(() => analyzeSystem(sys, board), [sys, board])

  useEffect(() => {
    setExplainText(null)
  }, [deviceId, selectedPartRef, scale])

  const runGenerate = async (override?: string) => {
    const promptStr = (override ?? text).trim()
    if (!promptStr || busy) return
    const isCurrent = beginDesignRequest()
    const prev = getStudio().board
    const prevVer = getStudio().verification
    const prevSys = getStudio().system
    setPromptOpen(true)
    setBusy(true)
    setError(null)
    setLog([])
    try {
      const loader = aiModules['./ai/generate.ts']
      if (!loader) throw new Error('AI generation service unavailable')
      const mod = (await loader()) as { generateBoard: (p: string, on: (e: { type: string; stage?: string; message?: string }) => void) => Promise<Board> }
      const nextBoard = await mod.generateBoard(promptStr, (e) => {
        if (isCurrent() && e.type === 'stage') setLog((l) => [...l.slice(-4), { stage: e.stage ?? '', message: e.message ?? '' }])
      })
      if (!isCurrent()) return
      setStudio((s) => ({
        history: [
          ...s.history.slice(-19),
          {
            system: JSON.parse(JSON.stringify(prevSys)),
            board: JSON.parse(JSON.stringify(prev)),
            verification: prevVer,
            budgetUsd: s.budgetUsd,
            selectedOfferByMpn: { ...s.selectedOfferByMpn },
            label: `Generated "${nextBoard.name}"`,
          },
        ],
        scale: 'board',
        board: nextBoard,
        selected: null,
        exploded: false,
        touring: false,
        verification: { status: 'idle', theorems: [] },
        lastChange: {
          id: Date.now(),
          summary: `Generated "${nextBoard.name}" (${nextBoard.parts.length} parts, ${nextBoard.nets.length} nets)`,
          tone: 'ok',
        },
      }))
      setPromptOpen(false)
      requestFit()
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!pending || busy || started.current === pending) return
    started.current = pending
    setStudio({ pendingPrompt: null })
    setText(pending)
    void runGenerate(pending).finally(() => { started.current = null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  // Real contextual engineering actions
  const handleExplainSelected = () => {
    if (scale === 'system' && selectedDev) {
      const item = byId[selectedDev.catalogId]
      const chk = analyzeDevice(selectedDev, board)
      setExplainText(
        `${selectedDev.label} (${item.name}): ${item.description} Powered via ${selectedDev.port} (${selectedDev.rail} V rail). Status: ${chk.headline}.`,
      )
      return
    }
    if (scale === 'board' && selectedPartRef) {
      const part = board.parts.find((p) => p.ref === selectedPartRef)
      if (part) {
        setExplainText(`${part.name} (${part.ref}, ${part.mpn}): ${part.description}`)
      }
    }
  }

  const handleFindCheaper = () => {
    if (scale === 'system' && selectedDev) {
      const alts = alternativesFor(selectedDev, board).filter((a) => !a.current)
      const cheaper = alts.filter((a) => a.delta < 0).sort((a, b) => a.price - b.price)[0]
      if (cheaper) {
        commitSystemSwap(selectedDev.id, cheaper.item.id)
      } else {
        setExplainText(
          `${byId[selectedDev.catalogId].name} (${usd(unitPrice(byId[selectedDev.catalogId]))}) is already the lowest-cost option in this catalog. Use "Buy parts" to check live merchant offers.`,
        )
      }
      return
    }
    // Whole-system cost check
    let savings = 0
    let bestSwap: { devId: string; catId: string; name: string; save: number } | null = null
    for (const d of sys.devices) {
      const alts = alternativesFor(d, board).filter((a) => !a.current && a.delta < 0 && a.severity !== 'warning')
      if (alts.length) {
        const pick = alts.sort((a, b) => a.delta - b.delta)[0]
        savings += -pick.delta
        if (!bestSwap || -pick.delta > bestSwap.save) {
          bestSwap = { devId: d.id, catId: pick.item.id, name: pick.item.name, save: -pick.delta }
        }
      }
    }
    if (bestSwap) {
      setStudio({ device: bestSwap.devId, systemTab: 'inspect' })
      setExplainText(`Found up to ${usd(savings)} in compatible catalog savings — starting with ${bestSwap.name} (−${usd(bestSwap.save)}).`)
    } else {
      setStudio({ systemTab: 'bom' })
      setExplainText('Current parts are already the lowest-cost compatible options in the catalog. Check live sellers in Parts & cost.')
    }
  }

  const handleBestSwap = () => {
    if (!selectedDev) return
    const targetId =
      selectedCheck?.suggestedCatalogId ??
      alternativesFor(selectedDev, board).find((a) => !a.current && a.severity !== 'warning')?.item.id
    if (targetId) {
      const sameCount = sys.devices.filter((d) => d.bus === selectedDev.bus && d.catalogId === selectedDev.catalogId).length
      commitSystemSwap(selectedDev.id, targetId, { applyToMatching: sameCount > 1 })
    } else {
      setExplainText('No higher-compatibility drop-in replacement is in the current catalog. Review power wiring in Board view.')
    }
  }

  return (
    <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex flex-col items-start gap-2">
      <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
        {!leftOpen && (
          <Tip label="Show component list">
            <Button
              size="sm"
              variant="secondary"
              className="h-8 bg-background/85 backdrop-blur-md"
              onClick={() => setStudio({ leftPanelOpen: true })}
              aria-label="Show component list"
            >
              <PanelLeftOpen className="size-3.5" /> Components
            </Button>
          </Tip>
        )}

        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-background/80 p-1 shadow-lg backdrop-blur-md">
          <Button
            size="sm"
            variant={promptOpen ? 'default' : 'ghost'}
            className="h-7 px-2.5 text-xs"
            onClick={() => setPromptOpen((o) => !o)}
          >
            <Sparkles className="size-3.5" />
            {promptOpen ? 'Close AI' : 'Modify with AI'}
          </Button>

          <div className="mx-0.5 h-4 w-px bg-border" />

          {scale === 'system' && selectedDev ? (
            <>
              {selectedCheck?.severity === 'warning' && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-amber-200 hover:text-amber-100" onClick={handleBestSwap}>
                  <Wrench className="size-3" /> Fix power warning
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={handleFindCheaper}>
                Lower cost
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={handleExplainSelected}>
                Explain part
              </Button>
            </>
          ) : scale === 'system' ? (
            <>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setStudio({ checksOpen: true })}>
                Check compatibility {health.warningCount > 0 ? `(${health.warningCount})` : ''}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={handleFindCheaper}>
                Reduce cost
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={runBoardDesignChecks} disabled={v.status === 'running'}>
                {v.status === 'running' ? <Loader2 className="size-3 animate-spin" /> : 'Check design'}
              </Button>
              {v.status === 'failed' && v.theorems.some((t) => !t.ok) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-amber-200"
                  onClick={async () => {
                    try {
                      await runAiBoardRepair()
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e))
                      setPromptOpen(true)
                    }
                  }}
                >
                  <Wrench className="size-3" /> Fix with AI
                </Button>
              )}
              {selectedPartRef && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={handleExplainSelected}>
                  Explain part
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <AnimatePresence>
        {explainText && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="pointer-events-auto flex max-w-md items-start gap-2 rounded-lg border border-border bg-background/92 px-3 py-2 text-xs shadow-xl backdrop-blur-md"
          >
            <p className="leading-relaxed text-foreground">{explainText}</p>
            <button onClick={() => setExplainText(null)} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Close explanation">
              <X className="size-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(promptOpen || busy || error) && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease }}
            className="pointer-events-auto w-[min(520px,100%)]"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault()
                runGenerate()
              }}
              className="flex items-center gap-2 rounded-xl border border-border bg-background/92 p-1.5 pl-3 shadow-2xl backdrop-blur-md"
            >
              <Sparkles className="size-4 shrink-0 text-muted-foreground" />
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Describe a custom board or change (e.g. “ESP32 EMG gesture wristband with BLE”)"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                autoFocus
              />
              <Button size="sm" type="submit" disabled={busy || !text.trim()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Generate'}
              </Button>
            </form>
            {(busy || error) && (
              <div className="mt-1.5 rounded-lg border border-border bg-background/92 p-2.5 text-xs backdrop-blur-md">
                {busy && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    <span>{log[log.length - 1]?.message || 'Generating circuit and PCB layout with Gemini…'}</span>
                  </div>
                )}
                {log.length > 0 && (
                  <details className="mt-1.5 text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer font-mono hover:text-foreground">Activity ({log.length})</summary>
                    <div className="mt-1 space-y-0.5 font-mono text-[10.5px]">
                      {log.map((l, i) => (
                        <div key={i} className="truncate">
                          <span className="uppercase">{l.stage}:</span> {l.message}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {error && <div className="mt-1 text-red-300">{error}</div>}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function PartEditor({ part }: { part: Part }) {
  const [searching, setSearching] = useState(false)
  const shopEntry = useStudio((s) => s.shopByMpn[part.mpn])
  const selectedOffer = useStudio((s) => s.selectedOfferByMpn[part.mpn])

  const moveAxis = (axis: 'x' | 'y', val: number) => {
    if (!Number.isFinite(val)) return
    commitBoardEdit((draft) => {
      const target = draft.parts.find((p) => p.ref === part.ref)
      if (target) target[axis] = +val.toFixed(2)
    }, `Moved ${part.name} (${part.ref})`)
  }

  const rotatePart = () => {
    const nextRot = (part.rot + 90) % 360
    commitBoardEdit((draft) => {
      const target = draft.parts.find((p) => p.ref === part.ref)
      if (target) target.rot = nextRot
    }, `Rotated ${part.name} to ${nextRot}°`)
  }

  const runPartShop = async () => {
    setSearching(true)
    try {
      await fetchShopSearch({ mpn: part.mpn, name: part.name, manufacturer: part.manufacturer })
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <span className="label-mono">Position</span>
        <Button size="sm" variant="ghost" onClick={rotatePart} className="h-6 px-2 text-[11px]">
          <RotateCw className="size-3" /> {part.rot}°
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label-mono !text-[9.5px]">X (mm)</span>
          <Input
            key={`${part.ref}-x-${part.x}`}
            type="number"
            step="0.5"
            defaultValue={part.x}
            onBlur={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v !== part.x) moveAxis('x', v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="mt-1 h-7 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="label-mono !text-[9.5px]">Y (mm)</span>
          <Input
            key={`${part.ref}-y-${part.y}`}
            type="number"
            step="0.5"
            defaultValue={part.y}
            onBlur={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v !== part.y) moveAxis('y', v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="mt-1 h-7 font-mono text-xs"
          />
        </label>
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="label-mono">Buy parts</span>
        <Button size="sm" variant="secondary" onClick={runPartShop} disabled={searching} className="h-6 px-2 text-[11px]">
          {searching ? <Loader2 className="size-3 animate-spin" /> : <ShoppingBag className="size-3" />}
          Find sellers
        </Button>
      </div>

      {shopEntry && (
        <div className="space-y-1.5 text-xs">
          {shopEntry.status === 'no_results' && (
            <div className="rounded border border-dashed border-border p-2 text-[11px] text-muted-foreground">
              No live listings found for {part.mpn}; using reference pricing.
            </div>
          )}
          {shopEntry.status === 'error' && <div className="text-[11px] text-red-300">{shopEntry.error}</div>}
          {shopEntry.offers.slice(0, 3).map((o) => {
            const active = selectedOffer?.offerId === o.offerId
            return (
              <div key={o.offerId} className={cn('rounded-md border p-2', active ? 'border-foreground/60 bg-accent/40' : 'border-border')}>
                <div className="flex items-start justify-between gap-2">
                  <span className="line-clamp-1 text-[11.5px] font-medium">{o.title}</span>
                  <span className="shrink-0 font-mono text-[11.5px]">{o.formattedPrice}</span>
                </div>
                <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {o.sellerName} · {o.available ? 'In stock' : 'Out of stock'}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  {o.matchKind === 'exact_match' && o.available && o.currency === 'USD' && (
                    <Button
                      size="sm"
                      variant={active ? 'default' : 'outline'}
                      className="h-6 px-2 text-[10.5px]"
                      onClick={() =>
                        setStudio((s) => ({
                          selectedOfferByMpn: active
                            ? Object.fromEntries(Object.entries(s.selectedOfferByMpn).filter(([k]) => k !== part.mpn))
                            : { ...s.selectedOfferByMpn, [part.mpn]: o },
                        }))
                      }
                    >
                      {active ? 'Using price' : 'Use price'}
                    </Button>
                  )}
                  <a
                    href={o.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Open store <ExternalLink className="size-2.5" />
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function BomAndShopPanel() {
  const board = useStudio((s) => s.board)
  const budgetUsd = useStudio((s) => s.budgetUsd)
  const shopByMpn = useStudio((s) => s.shopByMpn)
  const selectedOfferByMpn = useStudio((s) => s.selectedOfferByMpn)
  const [searchingAll, setSearchingAll] = useState(false)

  const lines = useMemo(() => {
    const map = new Map<string, { part: Part; refs: string[]; catUnit: number | null; offer?: ShopOffer }>()
    for (const p of board.parts) {
      const cur = map.get(p.mpn) ?? {
        part: p,
        refs: [],
        catUnit: p.pricing?.[0]?.price ?? null,
        offer: selectedOfferByMpn[p.mpn],
      }
      cur.refs.push(p.ref)
      map.set(p.mpn, cur)
    }
    return [...map.values()]
  }, [board, selectedOfferByMpn])

  const { totalUsd, unpricedCount } = useMemo(
    () => computeBoardBomCost(board, selectedOfferByMpn),
    [board, selectedOfferByMpn],
  )

  const searchMajorParts = async () => {
    setSearchingAll(true)
    try {
      const targets = lines
        .filter((l) => l.part.major || l.part.kind === 'module' || l.part.kind === 'ssop' || l.part.kind === 'soic')
        .slice(0, 5)
      await Promise.all(
        targets.map((t) =>
          fetchShopSearch({ mpn: t.part.mpn, name: t.part.name, manufacturer: t.part.manufacturer }),
        ),
      )
    } finally {
      setSearchingAll(false)
    }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="label-mono">Board parts cost</div>
          <div className="mt-0.5 font-mono text-xl font-medium tabular">${totalUsd.toFixed(2)}</div>
        </div>
        <Button size="sm" variant="secondary" onClick={searchMajorParts} disabled={searchingAll}>
          {searchingAll ? <Loader2 className="size-3.5 animate-spin" /> : <ShoppingBag className="size-3.5" />}
          Buy parts
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <span className="label-mono shrink-0">Budget ($)</span>
        <Input
          type="number"
          aria-label="Budget in dollars"
          min="0"
          step="1"
          value={budgetUsd ?? ''}
          placeholder="No cap"
          onChange={(e) => {
            const raw = e.target.value.trim()
            const num = Number(raw)
            setStudio({
              budgetUsd: raw === '' ? null : Number.isFinite(num) && num >= 0 ? num : budgetUsd,
            })
          }}
          className="h-7 font-mono text-xs"
        />
      </div>

      {budgetUsd != null && (
        <div
          className={cn(
            'rounded-md border px-2.5 py-1.5 font-mono text-[11px]',
            totalUsd > budgetUsd ? 'border-amber-400/40 bg-amber-500/10 text-amber-200' : 'border-border text-muted-foreground',
          )}
        >
          {totalUsd > budgetUsd
            ? `Over budget by $${(totalUsd - budgetUsd).toFixed(2)}`
            : `$${(budgetUsd - totalUsd).toFixed(2)} remaining under $${budgetUsd.toFixed(2)}`}
          {unpricedCount > 0 ? ` · ${unpricedCount} unpriced` : ''}
        </div>
      )}

      <div className="space-y-1.5">
        {lines.map(({ part, refs, catUnit, offer }) => {
          const shop = shopByMpn[part.mpn]
          const bestExactUsd = shop?.offers.find((o) => o.matchKind === 'exact_match' && o.available && o.priceUsd != null)
          const effUnit = offer?.priceUsd ?? catUnit
          const ext = effUnit != null ? effUnit * refs.length : null
          return (
            <div key={part.mpn} className="rounded-md border border-border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <button
                  onClick={() => setStudio({ selected: refs[0], inspectorTab: 'inspect', touring: false })}
                  className="truncate text-left font-medium hover:underline"
                >
                  {part.name}
                </button>
                <span className="shrink-0 font-mono text-[11.5px] tabular">
                  {ext != null ? `$${ext.toFixed(2)}` : 'Unpriced'}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                <span className="truncate">{part.mpn} ×{refs.length}</span>
                <span>{offer ? offer.sellerName : catUnit != null ? `$${catUnit.toFixed(3)}/ea ref` : 'no quote'}</span>
              </div>
              {bestExactUsd && !offer && (
                <div className="mt-1.5 flex items-center justify-between border-t border-border/60 pt-1 text-[10.5px]">
                  <span className="truncate text-muted-foreground">
                    Live: {bestExactUsd.formattedPrice} · {bestExactUsd.sellerName}
                  </span>
                  <button
                    onClick={() =>
                      setStudio((s) => ({
                        selectedOfferByMpn: { ...s.selectedOfferByMpn, [part.mpn]: bestExactUsd },
                      }))
                    }
                    className="ml-2 shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] hover:bg-accent"
                  >
                    Use
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        Component BOM only (live offers powered by Shop.dev). Excludes bare PCB fabrication, assembly, shipping, and tax.
      </p>
    </div>
  )
}

function Inspector() {
  const board = useStudio((s) => s.board)
  const selected = useStudio((s) => s.selected)
  const tab = useStudio((s) => s.inspectorTab)
  const part = board.parts.find((p) => p.ref === selected)
  const stats = useBoardStats(board)
  const nets = useMemo(
    () => (part ? board.nets.filter((n) => n.path.some((x) => x.startsWith(part.ref + '.'))) : []),
    [board, part],
  )
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border max-md:hidden" aria-label="Board inspector">
      <Tabs
        value={tab}
        onValueChange={(v) => setStudio({ inspectorTab: v as 'inspect' | 'bom' })}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="border-b border-border px-3 py-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="inspect">{part ? part.name.split(' ')[0] : 'Board'}</TabsTrigger>
            <TabsTrigger value="bom">Parts &amp; cost</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="inspect" className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {part ? (
              <motion.div
                key={part.ref}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22, ease }}
                className="p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="label-mono">{part.category} · {part.ref}</div>
                    <h2 className="mt-1 text-base font-semibold tracking-tight">{part.name}</h2>
                    <div className="mt-0.5 text-xs text-muted-foreground">{part.manufacturer} · {part.mpn}</div>
                  </div>
                  <Button size="icon-sm" variant="ghost" onClick={() => setStudio({ selected: null })} aria-label="Deselect part">
                    <X className="size-3.5" />
                  </Button>
                </div>

                <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{part.description}</p>

                <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
                  {[
                    ['Package', part.pkg],
                    ['Unit price', part.pricing?.[0] ? usd(part.pricing[0].price) : 'Unpriced'],
                    ['Position', `${part.x.toFixed(1)}, ${part.y.toFixed(1)} mm`],
                    ['Rotation', `${part.rot}°`],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-card p-2">
                      <dt className="label-mono !text-[9px]">{k}</dt>
                      <dd className="mt-0.5 truncate font-mono text-[11.5px]">{v}</dd>
                    </div>
                  ))}
                </dl>

                <PartEditor part={part} />

                <details className="mt-4 border-t border-border pt-3 text-xs">
                  <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground hover:text-foreground">
                    Technical details ({nets.length} connected nets)
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {nets.map((n, i) => (
                      <button
                        key={n.name + i}
                        onMouseEnter={() => setStudio({ hoveredNet: n.name })}
                        onMouseLeave={() => setStudio({ hoveredNet: null })}
                        className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                      >
                        {n.name}
                      </button>
                    ))}
                  </div>
                </details>
              </motion.div>
            ) : (
              <motion.div key="board" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-4">
                <div className="label-mono">Circuit Board</div>
                <div className="mt-1 text-base font-semibold tracking-tight">{board.name}</div>
                <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
                  {[
                    ['Size', `${board.width} × ${board.height} mm`],
                    ['Thickness', `${board.thickness} mm`],
                    ['Components', String(board.parts.length)],
                    ['Connections', `${board.nets.length} nets`],
                    ['Copper length', `${(stats.length / 10).toFixed(1)} cm`],
                    ['Est. parts', usd(stats.cost)],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-card p-2">
                      <div className="label-mono !text-[9px]">{k}</div>
                      <div className="mt-0.5 font-mono text-[11.5px]">{v}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Click any component on the board to adjust placement, inspect connections, or check live pricing.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </TabsContent>

        <TabsContent value="bom" className="min-h-0 flex-1 overflow-y-auto">
          <BomAndShopPanel />
        </TabsContent>
      </Tabs>
      <DesignChecksCard />
    </aside>
  )
}

function DesignChecksCard() {
  const board = useStudio((s) => s.board)
  const v = useStudio((s) => s.verification)
  const [repairing, setRepairing] = useState(false)
  const [repairNote, setRepairNote] = useState<string | null>(null)

  const handleCheck = async () => {
    setRepairNote(null)
    await runBoardDesignChecks()
  }

  const handleRepair = async () => {
    if (repairing) return
    setRepairing(true)
    setRepairNote(null)
    try {
      const res = await runAiBoardRepair()
      setRepairNote(res.rationale)
    } catch (e) {
      setRepairNote(e instanceof Error ? e.message : String(e))
    } finally {
      setRepairing(false)
    }
  }

  const passed = v.theorems.filter((t) => t.ok).length
  const failed = v.theorems.filter((t) => !t.ok)

  return (
    <div className="border-t border-border p-4">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-2">
          {v.status === 'passed' ? (
            <CheckCircle2 className="size-4 text-emerald-400" />
          ) : v.status === 'failed' ? (
            <AlertTriangle className="size-4 text-amber-400" />
          ) : (
            <ShieldCheck className="size-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">Design checks</span>
        </div>
        <div className="flex items-center gap-1">
          {failed.length > 0 && (
            <Button size="sm" variant="default" onClick={handleRepair} disabled={repairing || v.status === 'running'}>
              {repairing ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
              Fix with AI
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={handleCheck} disabled={v.status === 'running' || repairing}>
            {v.status === 'running' ? <Loader2 className="size-3.5 animate-spin" /> : 'Check'}
          </Button>
        </div>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {v.status === 'running'
          ? 'Checking clearances, wiring, power, and thermal margins…'
          : v.status === 'passed'
          ? `Design checks passed (${passed}/${v.theorems.length} rules verified).`
          : v.status === 'failed' && failed.length > 0
          ? `${failed.length} ${failed.length === 1 ? 'issue needs' : 'issues need'} attention: ${failed.map((t) => t.name.replaceAll('_', ' ')).join(', ')}.`
          : v.status === 'failed'
          ? 'Could not complete board checks.'
          : 'Check spacing, wiring, power budget, and thermal safety.'}
      </p>

      {board.name.includes('Telemetry Node') && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Small PCB repair demo only — not certification of the full rover. Run Design checks, then Fix with AI.
        </p>
      )}
      {repairNote && (
        <p className="mt-2 rounded border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">{repairNote}</p>
      )}

      {v.theorems.length > 0 && (
        <details className="mt-2.5 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer font-mono hover:text-foreground">
            Technical details (Lean 4 · {passed}/{v.theorems.length})
          </summary>
          <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded border border-border bg-muted/30 p-2 font-mono text-[10.5px]">
            {v.theorems.map((t) => (
              <li key={t.name} title={t.statement} className="flex items-center gap-2">
                {t.ok ? <Check className="size-3 text-emerald-400" /> : <X className="size-3 text-red-300" />}
                <span className={t.ok ? 'text-foreground' : 'text-red-300'}>{t.name}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function StatusBar() {
  const board = useStudio((s) => s.board)
  const sys = useStudio((s) => s.system)
  const scale = useStudio((s) => s.scale)
  const hoveredDevice = useStudio((s) => s.hoveredDevice)
  const hovered = useStudio((s) => s.hovered)
  const selectedOffers = useStudio((s) => s.selectedOfferByMpn)
  const v = useStudio((s) => s.verification)

  const health = useMemo(() => analyzeSystem(sys, board), [sys, board])
  const devCost = useMemo(() => computeSystemDevicesCost(sys, selectedOffers).totalUsd, [sys, selectedOffers])
  const pcbCost = useMemo(() => computeBoardBomCost(board, selectedOffers).totalUsd, [board, selectedOffers])

  const boardFailed = v.theorems.filter((t) => !t.ok).length
  const hasWarnings = (scale === 'system' && health.warningCount > 0) || boardFailed > 0
  const isAllVerified = v.status === 'passed' && (scale === 'board' || (health.warningCount === 0 && health.unverifiedCount === 0))

  const statusText =
    v.status === 'running'
      ? 'Checking design…'
      : hasWarnings
      ? `${scale === 'system' ? health.warningCount + boardFailed : boardFailed} issues need review`
      : isAllVerified
      ? 'Checks passed'
      : 'Unverified properties'

  const hoveredDevLabel = hoveredDevice
    ? hoveredDevice === 'pcb'
      ? board.name
      : sys.devices.find((d) => d.id === hoveredDevice)?.label ?? hoveredDevice
    : null
  const hoveredPartLabel = hovered
    ? board.parts.find((p) => p.ref === hovered)?.name ?? hovered
    : null

  return (
    <footer className="label-mono flex h-7 shrink-0 items-center gap-4 border-t border-border px-3 !text-[10px]">
      <button
        onClick={() => setStudio((s) => ({ checksOpen: !s.checksOpen }))}
        className="flex items-center gap-1.5 hover:text-foreground"
      >
        <span
          className={cn(
            'size-1.5 rounded-full',
            hasWarnings ? 'bg-amber-400' : isAllVerified ? 'bg-emerald-400' : 'bg-muted-foreground',
          )}
        />
        <span className={hasWarnings ? 'text-amber-300' : isAllVerified ? 'text-emerald-300' : ''}>{statusText}</span>
      </button>
      <span className="tabular">{scale === 'system' ? `${sys.devices.length} modules` : `${board.parts.length} parts`}</span>
      <span className="tabular">Parts {usd(scale === 'system' ? devCost + pcbCost : pcbCost)}</span>
      <span className="ml-auto flex items-center gap-1.5">
        <Cpu className="size-3" />
        {scale === 'system'
          ? hoveredDevLabel ?? 'Click a component to inspect · Scroll into PCB'
          : hoveredPartLabel ?? 'Click a part to inspect'}
      </span>
    </footer>
  )
}

export default function App() {
  const scale = useStudio((s) => s.scale)
  const mode = useStudio((s) => s.mode)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'e') setStudio((s) => ({ exploded: !s.exploded, touring: false }))
      if (e.key === 't') setStudio((s) => ({ touring: !s.touring }))
      if (e.key === 'f') {
        setStudio({ touring: false })
        requestFit()
      }
      if (e.key === 'Escape') setStudio({ selected: null, device: null, checksOpen: false, touring: false })
      if (e.key === 'z') goScale(getStudio().scale === 'system' ? 'board' : 'system')
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  return (
    <TooltipProvider delayDuration={250}>
      <ResearchPane />
      {mode === 'engineer' && (
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <TopBar />
        <div className="relative flex min-h-0 flex-1">
          {mode === 'engineer' && (
            <>
              {scale === 'system' ? <SystemLibrary /> : <Library />}
              <motion.main
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.45, ease }}
                className="relative min-w-0 flex-1"
              >
                <PcbScene />
                <CopilotBar />
                <AnimatePresence>
                  <DesignChecksDrawer />
                </AnimatePresence>
                <AnimatePresence>
                  <ChangeToast />
                </AnimatePresence>
                <Toolbar />
                <ScaleTransition />
              </motion.main>
              {scale === 'system' ? <SystemInspector /> : <Inspector />}
            </>
          )}
        </div>
        <StatusBar />
      </div>
      )}
    </TooltipProvider>
  )
}
