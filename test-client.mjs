import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const clientPath = join(ROOT, 'package', 'lib', 'client.cjs')
let clientSource
try {
  clientSource = readFileSync(clientPath, 'utf8')
} catch (error) {
  console.error('client bundle missing; run node build-model-caps.mjs first:', error.message)
  process.exit(1)
}

const source = readFileSync(join(ROOT, 'dsh-model-caps.client.js'), 'utf8')
check('client source has no CJK', /[\u3040-\u30ff\u3400-\u9fff]/.test(source), false)

const registrations = []
const fakeWindow = { __ModuleLoader__: { load: (registration) => { registrations.push(registration) } } }
const stubCtx = {
  slots: {
    inject: () => { throw new Error('client must not register a slot') },
    register: () => { throw new Error('client must not register a slot') },
  },
  effect: (fn) => fn(),
}
const loader = new Function('window', 'require', clientSource)
loader(fakeWindow, (name) => { throw new Error(`unexpected require ${name}`) })
const mod = registrations[0].factory((name) => { throw new Error(`unexpected require ${name}`) })
check('client factory exports apply', typeof mod.apply, 'function')
check('client injects nothing', mod.inject, [])
check('client apply returns undefined', mod.apply(stubCtx), undefined)
check('client bundle does not register a settings section', clientSource.includes('settings.section'), false)

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
