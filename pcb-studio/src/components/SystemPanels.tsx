// UI for the system scale: scale switch, collapsible assembly list,
// contextual component inspector with truthful electrical checks, alternatives,
// live Buy parts (Shop.dev), and Parts & cost breakdown.
import { memo, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Check, CheckCircle2, CircuitBoard,
  ExternalLink, HelpCircle, Loader2, PanelLeftClose, Repeat2, Search, ShoppingBag,
  X, ZoomIn,
} from 'lucide-react'
import { byId } from '@/data/catalog'
import {
  alternativesFor, analyzeDevice, analyzeSystem, modelFidelity, unitPrice,
  type CheckSeverity, type SystemDevice,
} from '@/data/system'
import {
  commitSystemSwap, computeBoardBomCost, computeSystemDevicesCost, getStudio, setStudio,
  useStudio, type Scale, type ShopSearchEntry,
} from '@/state/studio'
import { BUS_COLOR } from '@/scene/System'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const ease = [0.16, 1, 0.3, 1] as const
const usd = (n: number) => `$${n.toFixed(2)}`

/** Ask for a scale change; the 3D views animate the camera, the veil swaps the scene. */
export function goScale(scale: Scale) {
  const s = getStudio()
  if (s.mode !== 'engineer') return setStudio({ mode: 'engineer', scale })
  if (s.scale === scale) return
  if (scale === 'board') window.dispatchEvent(new Event('forge:dive'))
  else window.dispatchEvent(new CustomEvent('forge:scale', { detail: 'system' }))
}

export function ScaleSwitch() {
  const scale = useStudio((s) => s.scale)
  const mode = useStudio((s) => s.mode)
  const opts: { id: Scale | 'research'; label: string; tip: string }[] = [
    { id: 'research', label: 'Research', tip: 'Brief & component research' },
    { id: 'system', label: 'System', tip: 'Full hardware assembly & swaps' },
    { id: 'board', label: 'Board', tip: 'Custom PCB layout & design checks' },
  ]
  const active = mode === 'research' ? 'research' : scale
  return (
    <div className="relative flex rounded-lg border border-border bg-secondary/60 p-0.5" role="tablist" aria-label="Workspace view">
      {opts.map((o) => (
        <Tip key={o.id} label={o.tip}>
          <button
            role="tab"
            aria-selected={active === o.id}
            onClick={() => (o.id === 'research' ? setStudio({ mode: 'research' }) : goScale(o.id))}
            className="label-mono relative px-3 py-1 !text-[10px]"
          >
            {active === o.id && (
              <motion.span layoutId="scale-pill" transition={{ duration: 0.35, ease }} className="absolute inset-0 rounded-md bg-foreground" />
            )}
            <span className={cn('relative', active === o.id ? 'text-background' : 'text-muted-foreground')}>{o.label}</span>
          </button>
        </Tip>
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
      // Clear stale selection before swapping the scene.
      setStudio({ selected: null, device: null, hovered: null, hoveredDevice: null })
      setTimeout(() => setStudio({ scale: next, exploded: false }), 240)
      setTimeout(() => {
        setTo(null)
        busy = false
      }, 560)
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
          exit={{ opacity: 0, transition: { duration: 0.4, ease } }}
          transition={{ duration: 0.22, ease }}
          className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-background/95 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: to === 'board' ? 0.94 : 1.06, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.35, ease }}
            className="text-center"
          >
            <div className="label-mono">{to === 'board' ? 'Opening circuit board' : 'Returning to assembly'}</div>
            <div className="mt-1 text-lg font-semibold tracking-tight">{to === 'board' ? board.name : sys.name}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const SeverityDot = ({ severity }: { severity: CheckSeverity }) => {
  if (severity === 'warning') return <span className="inline-block size-2 shrink-0 rounded-full bg-amber-400" title="Needs review" />
  if (severity === 'unverified') return <span className="inline-block size-2 shrink-0 rounded-full bg-zinc-400" title="Needs verification" />
  return <span className="inline-block size-2 shrink-0 rounded-full bg-emerald-400/85" title="Compatible" />
}

const AssemblyRow = memo(function AssemblyRow({
  id,
  title,
  sub,
  severity,
  selected,
  hovered,
  price,
}: {
  id: string
  title: string
  sub: string
  severity: CheckSeverity
  selected: boolean
  hovered: boolean
  price?: string
}) {
  return (
    <button
      onClick={() => setStudio({ device: id, systemTab: 'inspect', touring: false })}
      onMouseEnter={() => setStudio({ hoveredDevice: id })}
      onMouseLeave={() => setStudio({ hoveredDevice: null })}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs transition-colors',
        selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        hovered && !selected && 'bg-accent/55',
      )}
    >
      {selected && (
        <motion.span layoutId="sys-sel" transition={{ duration: 0.3, ease }} className="absolute inset-0 rounded-md bg-accent" />
      )}
      <span className="relative">
        <SeverityDot severity={severity} />
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
      {price && <span className="relative shrink-0 font-mono text-[10.5px] text-muted-foreground tabular">{price}</span>}
    </button>
  )
})

export function SystemLibrary() {
  const sys = useStudio((s) => s.system)
  const board = useStudio((s) => s.board)
  const device = useStudio((s) => s.device)
  const hovered = useStudio((s) => s.hoveredDevice)
  const open = useStudio((s) => s.leftPanelOpen)
  const [q, setQ] = useState('')

  const health = useMemo(() => analyzeSystem(sys, board), [sys, board])
  const rows = useMemo(
    () =>
      sys.devices.filter((d) => {
        const item = byId[d.catalogId]
        return !q || `${d.label} ${item.name} ${d.role} ${item.mpn} ${d.port}`.toLowerCase().includes(q.toLowerCase())
      }),
    [sys.devices, q],
  )

  if (!open) return null

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border max-lg:hidden" aria-label="Device components">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="label-mono">Components</span>
        <div className="flex items-center gap-1.5">
          <span className="label-mono tabular">{sys.devices.length + 1}</span>
          <Tip label="Hide component list">
            <Button size="icon-sm" variant="ghost" className="size-6" onClick={() => setStudio({ leftPanelOpen: false })} aria-label="Hide component list">
              <PanelLeftClose className="size-3.5" />
            </Button>
          </Tip>
        </div>
      </div>

      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute left-5.5 top-2 size-3.5 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter components" className="h-8 pl-8 text-xs" />
      </div>

      {health.warningCount > 0 && (
        <button
          onClick={() => setStudio({ device: health.issues[0].deviceId, systemTab: 'inspect', touring: false })}
          className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-2.5 py-1.5 text-left text-[11px] text-amber-200 transition-colors hover:bg-amber-500/15"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
          <span className="truncate">{health.warningCount} electrical {health.warningCount === 1 ? 'item needs' : 'items need'} review</span>
        </button>
      )}

      <div className="flex-1 overflow-y-auto px-1.5 pb-3">
        <div className="label-mono mt-1 px-2.5 py-1">Controller Board</div>
        <AssemblyRow
          id="pcb"
          title={board.name}
          sub={`${board.width}×${board.height} mm · ${board.parts.length} parts`}
          severity={getStudio().verification.status === 'passed' ? 'ok' : getStudio().verification.status === 'failed' ? 'warning' : 'unverified'}
          selected={device === 'pcb'}
          hovered={hovered === 'pcb'}
        />

        <div className="label-mono mt-3 px-2.5 py-1">Connected Hardware</div>
        {rows.map((d) => {
          const item = byId[d.catalogId]
          const check = health.checksByDevice[d.id]
          return (
            <AssemblyRow
              key={d.id}
              id={d.id}
              title={d.label}
              sub={item.name}
              severity={check?.severity ?? 'unverified'}
              selected={device === d.id}
              hovered={hovered === d.id}
              price={usd(unitPrice(item))}
            />
          )
        })}
      </div>
    </aside>
  )
}

async function searchShopForPart(mpn: string, name: string, manufacturer: string): Promise<ShopSearchEntry> {
  const res = await fetch('/api/shop/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mpn, name, manufacturer }),
  })
  const data = (await res.json()) as ShopSearchEntry
  setStudio((s) => ({ shopByMpn: { ...s.shopByMpn, [mpn]: data } }))
  return data
}

function CompatibilityBanner({
  severity,
  headline,
  explanation,
  technicalDetail,
  actionLabel,
  onAction,
}: {
  severity: CheckSeverity
  headline: string
  explanation: string
  technicalDetail: string
  actionLabel?: string
  onAction?: () => void
}) {
  const tone =
    severity === 'warning'
      ? 'border-amber-400/35 bg-amber-500/10 text-amber-100'
      : severity === 'unverified'
      ? 'border-border bg-muted/50 text-foreground'
      : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'

  const Icon = severity === 'warning' ? AlertTriangle : severity === 'unverified' ? HelpCircle : CheckCircle2
  const iconCls = severity === 'warning' ? 'text-amber-400' : severity === 'unverified' ? 'text-muted-foreground' : 'text-emerald-400'

  return (
    <div className={cn('mt-3 rounded-lg border p-3 text-xs', tone)}>
      <div className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 size-4 shrink-0', iconCls)} />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug">{headline}</div>
          <p className="mt-1 text-[11.5px] leading-relaxed opacity-85">{explanation}</p>
          {actionLabel && onAction && (
            <Button size="sm" variant="secondary" className="mt-2 h-7 text-[11px]" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
          <details className="mt-2 text-[10.5px] opacity-80">
            <summary className="cursor-pointer font-mono hover:opacity-100">Technical details</summary>
            <p className="mt-1 font-mono leading-relaxed">{technicalDetail}</p>
          </details>
        </div>
      </div>
    </div>
  )
}

function DeviceDetail({ dev }: { dev: SystemDevice }) {
  const sys = useStudio((s) => s.system)
  const board = useStudio((s) => s.board)
  const item = byId[dev.catalogId]
  const check = useMemo(() => analyzeDevice(dev, board), [dev, board])
  const alts = useMemo(() => alternativesFor(dev, board), [dev, board])
  const fidelity = useMemo(() => modelFidelity(item), [item])
  const matchingCount = useMemo(
    () => sys.devices.filter((d) => d.bus === dev.bus && d.catalogId === dev.catalogId).length,
    [sys.devices, dev.bus, dev.catalogId],
  )
  const [searching, setSearching] = useState(false)
  const shopEntry = useStudio((s) => s.shopByMpn[item.mpn])
  const selectedOffer = useStudio((s) => s.selectedOfferByMpn[item.mpn])

  const suggestedAlt = check.suggestedCatalogId ? alts.find((a) => a.item.id === check.suggestedCatalogId) : undefined

  const runBuySearch = async () => {
    setSearching(true)
    try {
      await searchShopForPart(item.mpn, item.name, item.manufacturer)
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="label-mono">{dev.role}</div>
          <h2 className="mt-0.5 text-base font-semibold leading-tight tracking-tight">{dev.label}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{item.name}</p>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => setStudio({ device: null })} aria-label="Close inspector">
          <X className="size-3.5" />
        </Button>
      </div>

      <CompatibilityBanner
        severity={check.severity}
        headline={check.headline}
        explanation={check.explanation}
        technicalDetail={check.technicalDetail}
        actionLabel={
          suggestedAlt
            ? matchingCount > 1
              ? `Switch all ${matchingCount} to ${suggestedAlt.item.name.split(' ')[0]}`
              : `Switch to ${suggestedAlt.item.name}`
            : check.severity === 'warning' ? 'Review board wiring' : undefined
        }
        onAction={
          suggestedAlt
            ? () => commitSystemSwap(dev.id, suggestedAlt.item.id, { applyToMatching: matchingCount > 1 })
            : check.severity === 'warning' ? () => goScale('board') : undefined
        }
      />

      {fidelity.kind === 'proxy' && (
        <details className="mt-2 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">3D model details</summary>
          <p className="mt-1">{fidelity.note}</p>
        </details>
      )}

      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {[
          ['Unit price', usd(selectedOffer?.priceUsd ?? unitPrice(item))],
          ['Rated voltage', `${item.voltage.min}–${item.voltage.max} V`],
          ['Typical draw', `${item.currentMa} mA`],
          ['Dimensions', `${item.dimensions.w}×${item.dimensions.h} mm`],
        ].map(([k, v]) => (
          <div key={k} className="bg-card px-2.5 py-2">
            <div className="label-mono !text-[9px]">{k}</div>
            <div className="tabular mt-0.5 truncate font-mono text-[11.5px]">{v}</div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between">
        <span className="label-mono">Replacement options</span>
        <span className="label-mono tabular">{alts.length}</span>
      </div>

      <div className="mt-2 space-y-2">
        {alts.map((a) => (
          <div
            key={a.item.id}
            className={cn(
              'rounded-lg border px-3 py-2.5 transition-colors',
              a.current ? 'border-foreground/40 bg-accent/45' : 'border-border hover:border-foreground/30',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <SeverityDot severity={a.severity} />
                  <span className="leading-snug">{a.item.name}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground tabular">
                  <span>{usd(a.price)}</span>
                  {!a.current && (
                    <span className={cn('inline-flex items-center', a.delta < 0 ? 'text-emerald-400' : 'text-muted-foreground')}>
                      {a.delta < 0 ? <ArrowDownRight className="size-3" /> : <ArrowUpRight className="size-3" />}
                      {a.delta < 0 ? 'Save ' : 'Adds '}{usd(Math.abs(a.delta))} / part
                    </span>
                  )}
                  <span>· {a.item.voltage.min}–{a.item.voltage.max} V</span>
                  {!a.current && a.currentDelta !== 0 && (
                    <span>· {a.currentDelta > 0 ? '+' : '−'}{Math.abs(a.currentDelta)} mA</span>
                  )}
                </div>
              </div>
              {a.current && (
                <span className="label-mono flex shrink-0 items-center gap-1 !text-[9px] !text-foreground">
                  <Check className="size-3" /> Active
                </span>
              )}
            </div>

            {a.warnings.length > 0 && (
              <p className="mt-1.5 text-[11px] text-amber-300/90">{a.warnings.join(' · ')}</p>
            )}
            {!a.warnings.length && !a.current && a.reasons.length > 0 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">{a.reasons[a.reasons.length - 1]}</p>
            )}

            {!a.current && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="secondary" className="h-6 px-2.5 text-[11px]" onClick={() => commitSystemSwap(dev.id, a.item.id)}>
                  <Repeat2 className="size-3" /> Replace one
                </Button>
                {matchingCount > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2.5 text-[11px]"
                    onClick={() => commitSystemSwap(dev.id, a.item.id, { applyToMatching: true })}
                  >
                    Replace all {matchingCount} ({a.delta >= 0 ? '+' : '−'}{usd(Math.abs(a.delta * matchingCount))})
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Progressive disclosure: Buy parts (Shop.dev) */}
      <div className="mt-5 border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="label-mono">Buy parts</div>
            <div className="text-[11px] text-muted-foreground">Live merchant pricing</div>
          </div>
          <Button size="sm" variant="secondary" onClick={runBuySearch} disabled={searching}>
            {searching ? <Loader2 className="size-3.5 animate-spin" /> : <ShoppingBag className="size-3.5" />}
            Find sellers
          </Button>
        </div>

        {shopEntry && (
          <div className="mt-2.5 space-y-1.5 text-xs">
            {shopEntry.status === 'no_results' && (
              <div className="rounded-md border border-dashed border-border p-2.5 text-[11px] text-muted-foreground">
                No matching merchant listings found for {item.name}. Curated reference price ({usd(unitPrice(item))}) remains active.
              </div>
            )}
            {shopEntry.status === 'error' && (
              <div className="text-[11px] text-red-300">{shopEntry.error}</div>
            )}
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
                              ? Object.fromEntries(Object.entries(s.selectedOfferByMpn).filter(([k]) => k !== item.mpn))
                              : { ...s.selectedOfferByMpn, [item.mpn]: o },
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

      {/* Progressive disclosure: Technical metadata */}
      <details className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer font-mono hover:text-foreground">Technical details</summary>
        <div className="mt-2 space-y-1 font-mono text-[10.5px]">
          <div>Part number: {item.manufacturer} {item.mpn}</div>
          <div>Connector: {dev.port} ({dev.bus.toUpperCase()} bus · {dev.rail} V rail)</div>
          <div>Position: ({dev.x}, {dev.y}, {dev.z}) mm · Rot {dev.rot}°</div>
          <div>Interfaces: {item.interfaces.join(', ') || 'power only'}</div>
          <div>3D model: {fidelity.note}</div>
          <p className="pt-1 font-sans text-[11px] leading-relaxed">{item.description}</p>
        </div>
      </details>
    </div>
  )
}

function PcbDetail() {
  const board = useStudio((s) => s.board)
  const v = useStudio((s) => s.verification)
  const passed = v.theorems.filter((t) => t.ok).length
  return (
    <div className="p-4">
      <div className="label-mono">Controller Circuit Board</div>
      <h2 className="mt-1 text-base font-semibold tracking-tight">{board.name}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {board.width}×{board.height} mm · {board.parts.length} components · Rev {board.revision}
      </p>
      <div className="mt-3 rounded-lg border border-border bg-card p-3 text-xs">
        <div className="font-medium">
          {v.status === 'passed'
            ? 'Board design checks passed'
            : v.status === 'failed'
            ? `${v.theorems.length - passed} board layout issue(s) need attention`
            : 'Board layout checks not run yet'}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Open the board view to inspect traces, move parts, run formal design checks, or fix issues with AI.
        </p>
      </div>
      <Button className="mt-4 w-full" onClick={() => goScale('board')}>
        <ZoomIn className="size-4" /> Open circuit board
      </Button>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">or scroll into the PCB in 3D</p>
    </div>
  )
}

function SystemOverview() {
  const sys = useStudio((s) => s.system)
  const board = useStudio((s) => s.board)
  const selectedOffers = useStudio((s) => s.selectedOfferByMpn)
  const health = useMemo(() => analyzeSystem(sys, board), [sys, board])
  const devCost = useMemo(() => computeSystemDevicesCost(sys, selectedOffers).totalUsd, [sys, selectedOffers])
  const pcbCost = useMemo(() => computeBoardBomCost(board, selectedOffers).totalUsd, [board, selectedOffers])
  const total = devCost + pcbCost
  const current = sys.devices.reduce((a, d) => a + byId[d.catalogId].currentMa, 0)

  const byCategory = useMemo(() => {
    const groups: Record<string, { label: string; cost: number; color: string }> = {
      motor: { label: 'Drive motors', cost: 0, color: BUS_COLOR.motor },
      i2c: { label: 'Sensors & screen', cost: 0, color: BUS_COLOR.i2c },
      data: { label: 'Lighting', cost: 0, color: BUS_COLOR.data },
      gpio: { label: 'Range finder', cost: 0, color: BUS_COLOR.gpio },
      power: { label: 'Power', cost: 0, color: BUS_COLOR.power },
      pcb: { label: 'Controller PCB', cost: pcbCost, color: '#ffffff' },
    }
    for (const d of sys.devices) {
      groups[d.bus].cost += unitPrice(byId[d.catalogId])
    }
    return Object.values(groups).filter((g) => g.cost > 0).sort((a, b) => b.cost - a.cost)
  }, [sys.devices, pcbCost])

  return (
    <div className="p-4">
      <div className="label-mono">Hardware Assembly</div>
      <h2 className="mt-1 text-base font-semibold tracking-tight">{sys.name}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {sys.chassis.w}×{sys.chassis.d} mm rover · {sys.devices.length} connected modules
      </p>

      <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {[
          ['Est. parts', usd(total)],
          ['Est. draw', `${(current / 1000).toFixed(2)} A`],
          ['Checks', health.warningCount > 0 ? `${health.warningCount} review` : 'OK'],
        ].map(([k, v]) => (
          <div key={k} className="bg-card px-2.5 py-2">
            <div className="label-mono !text-[9px]">{k}</div>
            <div className={cn('tabular mt-0.5 font-mono text-[11.5px]', k === 'Checks' && health.warningCount > 0 && 'text-amber-300')}>{v}</div>
          </div>
        ))}
      </div>

      {health.issues.length > 0 && (
        <div className="mt-4">
          <div className="label-mono">Needs attention</div>
          <div className="mt-2 space-y-1.5">
            {health.issues.slice(0, 4).map((issue) => (
              <button
                key={issue.deviceId}
                onClick={() => setStudio({ device: issue.deviceId, touring: false })}
                className="flex w-full items-start gap-2 rounded-lg border border-border bg-card/80 px-2.5 py-2 text-left text-xs transition-colors hover:border-foreground/30"
              >
                <SeverityDot severity={issue.severity} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">{issue.deviceLabel}</span>
                  <span className="block text-[11px] text-muted-foreground">{issue.headline}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="label-mono mt-5">Cost breakdown</div>
      <div className="mt-2 space-y-1.5">
        {byCategory.map((row) => (
          <div key={row.label} className="flex items-center gap-2 text-[11px]">
            <span className="w-24 truncate text-muted-foreground">{row.label}</span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full" style={{ width: `${(row.cost / Math.max(total, 0.01)) * 100}%`, background: row.color }} />
            </div>
            <span className="tabular w-12 text-right font-mono">{usd(row.cost)}</span>
          </div>
        ))}
      </div>

      <button
        onClick={() => goScale('board')}
        className="mt-5 flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-left text-xs transition-colors hover:border-foreground/30 hover:bg-accent/40"
      >
        <CircuitBoard className="size-4" />
        <span className="flex-1 font-medium">Inspect circuit board</span>
        <ZoomIn className="size-3.5 text-muted-foreground" />
      </button>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Click any component on the rover to inspect specs, check power compatibility, or swap alternatives.
      </p>
    </div>
  )
}

function SystemPartsAndBuyTab() {
  const sys = useStudio((s) => s.system)
  const board = useStudio((s) => s.board)
  const budgetUsd = useStudio((s) => s.budgetUsd)
  const shopByMpn = useStudio((s) => s.shopByMpn)
  const selectedOfferByMpn = useStudio((s) => s.selectedOfferByMpn)
  const [searchingAll, setSearchingAll] = useState(false)

  const grouped = useMemo(() => {
    const map = new Map<string, { id: string; label: string; mpn: string; name: string; manufacturer: string; qty: number; unit: number }>()
    for (const d of sys.devices) {
      const item = byId[d.catalogId]
      const cur = map.get(item.mpn) ?? {
        id: d.id,
        label: d.label,
        mpn: item.mpn,
        name: item.name,
        manufacturer: item.manufacturer,
        qty: 0,
        unit: unitPrice(item),
      }
      cur.qty++
      map.set(item.mpn, cur)
    }
    return [...map.values()]
  }, [sys.devices])

  const devCost = useMemo(() => computeSystemDevicesCost(sys, selectedOfferByMpn).totalUsd, [sys, selectedOfferByMpn])
  const pcbCost = useMemo(() => computeBoardBomCost(board, selectedOfferByMpn).totalUsd, [board, selectedOfferByMpn])
  const combined = devCost + pcbCost

  const runSearchAll = async () => {
    setSearchingAll(true)
    try {
      await Promise.all(grouped.slice(0, 5).map((g) => searchShopForPart(g.mpn, g.name, g.manufacturer)))
    } finally {
      setSearchingAll(false)
    }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="label-mono">Total known parts</div>
          <div className="mt-0.5 font-mono text-xl font-medium tabular">{usd(combined)}</div>
          <div className="text-[11px] text-muted-foreground tabular">
            Devices {usd(devCost)} · PCB {usd(pcbCost)}
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={runSearchAll} disabled={searchingAll}>
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
            combined > budgetUsd ? 'border-amber-400/40 bg-amber-500/10 text-amber-200' : 'border-border text-muted-foreground',
          )}
        >
          {combined > budgetUsd
            ? `Over budget by ${usd(combined - budgetUsd)}`
            : `${usd(budgetUsd - combined)} remaining under ${usd(budgetUsd)}`}
        </div>
      )}

      <div className="space-y-1.5">
        {grouped.map((g) => {
          const offer = selectedOfferByMpn[g.mpn]
          const shop = shopByMpn[g.mpn]
          const bestExactUsd = shop?.offers.find((o) => o.matchKind === 'exact_match' && o.available && o.priceUsd != null)
          const unit = offer?.priceUsd ?? g.unit
          return (
            <div key={g.mpn} className="rounded-md border border-border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <button
                  onClick={() => setStudio({ device: g.id, systemTab: 'inspect', touring: false })}
                  className="truncate text-left font-medium hover:underline"
                >
                  {g.name}
                </button>
                <span className="shrink-0 font-mono text-[11.5px] tabular">{usd(unit * g.qty)}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-muted-foreground">
                <span>Qty ×{g.qty} · {offer ? offer.sellerName : `${usd(g.unit)}/ea ref`}</span>
                {shop && shop.status === 'no_results' && <span>No live listing</span>}
              </div>
              {bestExactUsd && !offer && (
                <div className="mt-1.5 flex items-center justify-between border-t border-border/60 pt-1 text-[10.5px]">
                  <span className="truncate text-muted-foreground">
                    Live: {bestExactUsd.formattedPrice} · {bestExactUsd.sellerName}
                  </span>
                  <button
                    onClick={() =>
                      setStudio((s) => ({
                        selectedOfferByMpn: { ...s.selectedOfferByMpn, [g.mpn]: bestExactUsd },
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
        Shows known component reference prices and live merchant offers (via Shop.dev). Chassis machining, PCB fab, shipping, and tax are excluded.
      </p>
    </div>
  )
}

export function SystemInspector() {
  const sys = useStudio((s) => s.system)
  const device = useStudio((s) => s.device)
  const tab = useStudio((s) => s.systemTab)
  const dev = sys.devices.find((d) => d.id === device)
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border max-md:hidden" aria-label="Component inspector">
      <Tabs
        value={tab}
        onValueChange={(v) => setStudio({ systemTab: v as 'inspect' | 'bom' })}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="border-b border-border px-3 py-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="inspect">{dev ? dev.label : device === 'pcb' ? 'Board' : 'Overview'}</TabsTrigger>
            <TabsTrigger value="bom">Parts &amp; cost</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="inspect" className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={dev ? dev.id + dev.catalogId : device ?? 'overview'}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.22, ease }}
            >
              {dev ? <DeviceDetail dev={dev} /> : device === 'pcb' ? <PcbDetail /> : <SystemOverview />}
            </motion.div>
          </AnimatePresence>
        </TabsContent>

        <TabsContent value="bom" className="min-h-0 flex-1 overflow-y-auto">
          <SystemPartsAndBuyTab />
        </TabsContent>
      </Tabs>
    </aside>
  )
}
