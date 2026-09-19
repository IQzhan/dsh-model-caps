import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SUITES = [
  ['test-core.mjs', 'policy: listings, catalog agreement, settings ops'],
  ['test-sync.mjs', 'sync: credentials, listing failure, no second write'],
  ['test-host.mjs', 'adapter: apply return, route, one fill'],
  ['test-package.mjs', 'package: both loaders'],
  ['test-client.mjs', 'settings section: locale keys, no top-level React'],
  ['test-docs.mjs', 'docs: both readmes name the install'],
  ['test-portability.mjs', 'portability: no absolute path, no Windows-only path'],
]

const rows = []
let failed = 0
for (const [file, label] of SUITES) {
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const tally = /(\d+)\/(\d+) passed/.exec(output)
  const ok = run.status === 0 && tally !== null
  if (!ok) failed += 1
  rows.push({ file, label, ok, output, tally: tally === null ? `crashed (exit ${String(run.status)})` : tally[0] })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${tally === null ? output : tally[0]}`)
  if (!ok) console.log(output)
}

const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8')
const zh = readFileSync(new URL('./README.zh.md', import.meta.url), 'utf8')
const suiteNote = `${String(SUITES.length)} suites`
const zhNote = `${String(SUITES.length)} 个套件`
if (!readme.includes(suiteNote) || !zh.includes(zhNote)) {
  console.log(`FAIL  readmes must mention "${suiteNote}" / "${zhNote}"`)
  failed += 1
}

console.log(`\n${String(SUITES.length - rows.filter((row) => !row.ok).length)}/${String(SUITES.length)} suites passed`)
process.exit(failed > 0 ? 1 : 0)
