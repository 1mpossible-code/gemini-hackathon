import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'

// Node's native TypeScript support, with the project's extensionless imports.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL) {
    for (const suffix of ['.ts', '/index.ts']) {
      const url = new URL(specifier + suffix, context.parentURL)
      if (existsSync(url)) return next(url.href, context)
    }
  }
  return next(specifier, context)
} })
const { defaultSystem, analyzeDevice, analyzeSystem, alternativesFor, systemCost } = await import('../src/data/system.ts')
const { board } = await import('../src/data/board.ts')
const battery = defaultSystem.devices.find(d => d.id === 'bat')
const motor = defaultSystem.devices[0]
const check = (dev) => analyzeDevice(dev, board)
assert.equal(check({ ...battery, catalogId: 'holder-18650' }).severity, 'warning')
assert.equal(check(battery).severity, 'unverified')
assert.equal(check(motor).severity, 'warning')
assert.equal(check({ ...motor, catalogId: 'pololu-3040' }).severity, 'unverified')
assert.equal(check({ ...motor, catalogId: 'pololu-3040', rail: 13 }).severity, 'warning')
assert.equal(analyzeDevice({ ...motor, catalogId: 'pololu-3040' }).severity, 'unverified')
for (const id of ['sonar', 'leds']) assert.equal(check(defaultSystem.devices.find(d => d.id === id)).severity, 'warning')
assert.equal(check({ ...motor, catalogId: 'missing' }).severity, 'unverified')
assert.equal(check({ ...motor, rail: NaN }).severity, 'warning')
const replacement = alternativesFor(motor, board).find(a => a.item.id === 'pololu-3040')
assert.ok(replacement)
assert.ok(replacement.delta > 0)
assert.equal(replacement.severity, 'unverified')
const replaced = { ...defaultSystem, devices: defaultSystem.devices.map(d => d.id === motor.id ? { ...d, catalogId: 'pololu-3040' } : d) }
assert.ok(systemCost(replaced) > systemCost(defaultSystem))
assert.equal(analyzeSystem(replaced, board).warningCount, analyzeSystem(defaultSystem, board).warningCount - 1)
assert.notEqual(analyzeSystem(defaultSystem, board).status, 'ok')
console.log('Hardware regression checks passed')
