import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const en = readFileSync(join(ROOT, 'README.md'), 'utf8')
const zh = readFileSync(join(ROOT, 'README.zh.md'), 'utf8')
for (const needle of ['dsh-model-caps', 'node verify.mjs', 'dsh plugin --profile web add ./package', 'models.dev']) {
  check(`english readme mentions ${needle}`, en.includes(needle), true)
  check(`chinese readme mentions ${needle}`, zh.includes(needle), true)
}
check('the english readme has no requirement to edit settings.yaml by hand for caps',
  /hand-written values stay|already wrote/i.test(en), true)

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
