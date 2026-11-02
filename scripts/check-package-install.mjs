import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Explicit local delivery check; no DSH credentials, model, or real WeChat.
const repository = fileURLToPath(new URL('../', import.meta.url))
const manager = process.env.npm_execpath
if (!manager || !/pnpm/i.test(manager)) throw Error('Run with pnpm test:packages after pnpm pack:all.')
const manifests = ['fintax-core', 'dsh-qianlai'].map(name => JSON.parse(readFileSync(join(repository, 'packages', name, 'package.json'), 'utf8')))
const archives = manifests.map(manifest => join(repository, 'dist', `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`))
for (const archive of archives) assert(existsSync(archive), 'Missing archive: run pnpm pack:all first.')
const root = mkdtempSync(join(tmpdir(), 'qianlai-package-check-'))
const fileDependency = path => `file:${path.replaceAll('\\', '/')}`
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'synthetic-package-consumer', private: true, type: 'module',
    dependencies: Object.fromEntries(manifests.map((manifest, index) => [manifest.name, fileDependency(archives[index])])),
  }, null, 2))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), [
    'packages: []', 'autoInstallPeers: false', 'strictPeerDependencies: false',
    `cacheDir: ${JSON.stringify(join(root, 'cache'))}`, 'overrides:',
    `  '@moneycome/fintax-core': ${JSON.stringify(fileDependency(archives[0]))}`, '',
  ].join('\n'))
  const env = { ...process.env, DSH_HOME: join(root, 'home'), TEMP: root, TMP: root, TMPDIR: root }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEEK_BASE_URL
  delete env.MONEYCOME_WECHAT
  // Keep pnpm's default supply-chain policies. Normal registry metadata may be
  // fetched; this is not an offline-install claim. Lifecycle scripts are off.
  const jsManager = /\.[cm]?js$/i.test(manager)
  execFileSync(jsManager ? process.execPath : manager, [...(jsManager ? [manager] : []), 'install', '--ignore-scripts', '--store-dir', join(root, 'store'), '--state-dir', join(root, 'state')], {
    cwd: root, env, stdio: 'pipe', windowsHide: true, timeout: 120_000,
  })
  assert(!existsSync(join(root, 'node_modules', 'xlsx')))
  const installedRequire = createRequire(join(root, 'package.json'))
  const pluginRoot = dirname(installedRequire.resolve('dsh-qianlai/package.json'))
  const installedManifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  assert.equal(installedManifest.dependencies.xlsx, undefined)
  assert.equal(installedManifest.dependencies['@moneycome/fintax-core'], manifests[0].version)
  const XLSX = createRequire(join(repository, 'packages/dsh-qianlai/package.json'))('xlsx')
  const officialRoot = dirname(createRequire(join(repository, 'packages/dsh-qianlai/package.json')).resolve('xlsx'))
  assert(readFileSync(join(pluginRoot, 'lib/vendor/xlsx.cjs')).equals(readFileSync(join(officialRoot, 'dist/xlsx.full.min.js'))))
  assert(readFileSync(join(pluginRoot, 'lib/vendor/xlsx.LICENSE')).equals(readFileSync(join(officialRoot, 'LICENSE'))))
  assert(existsSync(join(pluginRoot, 'LICENSE')))
  assert(existsSync(join(pluginRoot, 'assets/zhangjie/NOTICE.md')))
  for (const extension of ['xls', 'xlsx']) {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['日期', '金额', '说明'], ['2026-01-10', '1287.13', '合成中文']]), '合成表')
    writeFileSync(join(root, `synthetic.${extension}`), XLSX.write(book, { type: 'buffer', bookType: extension === 'xls' ? 'biff8' : 'xlsx' }))
  }
  writeFileSync(join(root, 'probe.mjs'), `
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from 'dsh-qianlai'
import * as wechat from 'dsh-qianlai/wechat'
const tools = new Map()
let dispose = () => {}
try {
  apply({ effect: fn => { dispose = fn() }, tools: { register: tool => { tools.set(tool.name, tool); return () => {} } } })
  assert.equal((await tools.get('moneycome_book_status').execute({})).isSampleBook, true)
  const attachments = join(process.env.DSH_HOME, 'attachments')
  mkdirSync(attachments, { recursive: true })
  for (const extension of ['xls', 'xlsx']) {
    const path = join(attachments, 'synthetic.' + extension)
    copyFileSync('synthetic.' + extension, path)
    const result = await tools.get('moneycome_read_upload').execute({ path })
    assert.equal(result.accepted, true)
    assert.deepEqual(result.rows[1].cells, ['2026-01-10', '1287.13', '合成中文'])
  }
  const path = join(attachments, 'synthetic.csv')
  writeFileSync(path, 'date,amount\\n2026-01-10,10.00')
  assert.equal((await tools.get('moneycome_read_upload').execute({ path })).accepted, true)
  assert.equal(typeof wechat.apply, 'function')
  console.log(JSON.stringify({ installedTools: tools.size, sampleBook: true, csv: true, xls: true, xlsx: true, wechatImport: true }))
} finally { dispose() }
`)
  const result = execFileSync(process.execPath, ['probe.mjs'], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  process.stdout.write(result)
} finally {
  const withinTemp = relative(tmpdir(), root)
  assert(withinTemp && !withinTemp.startsWith(`..${sep}`) && withinTemp !== '..' && !withinTemp.includes(sep))
  rmSync(root, { recursive: true, force: true })
}
