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
 // Extra Lean diagnostic only: enumerate every violating segment pair without the report's 20-line cap.
 const diagnosticCert = buildCertificate(repaired)
 diagnosticCert.source = diagnosticCert.source.replace('end Forge.Generated', `
private def fullViolations : List Seg → List String
  | [] => []
  | s :: rest => (rest.filterMap fun t =>
      if s.net ≠ t.net ∧ s.layer = t.layer ∧ segClear s t (Rules.clearReq board s t) = false then
        some s!"FORGE|trace_detail|{s.net} {Report.showPt s.a}-{Report.showPt s.b} vs {t.net} {Report.showPt t.a}-{Report.showPt t.b} ({repr s.layer})"
      else none) ++ fullViolations rest
#eval IO.println (String.intercalate "\\n" (fullViolations board.segs))
end Forge.Generated`)
 const detailed = await verifyCertificate(diagnosticCert, dir)
 const allViolations = detailed.diagnostics.filter(d => d.startsWith('trace_detail|'))
 assert.equal(detailed.status, after.status)
 assert.equal(allViolations.length, Number(after.diagnostics.find(d => d.includes('same-layer segment pairs')).split('|')[1].split(' ')[0]))
 await fs.writeFile('/tmp/forge-routing-results.json', JSON.stringify({before,after,independent,notes,routingMs,board:repaired,allViolations}, null, 2))
 for (const [name, result] of Object.entries({before,after,independent})) console.log(name, result.status, result.theorems.filter(t=>t.ok).length, result.durationMs, result.diagnostics?.filter(d=>d.startsWith('trace_clearance')))
} finally { await server.close() }
