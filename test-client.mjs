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
const withoutZh = source.replace(/\r\n/g, '\n').replace(/zh:\s*\{[\s\S]*?\n  \},\n  en:/, 'en:')
check('client source has no CJK outside the zh dictionary', /[\u3040-\u30ff\u3400-\u9fff]/.test(withoutZh), false)

const registrations = []
const fakeWindow = { __ModuleLoader__: { load: (registration) => { registrations.push(registration) } } }
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: (fn) => { fn() },
}
const registered = []
const stubLocale = {
  register: (ns, copy) => { registered.push({ ns, copy }); return () => {} },
  bind: (ns) => (key) => registered.find((entry) => entry.ns === ns)?.copy?.en?.[key] ?? key,
}
const stubCtx = {
  slots: {
    inject: (_slot, callback) => callback(),
    register: (options, component) => {
      registered.push({ options, component })
      return { options, component }
    },
  },
  locale: stubLocale,
  effect: (fn) => fn(),
}
const previousFetch = globalThis.fetch
globalThis.fetch = () => Promise.resolve({ json: async () => ({ providers: [] }) })
const loader = new Function('window', 'require', clientSource)
loader(fakeWindow, (name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require ${name}`)
})
const mod = registrations[0].factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require ${name}`)
})
check('client factory exports apply', typeof mod.apply, 'function')
check('client injects slots and locale', mod.inject, ['slots', 'locale'])
check('client apply returns undefined', mod.apply(stubCtx), undefined)
const slot = registered.find((entry) => entry.options?.id === 'dsh-model-caps')
check('client occupies its own settings section', slot?.options?.name, 'settings.section')
check('the section label is the english title', slot.options.label(), 'Model caps')
const copy = registered.find((entry) => entry.ns === 'dsh-model-caps')?.copy
check('zh and en keys match', Object.keys(copy.zh).sort(), Object.keys(copy.en).sort())
const view = slot.component()
check('the panel renders a section', view.type, 'section')
globalThis.fetch = previousFetch

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
