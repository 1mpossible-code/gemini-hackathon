import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from '../pcb-studio/node_modules/vite/dist/node/index.js'
import { stripTypeScriptTypes } from 'node:module'
const server = await createServer({ root: 'pcb-studio', server: { port: 0 } })
globalThis.location = { search: '' }
try {
  const s = await server.ssrLoadModule('/src/state/studio.ts')
  const initial = structuredClone(s.getStudio())
  const app = await readFile('pcb-studio/src/App.tsx', 'utf8')
  const verify = app.slice(app.indexOf('async function runBoardDesignChecks()'), app.indexOf('async function runAiBoardRepair'))
  const repair = app.slice(app.indexOf('async function runAiBoardRepair'), app.indexOf('\nfunction ', app.indexOf('async function runAiBoardRepair')))
  const genStart = app.indexOf('  const runGenerate = async')
  const generate = app.slice(genStart, app.indexOf('\n  useEffect', genStart))
  let count = 0
  for (const [name, source, entry] of [['verify', verify, 'runBoardDesignChecks'], ['repair', repair, 'runAiBoardRepair'], ['generate', generate, 'runGenerate']]) {
    for (const failure of [false, true]) {
      for (const change of ['edit', 'undo-cycle', 'new-request', 'budget', 'system', 'offer', 'unchanged']) {
        s.setStudio(structuredClone(initial))
        let release, reject
        const delayed = new Promise((a, b) => { release = a; reject = b })
        const noop = () => {}
        const env = { ...s, text: 'test', busy: false, setPromptOpen: noop, setBusy: noop, setError: noop, setLog: noop,
          verifyModules: { './verify/verify.ts': async () => ({ verifyBoard: () => delayed }) },
          aiModules: { './ai/generate.ts': async () => ({ generateBoard: () => delayed }) },
          fetch: () => delayed,
        }
        const js = stripTypeScriptTypes(source)
        const run = new Function(...Object.keys(env), `${js}; return ${entry}`)(...Object.values(env))
        const job = run()
        await new Promise(resolve => setTimeout(resolve, 0))
        if (change === 'new-request') s.beginDesignRequest()
        else if (change === 'budget') s.setStudio({ budgetUsd: initial.budgetUsd + 1 })
        else if (change === 'system') s.setStudio({ system: structuredClone(initial.system) })
        else if (change === 'offer') s.setStudio({ selectedOfferByMpn: {} })
        else if (change !== 'unchanged') {
          s.commitBoardEdit(b => { b.width++ }, 'edit')
          if (change === 'undo-cycle') { s.undoLastEdit(); s.commitBoardEdit(b => { b.width++ }, 'same revision') }
        }
        const before = structuredClone(s.getStudio())
        if (failure) reject(new Error('delayed failure'))
        else release(name === 'verify' ? { status: 'passed', theorems: [] } : name === 'generate' ? initial.board : { ok: true, json: async () => ({ board: initial.board, verification: { status: 'passed', theorems: [] } }) })
        await job.catch(() => {})
        if (change !== 'unchanged' || (failure && name !== 'verify')) {
          assert.deepEqual(s.getStudio(), before, `${name}/${failure}/${change}`)
        } else if (name === 'generate') {
          assert.equal(s.getStudio().history.length, before.history.length + 1)
        } else {
          assert.equal(s.getStudio().verification.status, failure ? 'failed' : 'passed')
        }
        count++
      }
    }
  }
  s.setStudio(structuredClone(initial))
  s.setStudio({ verification: { status: 'passed', theorems: [] } })
  s.commitBoardEdit(b => { b.width++ }, 'edit')
  assert.equal(s.getStudio().verification.status, 'idle')
  s.undoLastEdit()
  assert.deepEqual(s.getStudio().board, initial.board)
  assert.equal(s.getStudio().verification.status, 'passed')
  console.log(`PASS ${count} delayed-response cases (including current success/failure); invalidation and certified undo`)
} finally { await server.close() }
