// End-to-end verification of:
//   1. Exact Lean violations on the default full rover PCB (before/after deterministic repair)
//   2. Real Gemini-driven autonomous repair (neon, hydrogen, carbon) on a smaller supported
//      ESP32 USB-UART Telemetry Node PCB with a reproducible VBUS/UART trace crossing,
//      followed by independent fresh-project Lean 4 reverification (15/15).
//
// NOTE: The smaller telemetry node is a targeted autonomous-repair demonstration and is NOT
// represented as verification of the full rover PCB.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'

const verifyDir = import.meta.dirname
const studioRoot = path.resolve(verifyDir, '..')

/** Smaller supported 2-layer ESP32 USB-UART Telemetry Node exercising all 15 Lean theorems,
 *  with one reproducible top-layer routing violation (VBUS crosses U0TXD). */
export function buildTelemetryDemoBoard() {
  return {
    name: 'ESP32 USB-UART Telemetry Node (Demo)',
    revision: 'A1',
    width: 66,
    height: 48,
    thickness: 1.6,
    cornerRadius: 2.5,
    holes: [
      { x: -29, y: -20, d: 3.2 },
      { x: 29, y: -20, d: 3.2 },
      { x: -29, y: 20, d: 3.2 },
      { x: 29, y: 20, d: 3.2 },
    ],
    parts: [
      {
        ref: 'U1', kind: 'module', name: 'ESP32-WROOM-32E', mpn: 'ESP32-WROOM-32E-N8', manufacturer: 'Espressif',
        description: 'Wi-Fi + Bluetooth LE module', pkg: 'SMD-38', x: -3, y: -3, rot: 0, category: 'RF module',
      },
      {
        ref: 'U4', kind: 'sot223', name: 'AMS1117-3.3', mpn: 'AMS1117-3.3', manufacturer: 'Advanced Monolithic Systems',
        description: '1 A LDO 3.3 V regulator', pkg: 'SOT-223', x: -20, y: -15, rot: 0, category: 'Power',
      },
      {
        ref: 'U5', kind: 'soic', name: 'CH340C', mpn: 'CH340C', manufacturer: 'WCH',
        description: 'USB to UART bridge', pkg: 'SOIC-16', x: 16, y: -5, rot: 0, category: 'Interface',
      },
      {
        ref: 'J1', kind: 'usbc', name: 'USB-C receptacle', mpn: 'TYPE-C-31-M-12', manufacturer: 'Korean Hroparts',
        description: '16-pin USB Type-C receptacle', pkg: 'USB-C-16P', x: 16, y: 20.6, rot: 0, category: 'Connector',
      },
      {
        ref: 'J6', kind: 'terminal', pins: 2, name: 'Power input', mpn: 'KF301-5.0-2P', manufacturer: 'Cixi Kefa',
        description: '2-position screw terminal, 6-12 V input', pkg: 'THT 2P 5.08', x: -27, y: -2, rot: 90, category: 'Connector',
      },
      {
        ref: 'J7', kind: 'header', pins: 6, name: 'I2C / GPIO header', mpn: 'PZ254V-11-06P', manufacturer: 'XFCN',
        description: '1x6 male pin header, 2.54 mm pitch', pkg: 'THT 1x6 2.54', x: -12, y: 17, rot: 90, category: 'Connector',
      },
      {
        ref: 'C9', kind: 'chip', size: '0805', name: '10uF MLCC', mpn: 'CL21A106KAQNNNE', manufacturer: 'Samsung',
        description: '10uF input cap', pkg: '0805', x: -24, y: -19, rot: 0, value: '10uF', category: 'Capacitor',
      },
      {
        ref: 'C10', kind: 'chip', size: '0805', name: '22uF MLCC', mpn: 'CL21A226KAQNNNE', manufacturer: 'Samsung',
        description: '22uF output cap', pkg: '0805', x: -14, y: -19, rot: 0, value: '22uF', category: 'Capacitor',
      },
      {
        ref: 'C11', kind: 'chip', size: '0805', name: '100nF MLCC', mpn: 'CL21A104KAQNNNE', manufacturer: 'Samsung',
        description: '100nF decoupling cap', pkg: '0805', x: 16, y: -15, rot: 0, value: '100nF', category: 'Capacitor',
      },
      {
        ref: 'R1', kind: 'chip', size: '0603', name: '1k resistor', mpn: 'RC0603FR-071kL', manufacturer: 'Yageo',
        description: '1k LED resistor', pkg: '0603', x: 25, y: -12, rot: 90, value: '1k', category: 'Resistor',
      },
      {
        ref: 'D1', kind: 'led', size: '0603', name: 'Status LED', mpn: '19-217/GHC-YR1S2/3T', manufacturer: 'Everlight',
        description: 'White 0603 indicator LED', pkg: '0603', x: 25, y: -16, rot: 0, category: 'LED',
      },
    ],
    nets: [
      { name: 'VIN', path: ['J6.1', 'C9.1', 'U4.3'], width: 1.0 },
      { name: '+3V3', path: ['U4.4', 'C10.1'], width: 0.8 },
      { name: '+3V3', path: ['C10.1', 'U1.2'], width: 0.8, via: [[-14, -12]] },
      { name: '+3V3', path: ['U5.16', 'C11.2'], width: 0.5 },
      { name: '+3V3', path: ['J7.1', 'U1.2'], width: 0.5, layer: 'bottom', via: [[-19, 10]] },
      { name: 'VBUS', path: ['J1.1', 'U5.1'], width: 0.6, layer: 'top', via: [[10, 14]] },
      { name: 'USB_D+', path: ['J1.6', 'U5.5'], width: 0.3, layer: 'bottom', via: [[15.75, 11], [11.5, 4], [11.5, -3.665]] },
      { name: 'USB_D-', path: ['J1.7', 'U5.6'], width: 0.3, layer: 'bottom', via: [[16.5, 11], [12.3, 4], [12.3, -3.095]] },
      // Reproducible routing violation: VBUS crosses U0TXD on top copper
      { name: 'U0TXD', path: ['U5.2', 'U1.36'], width: 0.35, layer: 'top' },
      { name: 'U0RXD', path: ['U5.3', 'U1.35'], width: 0.35, layer: 'bottom', via: [[9, -6]] },
      { name: 'SDA', path: ['U1.27', 'J7.3'], width: 0.3, layer: 'top', via: [[9, 10]] },
      { name: 'SCL', path: ['U1.28', 'J7.4'], width: 0.3, layer: 'bottom', via: [[7, 13]] },
      { name: 'LED1', path: ['U1.37', 'R1.1'], width: 0.3, layer: 'bottom', via: [[6, -15], [22, -15]] },
      { name: 'LED1', path: ['R1.2', 'D1.1'], width: 0.3, layer: 'top' },
    ],
    groundVias: [[-10, 0], [10, 0]],
  }
}

async function verifyIndependent(cert, verifyCertificate) {
  const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-independent-'))
  try {
    for (const entry of ['Forge', 'Forge.lean', 'lakefile.toml', 'lake-manifest.json', 'lean-toolchain']) {
      await fs.cp(path.join(verifyDir, entry), path.join(fresh, entry), { recursive: true })
    }
    return await verifyCertificate(cert, fresh, 120_000)
  } finally {
    await fs.rm(fresh, { recursive: true, force: true })
  }
}

async function postRepair(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/api/repair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  assert.equal(res.status, 200, `Expected HTTP 200, got ${res.status}: ${JSON.stringify(data)}`)
  return data
}

const server = await createServer({
  root: studioRoot,
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
})

try {
  await server.listen()
  const addr = server.httpServer.address()
  const baseUrl = `http://127.0.0.1:${addr.port}`

  const { buildCertificate } = await server.ssrLoadModule('/src/verify/toLean.ts')
  const { verifyCertificate, parseDiagnostics } = await server.ssrLoadModule('/server/verify.ts')
  assert.deepEqual(parseDiagnostics('info: Forge/Generated.lean:351:0: FORGE|trace_clearance|1 pair\nFORGE|trace_clearance|detail\n'), ['trace_clearance|1 pair', 'trace_clearance|detail'])

  const demoBoard = buildTelemetryDemoBoard()
  const initialCert = buildCertificate(demoBoard)
  const initialVer = await verifyCertificate(initialCert, verifyDir, 120_000)

  const initialPassed = initialVer.theorems.filter((t) => t.ok).length
  const initialFailed = initialVer.theorems.filter((t) => !t.ok).map((t) => t.name)
  console.log('DEMO_ORIGINAL', {
    status: initialVer.status,
    passed: `${initialPassed}/${initialVer.theorems.length}`,
    failed: initialFailed,
    durationMs: initialVer.durationMs,
    sha256: initialVer.certificateSha256,
    violations: initialVer.diagnostics?.filter((d) => !d.startsWith('warning|') && !d.startsWith('info|')),
  })
  assert.equal(initialVer.status, 'failed', 'Demo board must initially fail Lean verification')
  assert.equal(initialVer.theorems.length, 15, 'Demo board must exercise all 15 Lean theorems')
  assert.deepEqual(initialFailed, ['trace_clearance', 'all_rules'], `Expected only trace_clearance/all_rules to fail, got ${initialFailed}`)

  // Reject invalid model name cleanly
  const badRes = await fetch(`${baseUrl}/api/repair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board: demoBoard, model: 'not-a-real-model' }),
  })
  assert.equal(badRes.status, 400, 'Unknown repair model must return HTTP 400')

  const models = process.env.DEMO_MODELS ? process.env.DEMO_MODELS.split(',') : ['neon', 'hydrogen', 'carbon']
  const results = {}

  for (const model of models) {
    // Deliberately pass a forged passing verification to confirm provenance validation ignores it.
    const resp = await postRepair(baseUrl, {
      board: demoBoard,
      model,
      verification: { status: 'passed', theorems: [{ name: 'all_rules', statement: 'forged', ok: true }] },
    })

    const passedCount = resp.verification.theorems.filter((t) => t.ok).length
    assert.equal(resp.actor, 'gemini', `${model}: expected real Gemini repair, got ${resp.actor} (err=${resp.gemini?.error})`)
    assert.equal(resp.deterministicAdjustments, 0, `${model}: expected 0 deterministic fallback adjustments, got ${resp.deterministicAdjustments}`)
    assert.equal(resp.repaired, true, `${model}: expected repaired=true`)
    assert.equal(resp.verification.status, 'passed', `${model}: expected Lean status=passed`)
    assert.equal(passedCount, 15, `${model}: expected 15/15 passing theorems`)
    assert.notEqual(resp.board.revision, demoBoard.revision, `${model}: expected bumped revision`)
    assert.deepEqual(resp.board.parts, demoBoard.parts, `${model}: parts must not change in this routing-only demonstration`)
    assert.deepEqual(resp.board.nets.map(n => [n.name, n.path]), demoBoard.nets.map(n => [n.name, n.path]), `${model}: net topology must not change`) 
    assert.notEqual(resp.verification.certificateSha256, initialVer.certificateSha256, `${model}: expected new certificate hash`)

    // Independent fresh-project Lean reverification (no shared build cache)
    const indepCert = buildCertificate(JSON.parse(JSON.stringify(resp.board)))
    const indepVer = await verifyIndependent(indepCert, verifyCertificate)
    assert.equal(indepVer.status, 'passed', `${model}: independent Lean verification failed`)
    assert.equal(indepVer.theorems.filter((t) => t.ok).length, 15, `${model}: independent expected 15/15`)
    assert.equal(indepVer.certificateSha256, resp.verification.certificateSha256, `${model}: independent hash mismatch`)

    results[model] = {
      actor: resp.actor,
      repaired: resp.repaired,
      deterministicAdjustments: resp.deterministicAdjustments,
      revision: `${demoBoard.revision} -> ${resp.board.revision}`,
      gemini: resp.gemini,
      repairPassed: `${passedCount}/${resp.verification.theorems.length}`,
      repairVerifyMs: resp.verification.durationMs,
      independentPassed: `${indepVer.theorems.filter((t) => t.ok).length}/${indepVer.theorems.length}`,
      independentVerifyMs: indepVer.durationMs,
      certificateSha256: indepVer.certificateSha256,
      rationale: resp.rationale,
      changedNets: resp.board.nets.flatMap((net, index) => JSON.stringify(net) === JSON.stringify(demoBoard.nets[index]) ? [] : [{ index, before: demoBoard.nets[index], after: net }]),
    }
    console.log(`DEMO_REPAIRED_${model.toUpperCase()}`, results[model])
  }

  await fs.writeFile('/tmp/forge-demo-results.json', JSON.stringify({ initial: { passed: `${initialPassed}/15`, failed: initialFailed, sha256: initialVer.certificateSha256, violations: initialVer.diagnostics }, results }, null, 2))
} finally {
  await server.close()
}
