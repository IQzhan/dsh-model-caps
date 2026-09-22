import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const DOCS = ['README.md', 'README.zh.md', 'DESIGN.md', 'DESIGN.zh.md']
check('core docs exist', DOCS.filter((name) => !existsSync(join(ROOT, name))), [])

const en = readFileSync(join(ROOT, 'README.md'), 'utf8')
const zh = readFileSync(join(ROOT, 'README.zh.md'), 'utf8')
const sections = (text) => [...text.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim())
const fences = (text) => [...text.matchAll(/^```(\S*)$/gm)].map((match) => match[1])
const tableRows = (text) => text.split('\n').filter((line) => line.trimStart().startsWith('|')).length

check('the two languages have the same number of sections', sections(en).length, sections(zh).length)
check('and the same code blocks', fences(en), fences(zh))
check('and the same tables', tableRows(en), tableRows(zh))
check('the English file links to the Chinese one', /README\.zh\.md/.test(en.split('\n').slice(0, 6).join('\n')), true)
check('the Chinese file links to the English one', /README\.md/.test(zh.split('\n').slice(0, 6).join('\n')), true)

for (const command of [
  'node build-model-caps.mjs',
  'node verify.mjs',
  'dsh plugin --profile web add ./package',
  'dsh plugin --profile web add dsh-model-caps',
  'dsh plugin --profile web update dsh-model-caps',
  'git pull && node build-model-caps.mjs',
  'node publish-via-actions.mjs 1.0.1',
]) {
  check(`both languages document \`${command}\``, [en.includes(command), zh.includes(command)], [true, true])
}

check('both languages link DESIGN', [en.includes('DESIGN.md'), zh.includes('DESIGN.zh.md')], [true, true])
check('both languages embed the model menu screenshot', [
  en.includes('docs/images/models.png'),
  zh.includes('docs/images/models.png'),
], [true, true])
check('both languages embed the thinking menu screenshot', [
  en.includes('docs/images/thinking.png'),
  zh.includes('docs/images/thinking.png'),
], [true, true])
check('screenshot files exist', [
  existsSync(join(ROOT, 'docs', 'images', 'models.png')),
  existsSync(join(ROOT, 'docs', 'images', 'thinking.png')),
], [true, true])
check('publish workflow exists', existsSync(join(ROOT, '.github', 'workflows', 'publish.yml')), true)
check('publish helper exists', existsSync(join(ROOT, 'publish-via-actions.mjs')), true)
check('both languages state the licence', [/MIT/.test(en), /MIT/.test(zh)], [true, true])

const designEn = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')
const designZh = readFileSync(join(ROOT, 'DESIGN.zh.md'), 'utf8')
check('english design names the OpenAI default track', /default track is OpenAI-compatible/i.test(designEn), true)
check('chinese design names the OpenAI default track', /默认轨是 OpenAI/.test(designZh), true)
check('design states one api per custom route', /one `api`/i.test(designEn) && /一种 `api`/.test(designZh), true)

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
