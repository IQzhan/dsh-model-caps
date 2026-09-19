import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

function shippedFiles() {
  const named = [
    'dsh-model-caps-core.js', 'dsh-model-caps-sync.js', 'dsh-model-caps.host.js',
    'dsh-model-caps.client.js', 'build-model-caps.mjs', 'run-tests.mjs',
    'package.json', 'README.md', 'README.zh.md', 'LICENSE', 'test-support.mjs',
  ]
  const missing = named.filter((name) => !existsSync(join(ROOT, name)))
  check('every named file is actually there', missing, [])
  const files = named.filter((name) => existsSync(join(ROOT, name))).map((name) => join(ROOT, name))
  for (const entry of readdirSync(ROOT)) {
    if (entry.startsWith('test-') && entry.endsWith('.mjs')) files.push(join(ROOT, entry))
  }
  for (const artifact of [
    'package/lib/index.cjs', 'package/lib/client.cjs',
    'package/package.json', 'package/cordis.patch.yml',
  ]) {
    if (existsSync(join(ROOT, artifact))) files.push(join(ROOT, artifact))
  }
  return [...new Set(files)]
}

const files = shippedFiles()
check('the guard actually looks at the shipped files', files.length > 8, true)

const WINDOWS_PATH = /[A-Za-z]:\\[A-Za-z0-9_.\- ]+(?:\\[A-Za-z0-9_.\- ]+)+|[A-Za-z]:\/(?!\/)[A-Za-z0-9_.\- ]+(?:\/[A-Za-z0-9_.\- ]+)+/
const POSIX_PATH = /\/(?:Users|home|tmp|var\/folders)\//

const pathOffenders = []
const tempOffenders = []
const windowsOffenders = []
const cjkOffenders = []
for (const file of files) {
  const name = file.slice(ROOT.length + 1)
  if (name.endsWith('test-portability.mjs')) continue
  if (statSync(file).isDirectory()) continue
  const text = readFileSync(file, 'utf8')
  const cjkTarget = name === 'dsh-model-caps-core.js'
    || name === 'dsh-model-caps-sync.js'
    || name === 'dsh-model-caps.host.js'
    || name === 'build-model-caps.mjs'
    || name === 'package/lib/index.cjs'
  text.split('\n').forEach((line, index) => {
    if (WINDOWS_PATH.test(line) || POSIX_PATH.test(line)) pathOffenders.push(`${name}:${index + 1}`)
    if (/\btmpdir\s*\(/.test(line) || /process\.env\.USERPROFILE/.test(line)) {
      tempOffenders.push(`${name}:${index + 1}`)
    }
    if (/'junction'/.test(line) && !/process\.platform/.test(line)) {
      windowsOffenders.push(`${name}:${index + 1}`)
    }
    if (cjkTarget && /[\u3040-\u30ff\u3400-\u9fff]/.test(line)) cjkOffenders.push(`${name}:${index + 1}`)
  })
}

check('no absolute path from any machine', pathOffenders, [])
check('no system temp directory and no Windows-only home variable', tempOffenders, [])
check('no platform-specific symlink type outside a platform switch', windowsOffenders, [])
check('host sources have no CJK', cjkOffenders, [])

const build = readFileSync(join(ROOT, 'build-model-caps.mjs'), 'utf8')
check('the build chooses its link type per platform',
  /process\.platform === 'win32' \? 'junction' : 'dir'/.test(build), true)

const licence = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
check('the licence is MIT', licence.startsWith('MIT License'), true)
check('and it is in English', /[\u4e00-\u9fff]/.test(licence), false)

const runtime = [
  readFileSync(join(ROOT, 'dsh-model-caps-core.js'), 'utf8'),
  readFileSync(join(ROOT, 'dsh-model-caps-sync.js'), 'utf8'),
  readFileSync(join(ROOT, 'dsh-model-caps.host.js'), 'utf8'),
].join('\n')
check('runtime never shells out to powershell / schtasks / taskkill',
  /powershell|pwsh|schtasks|taskkill/i.test(runtime), false)

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
