// UI for the system scale: scale switch, device library, device inspector with
// compatible alternatives + cost comparison, and the scale transition veil.
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowDownRight, ArrowUpRight, Check, CircuitBoard, Repeat2, Search, TriangleAlert, ZoomIn } from 'lucide-react'
import { byId } from '@/data/catalog'
import { alternativesFor, systemCost, unitPrice, BUS_COLOR, type SystemDevice } from '@/data/system'
import { getStudio, setStudio, useStudio, goScale, type Scale } from '@/state/studio'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const ease = [0.16, 1, 0.3, 1] as const
const usd = (n: number) => `$${n.toFixed(2)}`

export function ScaleSwitch() {
  const scale = useStudio((s) => s.scale)
  const mode = useStudio((s) => s.mode)
  const opts: { id: Scale | 'research'; label: string }[] = [
    { id: 'research', label: 'Research' },
    { id: 'system', label: 'System' },
    { id: 'board', label: 'Board' },
  ]
  const active = mode === 'research' ? 'research' : scale
  return (
    <div className="relative flex rounded-lg border border-border bg-secondary/60 p-0.5">
      {opts.map((o) => (
        <button key={o.id} onClick={() => (o.id === 'research' ? setStudio({ mode: 'research' }) : goScale(o.id))} className="label-mono relative px-3 py-1 !text-[10px]">
          {active === o.id && <motion.span layoutId="scale-pill" transition={{ duration: 0.4, ease }} className="absolute inset-0 rounded-md bg-foreground" />}
          <span className={cn('relative', active === o.id ? 'text-background' : 'text-muted-foreground')}>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/** Full-canvas veil that hides the scene swap and names where you are going. */
export function ScaleTransition() {
  const [to, setTo] = useState<Scale | null>(null)
  const board = useStudio((s) => s.board)
  const sys = useStudio((s) => s.system)
  useEffect(() => {
    let busy = false
    const on = (e: Event) => {
      const next = (e as CustomEvent<Scale>).detail
      if (busy || getStudio().scale === next) return
      busy = true
      setTo(next)
      setTimeout(() => setStudio({ scale: next, selected: null, device: null, hovered: null, hoveredDevice: null, exploded: false }), 260)
      setTimeout(() => {
        setTo(null)
        busy = false
      }, 620)
    }
    window.addEventListener('forge:scale', on)
    return () => window.removeEventListener('forge:scale', on)
  }, [])
  return (
    <AnimatePresence>
      {to && (
        <motion.div
          key={to}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.5, ease } }}
          transition={{ duration: 0.24, ease }}
          className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-background/95 backdrop-blur-sm"
        >
          <motion.div initial={{ scale: to === 'board' ? 0.94 : 1.06, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.4, ease }} className="text-center">
            <div className="label-mono">{to === 'board' ? 'Zoom in · Board' : 'Zoom out · System'}</div>
            <div className="mt-1 text-lg font-semibold tracking-tight">{to === 'board' ? board.name : sys.name}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function AssemblyRow({
  id,
  n,
  title,
  sub,
  dot,
  device,
  hovered,
}: {
  id: string
  n: string
  title: string
  sub: string
  dot: string
  device: string | null
  hovered: string | null
}) {
  return (
    <button
      onClick={() => setStudio({ device: id, touring: false })}
      onMouseEnter={() => setStudio({ hoveredDevice: id })}
      onMouseLeave={() => setStudio({ hoveredDevice: null })}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
        device === id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        hovered === id && device !== id && 'bg-accent/60',
      )}
    >
      {device === id && <motion.span layoutId="sys-sel" transition={{ duration: 0.35, ease }} className="absolute inset-0 rounded-md bg-accent" />}
      <span className="relative w-5 font-mono text-[10px] text-muted-foreground">{n}</span>
      <span className="relative size-1.5 shrink-0 rounded-full" style={{ background: dot }} />
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-foreground">{title}</span>
        <span className="block truncate text-[11px]">{sub}</span>
      </span>
    </button>
  )
}

export function SystemLibrary() {
  const sys = useStudio((s) => s.system)
  const device = useStudio((s) => s.device)
  const hovered = useStudio((s) => s.hoveredDevice)
  const board = useStudio((s) => s.board)
  const [q, setQ] = useState('')
  const rows = sys.devices.filter((d) => {
    const item = byId[d.catalogId]
    return !q || `${d.label} ${item.name} ${item.mpn} ${d.port}`.toLowerCase().includes(q.toLowerCase())
  })
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border max-lg:hidden">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="label-mono">Assembly</span>
        <span className="label-mono tabular">{sys.devices.length + 1}</span>
      </div>
      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute left-5.5 top-2 size-3.5 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search devices" className="h-8 pl-8 text-xs" />
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        <div className="label-mono mt-2 px-2 py-1">Custom PCB</div>
        <AssemblyRow id="pcb" n="00" title={board.name} sub={`${board.width}×${board.height} mm · ${board.parts.length} parts`} dot="#ffffff" device={device} hovered={hovered} />
        <div className="label-mono mt-3 px-2 py-1">Devices</div>
        {rows.map((d) => {
          const item = byId[d.catalogId]
          return <AssemblyRow key={d.id} id={d.id} n={String(sys.devices.indexOf(d) + 1).padStart(2, '0')} title={item.name} sub={`${d.label} · ${d.port}`} dot={BUS_COLOR[d.bus]} device={device} hovered={hovered} />
        })}
        <div className="label-mono mt-4 px-2 py-1">Buses</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 px-2 text-[11px] text-muted-foreground">
          {Object.entries(BUS_COLOR).map(([bus, c]) => (
            <span key={bus} className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-full" style={{ background: c }} /> {bus === 'i2c' ? 'I²C' : bus}
            </span>
          ))}
        </div>
      </div>
    </aside>
  )
}

function swap(dev: SystemDevice, catalogId: string) {
  setStudio((s) => ({
    system: { ...s.system, devices: s.system.devices.map((d) => (d.id === dev.id ? { ...d, catalogId } : d)) },
  }))
}

function DeviceDetail({ dev }: { dev: SystemDevice }) {
  const sys = useStudio((s) => s.system)
  const item = byId[dev.catalogId]
  const alts = useMemo(() => alternativesFor(dev), [dev])
  const max = Math.max(...alts.map((a) => a.price), 0.01)
  const total = systemCost(sys)
  const [preview, setPreview] = useState<string | null>(null)
  const pv = alts.find((a) => a.item.id === preview)
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="label-mono">{dev.label}</div>
          <h2 className="mt-1 text-base font-semibold leading-tight tracking-tight">{item.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{item.manufacturer} · {item.mpn}</p>
        </div>
        <Badge className="label-mono shrink-0 !text-foreground">{dev.port}</Badge>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{item.description}</p>
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {[
          ['Role', dev.role],
          ['Rail', `${dev.rail} V`],
          ['Supply', `${item.voltage.min}–${item.voltage.max} V`],
          ['Current', `${item.currentMa} mA`],
          ['Size', `${item.dimensions.w}×${item.dimensions.h} mm`],
          ['Unit', usd(unitPrice(item))],
        ].map(([k, v]) => (
          <div key={k} className="bg-card px-2.5 py-2">
            <div className="label-mono !text-[9px]">{k}</div>
            <div className="tabular mt-0.5 truncate">{v}</div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between">
        <span className="label-mono">Compatible devices</span>
        <span className="label-mono tabular">{alts.length}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {alts.map((a, i) => (
          <motion.div
            key={a.item.id}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.04, duration: 0.35, ease }}
            onMouseEnter={() => setPreview(a.item.id)}
            onMouseLeave={() => setPreview(null)}
            className={cn('group rounded-lg border px-2.5 py-2 transition-colors', a.current ? 'border-foreground/40 bg-accent/50' : 'border-border hover:border-foreground/30')}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="truncate">{a.item.name}</span>
                  {a.warnings.length > 0 && <TriangleAlert className="size-3 shrink-0 text-amber-400" />}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">{a.item.manufacturer} · {a.item.interfaces.join(' / ').toUpperCase()}</div>
              </div>
              {a.current ? (
                <span className="label-mono flex items-center gap-1 !text-[9px] !text-foreground"><Check className="size-3" /> In use</span>
              ) : (
                <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px] opacity-70 group-hover:opacity-100" onClick={() => swap(dev, a.item.id)}>
                  <Repeat2 className="size-3" /> Swap
                </Button>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${(a.price / max) * 100}%` }}
                  transition={{ delay: 0.1 + i * 0.04, duration: 0.6, ease }}
                  className={cn('h-full rounded-full', a.current ? 'bg-foreground' : 'bg-muted-foreground/70')}
                />
              </div>
              <span className="tabular w-12 text-right text-[11px]">{usd(a.price)}</span>
              <span className={cn('tabular flex w-14 items-center justify-end gap-0.5 text-[11px]', a.delta < 0 ? 'text-emerald-400' : a.delta > 0 ? 'text-muted-foreground' : 'text-muted-foreground/50')}>
                {a.current ? '—' : (<>{a.delta < 0 ? <ArrowDownRight className="size-3" /> : <ArrowUpRight className="size-3" />}{usd(Math.abs(a.delta))}</>)}
              </span>
            </div>
          </motion.div>
        ))}
      </div>
      <AnimatePresence>
        {pv && !pv.current && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease }}
            className="mt-3 rounded-lg border border-border bg-card p-3 text-[11px]"
          >
            <div className="label-mono">If swapped</div>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              <div><div className="text-muted-foreground">System</div><div className="tabular">{usd(total + pv.delta)}</div></div>
              <div><div className="text-muted-foreground">Δ cost</div><div className="tabular">{pv.delta >= 0 ? '+' : '−'}{usd(Math.abs(pv.delta))}</div></div>
              <div><div className="text-muted-foreground">Δ current</div><div className="tabular">{pv.currentDelta >= 0 ? '+' : '−'}{Math.abs(pv.currentDelta)} mA</div></div>
            </div>
            {[...pv.reasons, ...pv.warnings].map((r, i) => (
              <div key={r} className={cn('mt-1 flex items-center gap-1.5', i >= pv.reasons.length ? 'text-amber-400' : 'text-muted-foreground')}>
                {i >= pv.reasons.length ? <TriangleAlert className="size-3" /> : <Check className="size-3" />} {r}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function PcbDetail() {
  const board = useStudio((s) => s.board)
  return (
    <div className="p-4">
      <div className="label-mono">Custom PCB</div>
      <h2 className="mt-1 text-base font-semibold tracking-tight">{board.name}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {board.width}×{board.height} mm · {board.parts.length} parts · {board.nets.length} nets · Rev {board.revision}
      </p>
      <Button className="mt-4 w-full" onClick={() => goScale('board')}>
        <ZoomIn className="size-4" /> Open board
      </Button>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">or scroll into the PCB</p>
    </div>
  )
}

function SystemOverview() {
  const sys = useStudio((s) => s.system)
  const board = useStudio((s) => s.board)
  const total = systemCost(sys)
  const current = sys.devices.reduce((a, d) => a + byId[d.catalogId].currentMa, 0)
  const byBus = sys.devices.reduce<Record<string, number>>((m, d) => ((m[d.bus] = (m[d.bus] ?? 0) + unitPrice(byId[d.catalogId])), m), {})
  return (
    <div className="p-4">
      <div className="label-mono">System</div>
      <h2 className="mt-1 text-base font-semibold tracking-tight">{sys.name}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{sys.form === 'band' ? 'Band' : sys.form === 'none' ? 'Frame' : 'Chassis'} {sys.chassis.w}×{sys.chassis.d} mm · {sys.devices.length} devices on {board.name}</p>
      <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {[
          ['Devices', usd(total)],
          ['Peak draw', `${(current / 1000).toFixed(2)} A`],
          ['Buses', String(Object.keys(byBus).length)],
        ].map(([k, v]) => (
          <div key={k} className="bg-card px-2.5 py-2">
            <div className="label-mono !text-[9px]">{k}</div>
            <div className="tabular mt-0.5">{v}</div>
          </div>
        ))}
      </div>
      <div className="label-mono mt-5">Cost by bus</div>
      <div className="mt-2 space-y-1.5">
        {Object.entries(byBus).sort((a, b) => b[1] - a[1]).map(([bus, cost], i) => (
          <div key={bus} className="flex items-center gap-2 text-[11px]">
            <span className="w-12 text-muted-foreground">{bus === 'i2c' ? 'I²C' : bus}</span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
              <motion.div initial={{ width: 0 }} animate={{ width: `${(cost / total) * 100}%` }} transition={{ delay: i * 0.05, duration: 0.7, ease }} className="h-full rounded-full" style={{ background: BUS_COLOR[bus as keyof typeof BUS_COLOR] }} />
            </div>
            <span className="tabular w-12 text-right">{usd(cost)}</span>
          </div>
        ))}
      </div>
      <button onClick={() => setStudio({ device: 'pcb' })} className="mt-5 flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-left text-xs hover:border-foreground/30">
        <CircuitBoard className="size-4" />
        <span className="flex-1">Custom PCB · {board.name}</span>
        <ZoomIn className="size-3.5 text-muted-foreground" />
      </button>
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">Click a device to compare compatible replacements. Scroll into the PCB to open the board.</p>
    </div>
  )
}

export function SystemInspector() {
  const sys = useStudio((s) => s.system)
  const device = useStudio((s) => s.device)
  const dev = sys.devices.find((d) => d.id === device)
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border max-md:hidden">
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={dev ? dev.id + dev.catalogId : device ?? 'overview'}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.28, ease }}
          >
            {dev ? <DeviceDetail dev={dev} /> : device === 'pcb' ? <PcbDetail /> : <SystemOverview />}
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  )
}
