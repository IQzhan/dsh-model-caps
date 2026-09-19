import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const require = createRequire(join(ROOT, 'package', 'package.json'))
let pkg
try {
  pkg = require(join(ROOT, 'package', 'package.json'))
} catch (error) {
  console.error('package missing; run node build-model-caps.mjs first:', error.message)
  process.exit(1)
}

check('package name matches the patch row', pkg.name, 'dsh-model-caps')
check('package declares dsh.client for web', pkg.dsh?.client?.platform, 'web')
check('package declares a bundle patch', pkg.dsh?.bundle?.patch, './cordis.patch.yml')
check('package exposes ./client', pkg.exports?.['./client']?.default, './lib/client.cjs')
check('client injects the slots package before itself', pkg.dsh?.client?.inject, ['@deepseek-ai/dsh-client-ui-slots'])
check('client shares the shell React', pkg.dsh?.client?.external, ['react'])
check('client waits for the shell', pkg.dsh?.client?.immediately, false)

const host = require(join(ROOT, 'package', 'lib', 'index.cjs'))
check('host exports apply', typeof host.apply, 'function')
check('host bundle has no import statements',
  /^\s*import\s/m.test(readFileSync(join(ROOT, 'package', 'lib', 'index.cjs'), 'utf8')), false)

const clientSource = readFileSync(join(ROOT, 'package', 'lib', 'client.cjs'), 'utf8')
check('client bundle has no ESM exports', /^\s*export\s/m.test(clientSource), false)
check('client bundle registers via __ModuleLoader__', clientSource.includes('window.__ModuleLoader__.load('), true)

const patch = readFileSync(join(ROOT, 'package', 'cordis.patch.yml'), 'utf8')
check('patch inserts this package by name', /name: dsh-model-caps/.test(patch), true)

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
