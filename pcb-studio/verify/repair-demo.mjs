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

  const { buildTelemetryDemoBoard } = await server.ssrLoadModule('/src/data/repairDemo.ts')
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

  const models = process.env.DEMO_MODELS ? process.env.DEMO_MODELS.split(',') : ['hydrogen', 'hydrogen']
  const results = {}

  for (const [run, model] of models.entries()) {
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

    results[`${model}-${run + 1}`] = {
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
    console.log(`DEMO_REPAIRED_${model.toUpperCase()}_${run + 1}`, results[`${model}-${run + 1}`])
  }

  await fs.writeFile('/tmp/forge-demo-results.json', JSON.stringify({ initial: { passed: `${initialPassed}/15`, failed: initialFailed, sha256: initialVer.certificateSha256, violations: initialVer.diagnostics }, results }, null, 2))
} finally {
  await server.close()
}
