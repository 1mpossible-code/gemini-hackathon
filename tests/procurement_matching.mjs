import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from '../pcb-studio/node_modules/vite/dist/node/index.js'

// Replay the actual recorded response, not another network-dependent search.
const evidence = execFileSync('git', ['show', '4a17ebc:docs/qa/pcb-evidence.log'], { encoding: 'utf8' })
const recorded = JSON.parse(evidence.split('\n').find(line => line.startsWith('EVIDENCE Shopify: 200 ')).slice('EVIDENCE Shopify: 200 '.length))
const server = await createServer({ root: 'pcb-studio', server: { port: 0 } })
globalThis.location = { search: '' }
try {
  const { classifyOffer } = await server.ssrLoadModule('/server/shop.ts')
  const s = await server.ssrLoadModule('/src/state/studio.ts')
  const board = s.getStudio().board
  const baseline = s.computeBoardBomCost(board).totalUsd
  const classify = title => classifyOffer('ESP32-WROOM-32E', 'ESP32', 'Espressif', title)
  let rejected = 0
  for (const offer of recorded.offers) {
    const result = classify(offer.title)
    assert.ok(result, offer.title)
    if (/dev(elopment)?\s*board|16MB/i.test(offer.title)) {
      assert.notEqual(result.kind, 'exact_match', offer.title)
      const selected = { ...offer, matchKind: result.kind, priceUsd: 0.01 }
      assert.equal(s.computeBoardBomCost(board, { [recorded.mpn]: selected }).totalUsd, baseline)
      rejected++
    } else assert.equal(result.kind, 'exact_match', offer.title)
  }
  assert.equal(rejected, 4)
  const ambiguous = [
    'ESP32 module', 'ESP32-WROOM-32', 'ESP32-WROOM-32E-N16',
    'ESP32-WROOM-32E 16MB', 'ESP32-WROOM-32E socket',
    'ESP32-WROOM-32E breakout', 'Case for ESP32-WROOM-32E',
    'ESP32-WROOM-32E compatible replacement', 'ESP32-WROOM-32E USB-C board',
    'ESP32-WROOM-32E 5-pack', 'ESP32-WROOM-32E pack of 5',
  ]
  for (const title of ambiguous) {
    const result = classify(title)
    assert.notEqual(result?.kind, 'exact_match', title)
    assert.equal(s.computeBoardBomCost(board, { [recorded.mpn]: { matchKind: result?.kind, available: true, priceUsd: 0.01 } }).totalUsd, baseline)
  }
  assert.equal(classify('ESP32-WROOM-32E')['kind'], 'exact_match')
  assert.equal(classify('ESP32 WROOM 32E Module')['kind'], 'exact_match')
  console.log(`PASS ${recorded.offers.length} actual Shopify offers and ${ambiguous.length} ambiguous/accessory/bundle/variant cases; incompatible offers retain BOM pricing`)
} finally { await server.close() }
