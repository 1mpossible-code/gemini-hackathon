// Run: node tests/qa_pcb_regression.mjs (after installing pcb-studio dependencies).
import assert from 'node:assert/strict'
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from '../pcb-studio/node_modules/vite/dist/node/index.js'

const root = path.resolve('pcb-studio')
const server = await createServer({ root, server: { port: 0 } })
globalThis.location = { search: '' }
let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`) }
  catch (e) { failures++; console.error(`FAIL ${name}: ${e.stack}`) }
}
try {
  const s = await server.ssrLoadModule('/src/state/studio.ts')
  const { catalog } = await server.ssrLoadModule('/src/data/catalog/index.ts')
  const { analyzeSystem } = await server.ssrLoadModule('/src/data/system.ts')
  const initial = structuredClone(s.getStudio())
  await check('board edit increments revision, invalidates checks, undo restores exact board and verification', () => {
    s.setStudio({ verification: { status: 'passed', theorems: [] } })
    s.commitBoardEdit(b => { b.width += 1 }, 'QA resize')
    assert.notEqual(s.getStudio().board.revision, initial.board.revision)
    assert.equal(s.getStudio().verification.status, 'idle')
    s.undoLastEdit()
    assert.deepEqual(s.getStudio().board, initial.board)
    assert.equal(s.getStudio().verification.status, 'passed')
  })
  await check('system replacement updates cost and undo restores system and budget', () => {
    s.setStudio(structuredClone(initial))
    const dev = initial.system.devices[0]
    const replacement = catalog.find(p => p.id !== dev.catalogId && p.category === 'actuator')
    assert.ok(replacement)
    s.commitSystemSwap(dev.id, replacement.id)
    assert.equal(s.getStudio().system.devices[0].catalogId, replacement.id)
    const expected = s.computeSystemDevicesCost(s.getStudio().system)
    assert.ok(Number.isFinite(expected.totalUsd))
    s.undoLastEdit()
    assert.deepEqual(s.getStudio().system, initial.system)
    assert.equal(s.getStudio().budgetUsd, initial.budgetUsd)
  })
  await check('only available exact USD offers affect BOM; accessory and unavailable offers ignored', () => {
    const b = initial.board
    const p = b.parts.find(p => p.pricing?.[0]?.price != null)
    assert.ok(p)
    const offer = { matchKind: 'exact_match', available: true, priceUsd: 123 }
    const baseline = s.computeBoardBomCost(b).totalUsd
    const count = b.parts.filter(x => x.mpn === p.mpn).length
    const original = b.parts.filter(x => x.mpn === p.mpn).reduce((n,x) => n + (x.pricing?.[0]?.price ?? 0), 0)
    assert.ok(Math.abs(s.computeBoardBomCost(b, { [p.mpn]: offer }).totalUsd - (baseline - original + count * 123)) < .001)
    for (const patch of [{ available: false }, { matchKind: 'bundle_or_pack' }, { priceUsd: null }]) {
      assert.equal(s.computeBoardBomCost(b, { [p.mpn]: { ...offer, ...patch } }).totalUsd, baseline)
    }
  })
  await check('default assembly explicitly reports electrical risks', () => {
    const health = analyzeSystem(initial.system, initial.board)
    assert.ok(health.warningCount > 0)
    console.log('EVIDENCE electrical:', JSON.stringify(health.issues.map(x => ({ device: x.deviceId, headline: x.headline }))))
  })
  await check('real Lean certificate build, isolated from tracked verification files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-qa-lean-'))
    try {
      await cp(path.join(root, 'verify'), dir, { recursive: true, filter: p => !p.includes('/.lake') })
      const { buildCertificate } = await server.ssrLoadModule('/src/verify/toLean.ts')
      const { verifyCertificate } = await server.ssrLoadModule('/server/verify.ts')
      const cert = buildCertificate(initial.board)
      const result = await verifyCertificate(cert, dir, 180000)
      console.log('EVIDENCE Lean:', JSON.stringify(result))
      assert.ok(!/ENOENT|timed out/.test(result.log ?? ''))
      assert.ok(result.theorems.length > 0)
      assert.ok(result.log?.includes('Forge.Generated'))
      assert.ok(result.theorems.some(t => !t.ok), 'default board should expose known design violations')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  await check('delayed verification cannot certify an edited board', async () => {
    // Execute the actual function body, stripping only its TypeScript declarations.
    const app = await readFile(path.join(root, 'src/App.tsx'), 'utf8')
    let body = app.split('async function runBoardDesignChecks() {')[1].split('\nasync function runAiBoardRepair')[0]
    body = body.slice(0, body.lastIndexOf('}'))
      .replace(/ as \{ verifyBoard:.*?\}/, '')
      .replace('const fallback: VerificationData', 'const fallback')
    let release
    const delayed = new Promise(resolve => { release = resolve })
    const modules = { './verify/verify.ts': async () => ({ verifyBoard: () => delayed }) }
    const run = new Function('setStudio', 'getStudio', 'verifyModules', 'beginDesignRequest', `return (async () => {${body}})()`)
    s.setStudio(structuredClone(initial))
    const job = run(s.setStudio, s.getStudio, modules, s.beginDesignRequest)
    await new Promise(resolve => setTimeout(resolve, 0))
    s.commitBoardEdit(b => { b.width += 1 }, 'Edit during verification')
    release({ status: 'passed', theorems: [{ name: 'old_board', ok: true }] })
    await job
    assert.equal(s.getStudio().verification.status, 'idle')
    assert.deepEqual(s.getStudio().verification.theorems, [])
    assert.notEqual(s.getStudio().board.revision, initial.board.revision)
    console.log('EVIDENCE stale certificate discarded on', s.getStudio().board.revision)
  })
  await server.listen()
  const base = server.resolvedUrls.local[0]
  await check('generation rejects invalid input and missing key without fabricated board', async () => {
    for (const [body, status] of [[{}, 400], [{ prompt: 'QA rover board' }, 503]]) {
      const res = await fetch(new URL('/api/generate', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const text = await res.text()
      console.log('EVIDENCE generate:', res.status, text)
      assert.equal(res.status, status)
      assert.ok(!text.includes('"parts"'))
    }
  })
  await check('live Shopify discovery returns explicit provenance or explicit failure', async () => {
    const res = await fetch(new URL('/api/shop/search', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mpn: 'ESP32-WROOM-32E', name: 'ESP32', manufacturer: 'Espressif' }) })
    const data = await res.json()
    console.log('EVIDENCE Shopify:', res.status, JSON.stringify(data))
    assert.ok(['ok', 'no_results', 'error'].includes(data.status))
    assert.ok(Array.isArray(data.offers))
    if (data.status === 'error') assert.ok(data.error)
    for (const offer of data.offers) assert.ok(offer.url && offer.sellerDomain && offer.matchKind)
    const wrong = data.offers.filter(o => o.matchKind === 'exact_match' && /dev(elopment)? board|dev board/i.test(o.title))
    if (wrong.length) console.log('KNOWN BUG development boards classified as module exact matches:', wrong.map(o => o.title))
    if (process.env.QA_STRICT) assert.deepEqual(wrong, [])
  })
} finally { await server.close() }
process.exitCode = failures ? 1 : 0
