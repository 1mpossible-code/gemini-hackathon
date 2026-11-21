// CLI: regenerate Forge/Generated.lean for the example board (or a JSON board file),
// optionally build it and print the per-theorem results.
//
//   node verify/gen.mjs                 # write Generated.lean for src/data/board.ts
//   node verify/gen.mjs --build         # …and run `lake build Forge.Generated`
//   node verify/gen.mjs board.json --build
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const args = process.argv.slice(2)
const build = args.includes('--build')
const file = args.find((a) => !a.startsWith('--'))

const vite = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false },
  resolve: { alias: { '@': path.join(root, 'src') } }, optimizeDeps: { noDiscovery: true } })
try {
  const { buildCertificate } = await vite.ssrLoadModule('/src/verify/toLean.ts')
  const board = file ? JSON.parse(await readFile(file, 'utf8')) : (await vite.ssrLoadModule('/src/data/board.ts')).board
  const cert = buildCertificate(board)
  if (!build) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(here, 'Forge', 'Generated.lean'), cert.source)
    console.log(`wrote Forge/Generated.lean (${cert.theorems.length} theorems)`)
  } else {
    const { verifyCertificate } = await vite.ssrLoadModule('/server/verify.ts')
    const r = await verifyCertificate(cert, here)
    for (const t of r.theorems) console.log(`${t.ok ? '✓' : '✗'} ${t.name}: ${t.statement}${t.error ? `\n    ${t.error.split('\n')[0]}` : ''}`)
    for (const d of r.diagnostics ?? []) console.log(`  · ${d}`)
    console.log(`status ${r.status} in ${r.durationMs} ms`)
    if (args.includes('--log')) console.log(r.log)
    if (args.includes('--assumptions')) for (const a of r.assumptions ?? []) console.log(`  - ${a}`)
    process.exitCode = r.status === 'passed' ? 0 : 1
  }
} finally {
  await vite.close()
}
