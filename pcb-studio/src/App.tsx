import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Box, Boxes, Check, ChevronRight, CircuitBoard, Cpu, Download, Expand, FileJson, Image as ImageIcon,
  Layers, Loader2, Maximize, Pause, Play, Search, ShieldCheck, Sparkles, Tag, X,
} from 'lucide-react'
import { PcbScene } from '@/scene/Scene'
import { getStudio, requestExport, requestFit, setStudio, useStudio, type ExportFormat } from '@/state/studio'
import type { Board, Part } from '@/data/board'
import { routeNets, traceLength } from '@/pcb/footprint'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tip, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const ease = [0.16, 1, 0.3, 1] as const

// Modules written by the generation / verification workers. Loaded lazily so the
// studio still runs (offline) when they are absent.
const aiModules = import.meta.glob('./ai/generate.ts')
const verifyModules = import.meta.glob('./verify/verify.ts')

type GenLog = { stage: string; message: string }

function useBoardStats(board: Board) {
  return useMemo(() => {
    const traces = routeNets(board)
    const length = traces.reduce((s, t) => s + traceLength(t), 0)
    const vias = traces.reduce((s, t) => s + t.vias.length, 0) + board.groundVias.length
    const cost = board.parts.reduce((s, p) => s + (p.pricing?.[0]?.price ?? 0), 0)
    return { traces: traces.length, length, vias, cost }
  }, [board])
}

function TopBar() {
  const board = useStudio((s) => s.board)
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
      <div className="flex items-center gap-2">
        <div className="grid size-7 place-items-center rounded-md bg-foreground text-background">
          <CircuitBoard className="size-4" strokeWidth={2.2} />
        </div>
        <span className="text-sm font-semibold tracking-tight">Forge</span>
        <span className="label-mono hidden sm:inline">PCB Studio</span>
      </div>
      <ChevronRight className="size-3.5 text-muted-foreground" />
      <span className="truncate text-sm">{board.name}</span>
      <Badge className="label-mono !text-foreground">Rev {board.revision}</Badge>
      <div className="ml-auto flex items-center gap-1">
        <ExportMenu />
      </div>
    </header>
  )
}

function ExportMenu() {
  const [open, setOpen] = useState(false)
  const items: { f: ExportFormat; label: string; sub: string; icon: typeof Box }[] = [
    { f: 'stl', label: 'STL', sub: 'Print / enclosure fit', icon: Box },
    { f: 'glb', label: 'GLB', sub: 'Full colour glTF', icon: Boxes },
    { f: 'obj', label: 'OBJ', sub: 'Mesh for CAD import', icon: Layers },
    { f: 'png', label: 'PNG', sub: 'Viewport render', icon: ImageIcon },
    { f: 'json', label: 'BOM', sub: 'Parts, nets, proofs', icon: FileJson },
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
            transition={{ duration: 0.22, ease }}
            className="absolute right-0 top-10 z-50 w-60 origin-top-right rounded-lg border border-border bg-popover p-1 shadow-2xl"
          >
            {items.map((it, i) => (
              <motion.button
                key={it.f}
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.03, duration: 0.25, ease }}
                onClick={() => { requestExport(it.f); setOpen(false) }}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-accent"
              >
                <it.icon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{it.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">{it.sub}</span>
              </motion.button>
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
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border max-lg:hidden">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="label-mono">Library</span>
        <span className="label-mono tabular">{board.parts.length}</span>
      </div>
      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute left-5.5 top-2 size-3.5 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search parts" className="h-8 pl-8 text-xs" />
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        {groups.map(([cat, parts]) => (
          <div key={cat} className="mt-2">
            <div className="label-mono px-2 py-1">{cat}</div>
            {parts.map((p) => (
              <button
                key={p.ref}
                onClick={() => setStudio({ selected: p.ref, touring: false })}
                onMouseEnter={() => setStudio({ hovered: p.ref })}
                onMouseLeave={() => setStudio({ hovered: null })}
                className={cn(
                  'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  selected === p.ref ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  hovered === p.ref && selected !== p.ref && 'bg-accent/60',
                )}
              >
                {selected === p.ref && (
                  <motion.span layoutId="lib-sel" transition={{ duration: 0.35, ease }} className="absolute inset-0 rounded-md bg-accent" />
                )}
                <span className="relative w-9 font-mono text-[11px] text-foreground">{p.ref}</span>
                <span className="relative truncate">{p.value ? `${p.value} · ${p.pkg}` : p.name}</span>
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
  const exploded = useStudio((s) => s.exploded)
  const showTraces = useStudio((s) => s.showTraces)
  const showCallouts = useStudio((s) => s.showCallouts)
  const touring = useStudio((s) => s.touring)
  const views = ['3d', 'top', 'bottom'] as const
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.6, duration: 0.6, ease }}
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-background/80 p-1 shadow-2xl backdrop-blur-md"
    >
      <div className="relative flex rounded-lg bg-secondary p-0.5">
        {views.map((v) => (
          <button key={v} onClick={() => setStudio({ view: v })} className="label-mono relative px-3 py-1.5 !text-[10px]">
            {view === v && <motion.span layoutId="view-pill" transition={{ duration: 0.35, ease }} className="absolute inset-0 rounded-md bg-foreground" />}
            <span className={cn('relative', view === v ? 'text-background' : 'text-muted-foreground')}>{v}</span>
          </button>
        ))}
      </div>
      <div className="mx-1 h-5 w-px bg-border" />
      <Tip label="Showcase tour (T)">
        <Button size="sm" variant={touring ? 'default' : 'ghost'} onClick={() => setStudio((s) => ({ touring: !s.touring }))}>
          {touring ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} Tour
        </Button>
      </Tip>
      <Tip label="Explode assembly (E)">
        <Button size="sm" variant={exploded ? 'default' : 'ghost'} onClick={() => setStudio((s) => ({ exploded: !s.exploded, touring: false }))}>
          <Expand className="size-3.5" /> Explode
        </Button>
      </Tip>
      <Tip label="Fit board (F)">
        <Button size="sm" variant="ghost" onClick={requestFit}><Maximize className="size-3.5" /> Fit</Button>
      </Tip>
      <div className="mx-1 h-5 w-px bg-border" />
      <Tip label="Copper traces">
        <Button size="icon-sm" variant={showTraces ? 'secondary' : 'ghost'} onClick={() => setStudio((s) => ({ showTraces: !s.showTraces }))}>
          <Layers className="size-3.5" />
        </Button>
      </Tip>
      <Tip label="Callouts">
        <Button size="icon-sm" variant={showCallouts ? 'secondary' : 'ghost'} onClick={() => setStudio((s) => ({ showCallouts: !s.showCallouts }))}>
          <Tag className="size-3.5" />
        </Button>
      </Tip>
    </motion.div>
  )
}

function Prompt() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<GenLog[]>([])
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    if (!text.trim() || busy) return
    setBusy(true); setError(null); setLog([])
    try {
      const loader = aiModules['./ai/generate.ts']
      if (!loader) throw new Error('Generation service not installed')
      const mod = (await loader()) as { generateBoard: (p: string, on: (e: { type: string; stage?: string; message?: string }) => void) => Promise<Board> }
      const board = await mod.generateBoard(text, (e) => {
        if (e.type === 'stage') setLog((l) => [...l.slice(-5), { stage: e.stage ?? '', message: e.message ?? '' }])
      })
      setStudio({ board, selected: null, exploded: false, touring: true, verification: { status: 'idle', theorems: [] } })
      requestFit()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.45, duration: 0.6, ease }}
      className="absolute left-1/2 top-4 z-10 w-[min(560px,calc(100%-32px))] -translate-x-1/2"
    >
      <form
        onSubmit={(e) => { e.preventDefault(); run() }}
        className="flex items-center gap-2 rounded-xl border border-border bg-background/80 p-1.5 pl-3 shadow-2xl backdrop-blur-md"
      >
        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe a board: “ESP32 weather station with BME280 and OLED”"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <Button size="sm" type="submit" disabled={busy || !text.trim()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Generate'}
        </Button>
      </form>
      <AnimatePresence>
        {(busy || error) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease }}
            className="mt-2 overflow-hidden rounded-lg border border-border bg-background/85 backdrop-blur-md"
          >
            <div className="space-y-1 p-2.5 font-mono text-[11px]">
              {log.map((l, i) => (
                <motion.div key={i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className="flex gap-2">
                  <span className="w-12 uppercase text-muted-foreground">{l.stage}</span>
                  <span className="truncate">{l.message}</span>
                </motion.div>
              ))}
              {busy && !log.length && <div className="text-muted-foreground">Contacting Gemini…</div>}
              {error && <div className="text-red-300">{error}</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function Inspector() {
  const board = useStudio((s) => s.board)
  const selected = useStudio((s) => s.selected)
  const part = board.parts.find((p) => p.ref === selected)
  const stats = useBoardStats(board)
  const nets = useMemo(
    () => (part ? board.nets.filter((n) => n.path.some((x) => x.startsWith(part.ref + '.'))) : []),
    [board, part],
  )
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border max-md:hidden">
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {part ? (
            <motion.div
              key={part.ref}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.28, ease }}
              className="p-4"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="label-mono">Designator</div>
                  <div className="mt-1 font-mono text-3xl font-medium tracking-tight">{part.ref}</div>
                </div>
                <Button size="icon-sm" variant="ghost" onClick={() => setStudio({ selected: null })}><X className="size-3.5" /></Button>
              </div>
              <div className="mt-3 text-sm font-medium">{part.name}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{part.description}</p>
              <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
                {[
                  ['MPN', part.mpn], ['Maker', part.manufacturer], ['Package', part.pkg], ['Value', part.value ?? '—'],
                  ['Position', `${part.x.toFixed(1)}, ${part.y.toFixed(1)} mm`], ['Rotation', `${part.rot}°`],
                ].map(([k, v]) => (
                  <div key={k} className="bg-background p-2.5">
                    <dt className="label-mono !text-[9.5px]">{k}</dt>
                    <dd className="mt-1 truncate font-mono text-[11.5px]">{v}</dd>
                  </div>
                ))}
              </dl>
              {part.pricing && (
                <>
                  <div className="label-mono mt-5">Pricing</div>
                  <table className="mt-2 w-full text-xs tabular">
                    <tbody>
                      {part.pricing.map((b) => (
                        <tr key={b.qty} className="border-b border-border/60 last:border-0">
                          <td className="py-1.5 text-muted-foreground">{b.qty}+</td>
                          <td className="py-1.5 text-right font-mono">${b.price.toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <div className="label-mono mt-5">Nets · {nets.length}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {nets.map((n, i) => (
                  <button
                    key={n.name + i}
                    onMouseEnter={() => setStudio({ hoveredNet: n.name })}
                    onMouseLeave={() => setStudio({ hoveredNet: null })}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                  >
                    {n.name}
                  </button>
                ))}
              </div>
            </motion.div>
          ) : (
            <motion.div key="board" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-4">
              <div className="label-mono">Board</div>
              <div className="mt-1 text-lg font-medium tracking-tight">{board.name}</div>
              <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
                {[
                  ['Size', `${board.width} × ${board.height} mm`], ['Thickness', `${board.thickness} mm`],
                  ['Parts', board.parts.length], ['Nets', board.nets.length],
                  ['Traces', `${stats.traces} · ${(stats.length / 10).toFixed(1)} cm`], ['Vias', stats.vias],
                ].map(([k, v]) => (
                  <div key={k as string} className="bg-background p-2.5">
                    <div className="label-mono !text-[9.5px]">{k}</div>
                    <div className="mt-1 font-mono text-[11.5px]">{v}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">Select a part on the board or in the library.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <Verification />
    </aside>
  )
}

function Verification() {
  const v = useStudio((s) => s.verification)
  const run = async () => {
    setStudio({ verification: { status: 'running', theorems: [] } })
    try {
      const loader = verifyModules['./verify/verify.ts']
      if (!loader) throw new Error('Lean verifier not installed')
      const mod = (await loader()) as { verifyBoard: (b: Board) => Promise<Studio['verification']> }
      setStudio({ verification: await mod.verifyBoard(getStudio().board) })
    } catch (e) {
      setStudio({ verification: { status: 'failed', theorems: [], log: e instanceof Error ? e.message : String(e) } })
    }
  }
  const passed = v.theorems.filter((t) => t.ok).length
  return (
    <div className="border-t border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4" />
          <span className="text-sm font-medium">Lean proofs</span>
        </div>
        <Button size="sm" variant="secondary" onClick={run} disabled={v.status === 'running'}>
          {v.status === 'running' ? <Loader2 className="size-3.5 animate-spin" /> : 'Verify'}
        </Button>
      </div>
      {v.theorems.length > 0 && (
        <>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-secondary">
            <motion.div
              className="h-full bg-foreground"
              initial={{ width: 0 }}
              animate={{ width: `${(passed / v.theorems.length) * 100}%` }}
              transition={{ duration: 0.8, ease }}
            />
          </div>
          <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto">
            {v.theorems.map((t, i) => (
              <motion.li
                key={t.name}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04, ease }}
                title={t.statement}
                className="flex items-center gap-2 font-mono text-[11px]"
              >
                {t.ok ? <Check className="size-3" /> : <X className="size-3 text-red-300" />}
                <span className={t.ok ? '' : 'text-red-300'}>{t.name}</span>
              </motion.li>
            ))}
          </ul>
        </>
      )}
      {v.status === 'idle' && <p className="mt-2 text-xs text-muted-foreground">Prove clearances, connectivity, power and thermal limits.</p>}
      {v.status === 'failed' && v.log && <p className="mt-2 line-clamp-3 font-mono text-[11px] text-red-300">{v.log}</p>}
    </div>
  )
}

type Studio = ReturnType<typeof getStudio>

function StatusBar() {
  const board = useStudio((s) => s.board)
  const hovered = useStudio((s) => s.hovered)
  const stats = useBoardStats(board)
  const v = useStudio((s) => s.verification)
  return (
    <footer className="label-mono flex h-7 shrink-0 items-center gap-4 border-t border-border px-3 !text-[10px]">
      <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-foreground" /> Ready</span>
      <span className="tabular">{board.parts.length} parts</span>
      <span className="tabular">{board.nets.length} nets</span>
      <span className="tabular">BOM ${stats.cost.toFixed(2)}</span>
      <span>{v.status === 'passed' ? 'Proofs ✓' : v.status === 'failed' ? 'Proofs ✗' : 'Unverified'}</span>
      <span className="ml-auto flex items-center gap-1.5"><Cpu className="size-3" /> {hovered ?? 'Hover a part'}</span>
    </footer>
  )
}

export default function App() {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === 'e') setStudio((s) => ({ exploded: !s.exploded, touring: false }))
      if (e.key === 't') setStudio((s) => ({ touring: !s.touring }))
      if (e.key === 'f') { setStudio({ touring: false }); requestFit() }
      if (e.key === 'Escape') setStudio({ selected: null, touring: false })
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Library />
          <motion.main
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.2, ease }}
            className="relative min-w-0 flex-1"
          >
            <PcbScene />
            <Prompt />
            <Toolbar />
          </motion.main>
          <Inspector />
        </div>
        <StatusBar />
      </div>
    </TooltipProvider>
  )
}
