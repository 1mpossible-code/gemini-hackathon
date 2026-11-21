import { createServer } from 'vite'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const root = new URL('..', import.meta.url).pathname
const server = await createServer({ root, server: { middlewareMode: true } })
try {
 const { board } = await server.ssrLoadModule('/src/data/board.ts')
 const { buildCertificate } = await server.ssrLoadModule('/src/verify/toLean.ts')
 const fp = await server.ssrLoadModule('/src/pcb/footprint.ts')
 const { stabilizeGeometryAndClearances } = await server.ssrLoadModule('/server/repair.ts')
 const { verifyCertificate } = await server.ssrLoadModule('/server/verify.ts')
 const dir = import.meta.dirname
 const before = await verifyCertificate(buildCertificate(board), dir)
 assert.equal(before.status, 'failed')
 const repaired = structuredClone(board)
 const started = performance.now()
 const notes = stabilizeGeometryAndClearances(repaired, fp)
 const routingMs = Math.round(performance.now() - started)
 repaired.revision += '.routing-check'
 assert.notEqual(buildCertificate(repaired).source, buildCertificate(board).source)
 const after = await verifyCertificate(buildCertificate(repaired), dir)
 const fresh = await fs.mkdtemp('/tmp/forge-independent-')
 for (const entry of ['Forge', 'Forge.lean', 'lakefile.toml', 'lake-manifest.json', 'lean-toolchain']) await fs.cp(`${dir}/${entry}`, `${fresh}/${entry}`, {recursive:true})
 const independent = await verifyCertificate(buildCertificate(JSON.parse(JSON.stringify(repaired))), fresh)
 assert.equal(independent.certificateSha256, after.certificateSha256)
 await fs.rm(fresh, {recursive:true})
 assert.equal(independent.status, after.status)
 assert.deepEqual(independent.theorems, after.theorems)
 await fs.writeFile('/tmp/forge-routing-results.json', JSON.stringify({before,after,independent,notes,routingMs,board:repaired}, null, 2))
 for (const [name, result] of Object.entries({before,after,independent})) console.log(name, result.status, result.theorems.filter(t=>t.ok).length, result.durationMs, result.diagnostics?.filter(d=>d.startsWith('trace_clearance')))
} finally { await server.close() }
