// UI for the system scale: scale switch, device library, device inspector with
// compatible alternatives + cost comparison, and the scale transition veil.
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowDownRight, ArrowUpRight, Check, CircuitBoard, ExternalLink, Loader2, Repeat2, Search, ShoppingBag, TriangleAlert, ZoomIn } from 'lucide-react'
import { byId } from '@/data/catalog'
import { alternativesFor, systemCost, unitPrice, BUS_COLOR, type SystemDevice } from '@/data/system'
import {
  computeBoardBomCost, computeSystemDevicesCost, getStudio, setStudio, useStudio, goScale,
  type Scale, type ShopSearchEntry,
} from '@/state/studio'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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

function DeviceDetail({ dev }: { dev: SystemDevice }) {
  const sys = useStudio((s) => s.system)
  const item = byId[dev.catalogId]
  const alts = useMemo(() => alternativesFor(dev), [dev])
  const max = Math.max(...alts.map((a) => a.price), 0.01)
  const total = systemCost(sys)
  const [preview, setPreview] = useState<string | null>(null)
  const pv = alts.find((a) => a.item.id === preview)
  const [searching, setSearching] = useState(false)
  const shopEntry = useStudio((s) => s.shopByMpn[item.mpn])
  const selectedOffer = useStudio((s) => s.selectedOfferByMpn[item.mpn])
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

// Shopify cart permalink: lands on the merchant's checkout with the items preloaded.
function checkoutUrl(storeUrl: string, lines: { variantId: string; qty: number }[]): string {
  const items = lines.map((l) => `${l.variantId.split('/').pop()}:${l.qty}`).join(',')
  return `${new URL(storeUrl).origin}/cart/${items}`
}

const linkCls =
  'inline-flex h-6 items-center gap-1 rounded border border-border px-2 font-mono text-[10px] text-muted-foreground hover:text-foreground'

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

  // The offer each row would buy: the one the user picked, else the best live exact match.
  const picks = grouped.flatMap((g) => {
    const o =
      selectedOfferByMpn[g.mpn] ??
      shopByMpn[g.mpn]?.offers.find((x) => x.matchKind === 'exact_match' && x.available && x.priceUsd != null)
    return o ? [{ offer: o, qty: g.qty }] : []
  })
  const openAllStores = () => {
    for (const p of picks) window.open(p.offer.url, '_blank', 'noopener,noreferrer')
  }
  const checkoutAll = () => {
    // One checkout per merchant, with all of that merchant's parts in the cart.
    const byStore = new Map<string, { url: string; lines: { variantId: string; qty: number }[] }>()
    for (const p of picks) {
      const origin = new URL(p.offer.url).origin
      const cur = byStore.get(origin) ?? { url: p.offer.url, lines: [] }
      cur.lines.push({ variantId: p.offer.variantId, qty: p.qty })
      byStore.set(origin, cur)
    }
    for (const st of byStore.values()) window.open(checkoutUrl(st.url, st.lines), '_blank', 'noopener,noreferrer')
  }

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

      {picks.length > 0 && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={openAllStores}>
            <ExternalLink className="size-3.5" />
            Open all stores ({picks.length})
          </Button>
          <Button size="sm" className="flex-1" onClick={checkoutAll}>
            <ShoppingBag className="size-3.5" />
            Checkout all
          </Button>
        </div>
      )}

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
              {(offer ?? bestExactUsd) && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <a href={(offer ?? bestExactUsd)!.url} target="_blank" rel="noopener noreferrer" className={linkCls}>
                    Store <ExternalLink className="size-2.5" />
                  </a>
                  <a
                    href={checkoutUrl((offer ?? bestExactUsd)!.url, [{ variantId: (offer ?? bestExactUsd)!.variantId, qty: g.qty }])}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkCls}
                  >
                    Checkout ×{g.qty} <ShoppingBag className="size-2.5" />
                  </a>
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
