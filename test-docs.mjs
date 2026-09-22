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
for (const needle of ['dsh-model-caps', 'node verify.mjs', 'dsh plugin --profile web add ./package', 'models.dev', 'DESIGN.md']) {
  check(`english readme mentions ${needle}`, en.includes(needle), true)
}
check('english readme mentions eight suites', en.includes('8 suites'), true)
for (const needle of ['dsh-model-caps', 'node verify.mjs', 'dsh plugin --profile web add ./package', 'models.dev', 'DESIGN.zh.md']) {
  check(`chinese readme mentions ${needle}`, zh.includes(needle), true)
}
check('chinese readme mentions eight suites', zh.includes('8 个套件'), true)
const designEn = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')
const designZh = readFileSync(join(ROOT, 'DESIGN.zh.md'), 'utf8')
check('english design names the OpenAI default track', /default track is OpenAI-compatible/i.test(designEn), true)
check('chinese design names the OpenAI default track', /默认轨是 OpenAI/.test(designZh), true)
check('design states one api per custom route', /one `api`/i.test(designEn) && /一种 `api`/.test(designZh), true)
check('the english readme has no requirement to edit settings.yaml by hand for caps',
  /hand-written values stay|already wrote/i.test(en), true)

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
