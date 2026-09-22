/**
 * build-model-caps.mjs — assemble the installable package from one source.
 *
 * Outputs:
 *   package/                 dsh plugin add ./package
 *     package.json
 *     cordis.patch.yml
 *     lib/index.cjs          Host (core + sync + adapter)
 *     lib/client.cjs         ModuleLoader wrapper
 *
 * The build strips exports and relative imports. It does not transpile.
 */
import { mkdir, readFile, rm, symlink, writeFile, readlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = 'dsh-model-caps'
const VERSION = process.env.DSH_MODEL_CAPS_VERSION || '1.0.0'
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'
const OUT_PACKAGE = join(here, 'package')

const CORE = join(here, 'dsh-model-caps-core.js')
const SYNC = join(here, 'dsh-model-caps-sync.js')
const HOST = join(here, 'dsh-model-caps.host.js')
const CLIENT = join(here, 'dsh-model-caps.client.js')

function stripExportBlock(source, label) {
  const match = /^export\s*\{([\s\S]*?)\}\s*;?\s*$/m.exec(source)
  if (match === null) throw new Error(`build: ${label} has no trailing export block to strip`)
  return source.replace(match[0], '')
}

function stripNamedExports(source) {
  return source
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+\{[\s\S]*?\}\s*;?\s*$/m, '')
    .trim()
}

function assertImportFree(source, label) {
  const found = /^\s*import\s.+$/m.exec(source)
  if (found !== null) {
    throw new Error(`build: ${label} must not import (found "${found[0].trim()}")`)
  }
}

function dropCoreImport(source) {
  return source.replace(/^import\s*\{[\s\S]*?\}\s*from\s+'\.\/dsh-model-caps-core\.js'\s*$/m, '')
}

function clientExportNames(source) {
  const names = []
  for (const match of source.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

function wrapClient(clientSource) {
  const body = stripNamedExports(clientSource)
  return [
    `'use strict'`,
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(PLUGIN_NAME)},`,
    '  factory: (require) => {',
    '    var module = { exports: {} }',
    '    var exports = module.exports',
    body.split('\n').map((line) => (line.length === 0 ? line : `    ${line}`)).join('\n'),
    '    exports.apply = apply',
    '    exports.inject = inject',
    ...clientExportNames(clientSource)
      .filter((name) => name !== 'apply' && name !== 'inject')
      .map((name) => `    exports.${name} = ${name}`),
    '    exports.default = module.exports',
    '    return module.exports',
    '  },',
    '})',
  ].join('\n')
}

const banner = `/**
 * ${PLUGIN_NAME} — GENERATED FILE, DO NOT EDIT.
 * Assembled by build-model-caps.mjs. Edit the sources and re-run the build.
 */`

const [coreSource, syncSource, hostSource, clientSource] = await Promise.all([
  readFile(CORE, 'utf8'),
  readFile(SYNC, 'utf8'),
  readFile(HOST, 'utf8'),
  readFile(CLIENT, 'utf8'),
])

assertImportFree(hostSource, 'dsh-model-caps.host.js')
assertImportFree(clientSource, 'dsh-model-caps.client.js')

const coreBody = stripExportBlock(coreSource, 'dsh-model-caps-core.js').trim()
const syncBody = dropCoreImport(stripExportBlock(syncSource, 'dsh-model-caps-sync.js')).trim()
const hostBody = stripExportBlock(hostSource, 'dsh-model-caps.host.js').trim()

const hostModule = [
  banner,
  `'use strict'`,
  coreBody,
  syncBody,
  hostBody,
  'const plugin = {',
  `  name: ${JSON.stringify(PLUGIN_NAME)},`,
  '  inject: [],',
  '  apply(ctx) { return mountModelCaps(ctx) },',
  '}',
  'module.exports = plugin',
  'module.exports.default = plugin',
].join('\n\n')

const clientModule = [banner, wrapClient(clientSource)].join('\n')

const manifest = {
  name: PLUGIN_NAME,
  version: VERSION,
  description: 'Fill blank context windows, output caps, thinking levels, and thinking wire compat for custom DeepSeek Harness providers.',
  type: 'commonjs',
  main: './lib/index.cjs',
  exports: {
    '.': { default: './lib/index.cjs' },
    './client': { default: './lib/client.cjs' },
    './package.json': './package.json',
  },
  files: [
    'lib',
    'cordis.patch.yml',
    'README.md',
  ],
  repository: {
    type: 'git',
    url: 'git+https://github.com/IQzhan/dsh-model-caps.git',
  },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web',
      immediately: false,
      inject: [],
      external: ['react'],
    },
  },
  engines: { node: '>=24' },
  license: 'MIT',
}

const bundlePatch = `# ${PLUGIN_NAME} bundle patch.
#
# Declared as \`dsh.bundle.patch\`, so \`dsh plugin --profile web add <this
# package>\` appends the bundle and the profile boot merges this layer.
- insert:
    - id: ${PLUGIN_NAME}
      name: ${PLUGIN_NAME}
`

await mkdir(OUT_PACKAGE, { recursive: true })
await rm(join(OUT_PACKAGE, 'lib'), { recursive: true, force: true })
await rm(join(OUT_PACKAGE, 'cordis.patch.yml'), { force: true })
await mkdir(join(OUT_PACKAGE, 'lib'), { recursive: true })
await writeFile(join(OUT_PACKAGE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(join(OUT_PACKAGE, 'README.md'), [
  '# dsh-model-caps',
  '',
  'Fill blank context windows, output caps, thinking levels, and thinking wire compat for custom DeepSeek Harness providers.',
  '',
  '```bash',
  'dsh plugin --profile web add dsh-model-caps',
  '```',
  '',
  'Then restart `dsh web`. Requires Node 24 or newer. See the repository README and DESIGN.md.',
  '',
].join('\n'), 'utf8')
await writeFile(join(OUT_PACKAGE, 'cordis.patch.yml'), bundlePatch, 'utf8')
await writeFile(join(OUT_PACKAGE, 'lib', 'index.cjs'), `${hostModule}\n`, 'utf8')
await writeFile(join(OUT_PACKAGE, 'lib', 'client.cjs'), `${clientModule}\n`, 'utf8')

const lines = (source) => source.split('\n').length
console.log(`built ${join('package', 'lib', 'index.cjs')}  (${lines(hostModule)} lines)`)
console.log(`built ${join('package', 'lib', 'client.cjs')} (${lines(clientModule)} lines)`)

async function linkIntoProfile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const profile of ['web', 'headless']) {
    const dir = join(home, 'profiles', profile)
    if (!existsSync(join(dir, 'cordis.patch.yml'))) continue
    const modules = join(dir, 'node_modules')
    await mkdir(modules, { recursive: true })
    const link = join(modules, PLUGIN_NAME)
    const existing = await readlink(link).catch(() => undefined)
    if (existing !== undefined) {
      if (existing === OUT_PACKAGE) return { link, fresh: false }
      await rm(link, { recursive: true, force: true })
    } else if (existsSync(link)) {
      await rm(link, { recursive: true, force: true })
    }
    await symlink(OUT_PACKAGE, link, LINK_TYPE)
    return { link, fresh: true }
  }
  return undefined
}

try {
  const linked = await linkIntoProfile()
  if (linked === undefined) {
    console.log('no profile with a cordis.patch.yml found; link package/ into a profile yourself')
  } else {
    console.log(`${linked.fresh ? 'linked' : 'already linked'} profile node_modules/${PLUGIN_NAME}`)
    console.log('Next (once per profile):')
    console.log('  dsh plugin --profile web add ./package')
    console.log('  then restart dsh web')
  }
} catch (error) {
  console.log(`profile link skipped: ${error instanceof Error ? error.message : error}`)
}
