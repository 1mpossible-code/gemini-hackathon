import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const SHOP_MCP_URL = 'https://mcp.shop.com/'
const PROTOCOL_VERSION = '2026-07-28'
const CLIENT_INFO = { name: 'forge-pcb-studio', version: '0.2.0' }

const MINOR_EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

export type OfferMatchKind = 'exact_match' | 'bundle_or_pack' | 'variant_or_accessory'

export interface ShopOffer {
  offerId: string
  productId: string
  variantId: string
  title: string
  sellerName: string
  sellerDomain: string
  priceMinor: number
  currency: string
  formattedPrice: string
  priceUsd: number | null
  available: boolean
  url: string
  matchKind: OfferMatchKind
  matchNote: string
}

export interface ShopSearchResponse {
  mpn: string
  query: string
  status: 'ok' | 'no_results' | 'error'
  offers: ShopOffer[]
  warnings: string[]
  error?: string
  retrievedAt: string
}

function formatMinor(amount: number, currency: string): string {
  const cur = (currency || 'USD').toUpperCase()
  const exp = MINOR_EXPONENTS[cur] ?? 2
  const val = amount / 10 ** exp
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
    }).format(val)
  } catch {
    return `${cur} ${val.toFixed(exp)}`
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let len = 0
    req.on('data', (c: Buffer) => {
      len += c.length
      if (len > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>)
      } catch {
        reject(new Error('invalid JSON'))
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

async function callShopMcp(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(SHOP_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': toolName,
      'User-Agent': `${CLIENT_INFO.name}/${CLIENT_INFO.version}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
    signal: AbortSignal.timeout(12_000),
  })

  const payload = (await res.json()) as {
    error?: { message?: string }
    result?: {
      isError?: boolean
      structuredContent?: Record<string, unknown>
      content?: { type?: string; text?: string }[]
      _meta?: Record<string, unknown>
    }
  }

  if (payload.error) {
    throw new Error(payload.error.message || `Shop MCP HTTP ${res.status}`)
  }
  const result = payload.result ?? {}
  let doc = result.structuredContent
  if (!doc && Array.isArray(result.content)) {
    const txt = result.content.find((c) => c.type === 'text')?.text
    if (txt?.startsWith('{')) {
      try {
        doc = JSON.parse(txt) as Record<string, unknown>
      } catch {
        /* ignore */
      }
    }
    if (result.isError) throw new Error(txt || `Shop MCP ${toolName} error`)
  }
  if (result.isError) {
    const msgs = ((doc?.messages as { content?: string }[]) ?? []).map((m) => m.content).filter(Boolean)
    throw new Error(msgs.join('; ') || `Shop MCP ${toolName} failed`)
  }
  if (!doc) throw new Error('Empty Shop MCP response')
  return doc
}

const PACK_RE = /\b(\d+\s*-\s*pack|\d+\s*pcs|\d+\s*pack|pack\s+of|\d+\s*[x×]|[x×]\s*\d+|kit|bundle|reel|lot\s+of)\b/i
const ACCESSORY_RE = /\b(case|enclosure|cover|cable|shield|adapter|socket|programmer|carrier|book|shirt|shoe|denim|pant)\b/i
const DEV_BOARD_RE = /(dev\s*board|development\s*board|dev\.?kit|dev\s*kit)/i
const BREAKOUT_RE = /\bbreakout\b/i

export function classifyOffer(mpn: string, name: string, manufacturer: string, title: string): { kind: OfferMatchKind; note: string } | null {
  const hay = title.toLowerCase()
  const cleanMpn = mpn.toLowerCase().trim()
  const baseToken = cleanMpn.split(/[-/]/)[0]
  const nameTokens = `${name} ${manufacturer}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !['the', 'with', 'and', 'for', 'smd', 'tht', 'module'].includes(t))

  const identity = cleanMpn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s]+/g, '[-\\s]*')
  const hasMpn = cleanMpn.length >= 3 && new RegExp(`(?:^|[^a-z0-9])${identity}(?![a-z0-9-])`, 'i').test(title)
  const hasBase = baseToken.length >= 4 && hay.includes(baseToken)
  const tokenHits = nameTokens.filter((t) => hay.includes(t)).length

  if (!hasMpn && !hasBase && tokenHits === 0) return null
  if (/\b(denim|sneaker|pant|jacket|polo|shirt|dress)\b/i.test(hay)) return null

  if (ACCESSORY_RE.test(hay)) {
    return { kind: 'variant_or_accessory', note: 'Accessory or carrier board — not bare component SKU' }
  }
  if (PACK_RE.test(hay)) {
    return { kind: 'bundle_or_pack', note: 'Multi-unit pack or kit — total reflects bundle quantity' }
  }
  if (DEV_BOARD_RE.test(hay)) {
    return { kind: 'variant_or_accessory', note: 'Development board — not a bare component SKU' }
  }
  if (BREAKOUT_RE.test(hay)) {
    return { kind: 'variant_or_accessory', note: 'Breakout board — not a bare component SKU' }
  }
  const variants = hay.match(/\b(?:\d+\s*(?:mb|gb|mbyte)|n\d+(?:r\d+)?|sot[- ]?\d+|qfn[- ]?\d+|lqfp[- ]?\d+)\b/g) ?? []
  const unknownVariant = variants.some((variant) => !cleanMpn.includes(variant) && !name.toLowerCase().includes(variant))
  if (hasMpn && !unknownVariant && !/\b(?:compatible|replacement|for|board)\b/i.test(hay)) {
    return { kind: 'exact_match', note: `Exact product identity ${mpn}; supplier details still require review` }
  }
  return { kind: 'variant_or_accessory', note: 'Potential match only — review exact variant, package and footprint; catalog price retained' }
}

export function shopPlugin(): Plugin {
  const handleSearch = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
    try {
      const body = await readJson(req)
      const mpn = String(body.mpn ?? '').trim()
      const name = String(body.name ?? '').trim()
      const manufacturer = String(body.manufacturer ?? '').trim()
      const customQuery = String(body.query ?? '').trim()
      const country = String(body.country ?? 'US').toUpperCase()
      const currency = String(body.currency ?? 'USD').toUpperCase()
      const cleanMpn = mpn.replace(/\([^)]*\)/g, '').trim()
      const query = customQuery || `${cleanMpn || name}`.trim()
      if (!query) return sendJson(res, 400, { error: 'query or mpn required' })

      const now = new Date().toISOString()
      try {
        const doc = await callShopMcp('search_catalog', {
          catalog: {
            query,
            context: { address_country: country, currency },
            pagination: { limit: 8 },
          },
        })
        const warnings = ((doc.messages as { content?: string }[]) ?? [])
          .map((m) => String(m?.content ?? '').trim())
          .filter(Boolean)
        const products = (doc.products as Record<string, unknown>[]) ?? []
        const offers: ShopOffer[] = []

        for (const p of products) {
          const title = String(p.title ?? '').trim()
          const productId = String(p.id ?? '')
          const variants = (p.variants as Record<string, unknown>[]) ?? []
          if (!title || !productId || !variants.length) continue
          const v = variants[0]
          const variantId = String(v.id ?? '')
          const url = String(v.url ?? '')
          const price = (v.price as { amount?: number; currency?: string }) ?? {}
          const seller = (v.seller as { name?: string; domain?: string }) ?? {}
          const avail = Boolean((v.availability as { available?: boolean })?.available)
          if (!variantId || !url.startsWith('http') || typeof price.amount !== 'number') continue

          const variantTitle = String(v.title ?? '').trim()
          const identityTitle = variantTitle && variantTitle.toLowerCase() !== 'default title'
            ? `${title} ${variantTitle}` : title
          const classified = classifyOffer(mpn || query, name, manufacturer, identityTitle)
          if (!classified) continue

          const cur = String(price.currency ?? currency).toUpperCase()
          const exp = MINOR_EXPONENTS[cur] ?? 2
          offers.push({
            offerId: `${mpn}:${variantId.split('/').pop() ?? variantId}`,
            productId,
            variantId,
            title,
            sellerName: String(seller.name || seller.domain || 'Merchant'),
            sellerDomain: String(seller.domain || ''),
            priceMinor: price.amount,
            currency: cur,
            formattedPrice: formatMinor(price.amount, cur),
            priceUsd: cur === 'USD' ? +(price.amount / 10 ** exp).toFixed(4) : null,
            available: avail,
            url,
            matchKind: classified.kind,
            matchNote: classified.note,
          })
        }

        const rank: Record<OfferMatchKind, number> = { exact_match: 0, bundle_or_pack: 1, variant_or_accessory: 2 }
        offers.sort(
          (a, b) =>
            rank[a.matchKind] - rank[b.matchKind] ||
            (a.available === b.available ? 0 : a.available ? -1 : 1) ||
            (a.currency === 'USD' ? -1 : b.currency === 'USD' ? 1 : 0) ||
            a.priceMinor - b.priceMinor,
        )

        const out: ShopSearchResponse = {
          mpn: mpn || query,
          query,
          status: offers.length ? 'ok' : 'no_results',
          offers,
          warnings,
          retrievedAt: now,
        }
        return sendJson(res, 200, out)
      } catch (e) {
        const out: ShopSearchResponse = {
          mpn: mpn || query,
          query,
          status: 'error',
          offers: [],
          warnings: [],
          error: e instanceof Error ? e.message : String(e),
          retrievedAt: now,
        }
        return sendJson(res, 200, out)
      }
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : 'bad request' })
    }
  }

  const handleProduct = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
    try {
      const body = await readJson(req)
      const productId = String(body.productId ?? '').trim()
      if (!productId) return sendJson(res, 400, { error: 'productId required' })
      const doc = await callShopMcp('get_product', {
        catalog: {
          id: productId,
          context: { address_country: 'US', currency: 'USD' },
        },
      })
      const prod = (doc.product as Record<string, unknown>) ?? doc
      const variants = ((prod.variants as Record<string, unknown>[]) ?? []).map((v) => {
        const pr = (v.price as { amount?: number; currency?: string }) ?? {}
        const cur = String(pr.currency ?? 'USD').toUpperCase()
        return {
          id: v.id,
          formattedPrice: typeof pr.amount === 'number' ? formatMinor(pr.amount, cur) : cur,
          available: Boolean((v.availability as { available?: boolean })?.available),
          seller: (v.seller as { name?: string })?.name,
          url: v.url,
        }
      })
      return sendJson(res, 200, { id: prod.id ?? productId, title: prod.title, variants })
    } catch (e) {
      return sendJson(res, 502, { error: e instanceof Error ? e.message : 'Shop MCP get_product failed' })
    }
  }

  return {
    name: 'forge-shop',
    configureServer(server) {
      server.middlewares.use('/api/shop/search', handleSearch)
      server.middlewares.use('/api/shop/product', handleProduct)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/shop/search', handleSearch)
      server.middlewares.use('/api/shop/product', handleProduct)
    },
  }
}
