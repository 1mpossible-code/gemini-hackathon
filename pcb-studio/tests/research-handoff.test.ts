import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { resolveResearchHandoff } from '../server/research-handoff.ts'
import { activateResearch, researchForPrompt, type ResearchContext } from '../src/ai/researchHandoff.ts'
import { mapResearchParts, requireResearchParts, researchInstructions } from '../src/ai/researchConstraints.ts'

const researchId = '4e1b2ee3-1596-4a24-9ed2-718fc7088809'
function fixture(kind: ResearchContext['snapshot']['kind'] = 'evidence_backed'): ResearchContext {
  const snapshot: ResearchContext['snapshot'] = {
    research_id: researchId, kind, brief: 'Build an EMG device',
    parts: [{ id: 'sensor', name: 'MyoWare', manufacturer: 'SparkFun', sku: 'DEV-27924' }],
    device_spec: { components: [{ catalog_id: 'sensor', quantity: 2 }], wiring: { supply_rail_mv: 3300 }, mechanical: {} },
    evidence: [{ part_id: 'sensor', design_ready: true, facts: [
      { field: 'supply', verification: 'agreed', min: 2270, max: 5470, unit: 'mV' },
      { field: 'invented', verification: 'disputed', value: 100 },
    ] }],
    source_research: { policy: { exclude_at_ai_fraction: .5 }, sources: [{ decision: 'excluded' }] },
    research_verification: { status: 'verified' }, scope: 'Research inputs only; PCB validation required.',
  }
  const snapshot_json = JSON.stringify(snapshot)
  return { snapshot, envelope: { schema_version: 1, snapshot_json, bundle_sha256: createHash('sha256').update(snapshot_json).digest('hex') } }
}
const reference = (context: ResearchContext) => ({ researchId, bundleSha256: context.envelope.bundle_sha256 })

test('server resolves only the configured service and retains complete provenance', async (t) => {
  const context = fixture()
  t.mock.method(globalThis, 'fetch', async (url: URL, opts: RequestInit) => {
    assert.equal(url.origin, 'http://research.internal:8000')
    assert.equal(url.pathname, `/api/research/${researchId}/engineering-handoff`)
    assert.equal(opts.redirect, 'error')
    return Response.json(context.envelope)
  })
  assert.deepEqual(await resolveResearchHandoff({ ...reference(context), url: 'http://untrusted/' }, 'http://research.internal:8000'), context)
})

test('expired, corrupted, changed and forged references stop at the boundary', async (t) => {
  const context = fixture()
  let response = new Response('', { status: 404 })
  const fetch = t.mock.method(globalThis, 'fetch', async () => response)
  await assert.rejects(resolveResearchHandoff({ researchId: '../other', bundleSha256: 'x' }, 'http://research'), /Invalid/)
  assert.equal(fetch.mock.callCount(), 0)
  await assert.rejects(resolveResearchHandoff(reference(context), 'http://research'), /unavailable/)
  response = Response.json({ ...context.envelope, snapshot_json: context.envelope.snapshot_json + ' ' })
  await assert.rejects(resolveResearchHandoff(reference(context), 'http://research'), /corrupt/)
  response = Response.json(context.envelope)
  await assert.rejects(resolveResearchHandoff({ researchId, bundleSha256: 'a'.repeat(64) }, 'http://research'), /changed/)
})

test('saved live snapshot must contain every selected part evidence', async (t) => {
  const context = fixture()
  context.snapshot.evidence = []
  context.envelope.snapshot_json = JSON.stringify(context.snapshot)
  context.envelope.bundle_sha256 = createHash('sha256').update(context.envelope.snapshot_json).digest('hex')
  t.mock.method(globalThis, 'fetch', async () => Response.json(context.envelope))
  await assert.rejects(resolveResearchHandoff(reference(context), 'http://research'), /lacks required/)
})

test('exact SKU mapping blocks current MyoWare variant, ambiguity, omitted parts and wrong quantities', () => {
  const context = fixture()
  const exact = { id: 'correct-sensor', manufacturer: 'SparkFun', mpn: 'DEV-27924' }
  assert.throws(() => mapResearchParts(context, [{ ...exact, mpn: 'DEV-21265' }]), /no exact entry/)
  assert.throws(() => mapResearchParts(context, [exact, { ...exact, id: 'duplicate' }]), /ambiguous/)
  const mapping = mapResearchParts(context, [exact])
  assert.throws(() => requireResearchParts(mapping, []), /cannot be dropped/)
  assert.throws(() => requireResearchParts(mapping, [{ catalogId: exact.id }]), /received 1/)
  requireResearchParts(mapping, [{ catalogId: exact.id }, { catalogId: exact.id }])
  const instructions = researchInstructions(context, mapping)
  assert.match(instructions, /3300/)
  assert.match(instructions, /5470/)
  assert.doesNotMatch(instructions, /invented/)
})

test('editing a prompt permanently drops the old research reference', () => {
  const ref = reference(fixture())
  activateResearch('Build an EMG device', ref)
  assert.deepEqual(researchForPrompt('Build an EMG device'), ref)
  assert.equal(researchForPrompt('Build a drone'), undefined)
  assert.equal(researchForPrompt('Build an EMG device'), undefined)
})

test('real generation pipeline blocks the mismatched catalog before any model call and carries mapped inputs on success', async (t) => {
  const root = process.cwd()
  const server = await createServer({
    configFile: false, root, logLevel: 'error', resolve: { alias: { '@': resolve(root, 'src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  t.after(() => server.close())
  const pipeline = await server.ssrLoadModule('/src/ai/pipeline.ts') as typeof import('../src/ai/pipeline.ts')
  const context = fixture()
  let calls = 0
  const llm = async (request: { system: string }) => {
    calls++
    assert.match(request.system, /3300/)
    if (calls === 1) return { name: 'Handoff fixture', summary: 'Test', supply: '3.3V', parts: [{ ref: 'U1', catalogId: 'esp32-devkitc-32e', purpose: 'Controller', role: 'mcu' }] }
    return { nets: [] }
  }
  await assert.rejects(pipeline.runPipeline({ prompt: context.snapshot.brief, research: context }, { emit() {}, llm }), /no exact entry/)
  assert.equal(calls, 0)
  context.snapshot.parts = [{ id: 'controller', name: 'ESP32', manufacturer: 'Espressif', sku: 'ESP32-DevKitC-32E' }]
  context.snapshot.device_spec!.components = [{ catalog_id: 'controller', quantity: 1 }]
  context.snapshot.evidence[0].part_id = 'controller'
  context.envelope.snapshot_json = JSON.stringify(context.snapshot)
  context.envelope.bundle_sha256 = createHash('sha256').update(context.envelope.snapshot_json).digest('hex')
  const result = await pipeline.runPipeline({ prompt: context.snapshot.brief, research: context }, { emit() {}, llm })
  assert.deepEqual(result.board.researchHandoff?.envelope, context.envelope)
  assert.equal(result.board.researchHandoff?.pcbValidation, 'required')
  assert.equal(result.board.researchHandoff?.partMapping[0].catalogId, 'esp32-devkitc-32e')
  assert.ok(result.warnings.includes(context.snapshot.scope))
})
