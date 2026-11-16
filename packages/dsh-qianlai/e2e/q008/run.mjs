#!/usr/bin/env node
// Q-008 独立测试材料；只使用 Node 内置模块，不向插件添加组件或工具。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suite = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'))
const variants = JSON.parse(readFileSync(join(here, 'personas.json'), 'utf8')).variants
const sha = value => createHash('sha256').update(value).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const toolNames = ['working_directory', ...['add_evidence', 'book_status', 'check_invoice', 'close_period', 'closing_check', 'export_review_pack', 'financial_statements', 'import_statement', 'link_statement', 'list_vouchers', 'open_book', 'posting_guide', 'quarter_filing_prep', 'read_balances', 'read_profit', 'read_upload', 'record_entry', 'rename_bank_account', 'reverse_voucher', 'set_company_facts', 'set_opening_balances', 'unrecorded_statement_lines', 'upcoming', 'void_voucher'].map(name => 'moneycome_' + name)].sort()

function scrub(value, secret = '', locations = []) {
  let text = String(value)
  if (secret) text = text.split(secret).join('[REDACTED]')
  for (const location of [...locations].sort((a, b) => b.length - a.length)) {
    for (const spelling of [location, location.replaceAll('\\', '/')]) text = text.split(spelling).join('[LOCAL_PATH]')
  }
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/([?&]token=)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/session-[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[SESSION_ID]')
    .replace(/wxid_[A-Za-z0-9_]+/g, '[ACCOUNT_ID]')
    .replace(/[A-Za-z]:[\\/][^\s"'<>，。；：）】\]“”‘’`]+/g, '[LOCAL_PATH]')
    .replace(/\/(?:Users|home|tmp|private|mnt|var\/folders)\/[^\s"'<>，。；：）】\]“”‘’`]+/g, '[LOCAL_PATH]')
}

function options(argv) {
  const result = { cases: 'S03,S05,S08', variants: 'baseline,accepted', repeat: 1 }
  const flags = new Set(['validate', 'list', 'dry-run', 'check-environment', 'live', 'help'])
  const values = new Set(['cases', 'variants', 'repeat', 'out', 'dsh-entry', 'dsh-node', 'plugin', 'zstd-bin'])
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '')
    if (!argv[i].startsWith('--')) throw Error('参数必须使用 --name 格式')
    if (flags.has(name)) result[name] = true
    else if (values.has(name) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[name] = argv[++i]
    else throw Error('未知或缺少值的参数：' + name)
  }
  result.repeat = Number(result.repeat)
  if (!Number.isInteger(result.repeat) || result.repeat < 1 || result.repeat > 100) throw Error('repeat 必须是 1—100 的整数')
  return result
}

function validate() {
  assert.equal(suite.schemaVersion, 1)
  assert.equal(suite.cases.length, new Set(suite.cases.map(item => item.id)).size)
  assert.equal(suite.presetId, 'moneycome-zhangjie')
  for (const item of suite.cases) {
    assert.match(item.id, /^[A-Z]\d{2}$/)
    assert.ok(item.turns.length)
    for (const turn of item.turns) {
      assert.equal(typeof turn.say, 'string')
      assert.ok(turn.say.length)
      assert.ok(!turn.repeatConsecutively || Number.isInteger(turn.repeatConsecutively) && turn.repeatConsecutively > 0)
      for (const id of turn.uploads || []) assert.ok(suite.fixtures.some(fixture => fixture.id === id))
    }
  }
  for (const fixture of suite.fixtures) {
    assert.equal(fixture.filename, fixture.filename.split(/[\\/]/).at(-1))
    assert.equal(typeof fixture.content, 'string')
  }
  for (const check of suite.bookChecks) assert.match(check.sql, /^SELECT /i)
  for (const variant of variants) {
    assert.match(variant.sourceCommit, /^[0-9a-f]{40}$/)
    assert.equal(variant.preset.id, suite.presetId)
    assert.equal(variant.preset.plugins.length, 2)
    assert.equal(variant.preset.plugins.find(row => row.id === 'moneycome-tools').name, 'dsh-qianlai')
    assert.equal(typeof variant.preset.plugins.find(row => row.id === 'persona').config.prefix, 'string')
  }
  const canary = randomUUID()
  const cleaned = scrub(canary + ' C:\\Users\\Example\\private.txt ?token=' + canary, canary)
  assert.ok(!cleaned.includes(canary) && !cleaned.includes('Example'))
  const sample = visible([{ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'thinking', text: 'not-exported' }, { type: 'text', text: 'visible-only' }, { type: 'tool-call', name: 'allowed-name', arguments: 'not-exported' }] } } }], 1)
  assert.equal(sample.reply, 'visible-only')
  assert.deepEqual(sample.tools, ['allowed-name'])
  assert.ok(!JSON.stringify(sample).includes('not-exported'))
  const evidence = JSON.parse(readFileSync(join(here, 'evidence.json'), 'utf8'))
  for (const example of evidence.examples) {
    assert.deepEqual(Object.keys(example).sort(), ['variant', 'sourceCommit', 'caseId', 'repeat', 'status', 'issues', 'turns'].sort())
    for (const turn of example.turns) assert.deepEqual(Object.keys(turn).sort(), ['turn', 'input', 'reply', 'tools', 'completion'].sort())
  }
  const manifest = join(here, 'privacy-review.json')
  if (existsSync(manifest)) {
    const review = JSON.parse(readFileSync(manifest, 'utf8'))
    assert.equal(review.hashEncoding, 'utf8-lf')
    assert.deepEqual(readdirSync(here).sort(), [...Object.keys(review.sha256), 'privacy-review.json'].sort(), '发布目录包含未审查文件')
    for (const [file, expected] of Object.entries(review.sha256)) {
      assert.ok(!isAbsolute(file) && !file.split(/[\\/]/).includes('..'))
      assert.equal(sha(readFileSync(join(here, file), 'utf8').replace(/\r\n/g, '\n')), expected, '发布材料哈希不一致：' + file)
    }
  }
  console.log(JSON.stringify({ materialValidation: 'passed', cases: suite.cases.length, variants: variants.map(item => item.id), networkRequests: 0 }))
}

function visible(events, turn) {
  const result = { reply: '', tools: [], completion: null }
  for (const event of events) {
    const data = event.data || {}
    if (data.turn !== turn) continue
    if (event.type === 'assistant/message') for (const content of data.message?.content || []) {
      if (content.type === 'text' && content.text.trim()) result.reply = content.text
      if (content.type === 'tool-call') result.tools.push(content.name)
    }
    if (event.type === 'turn/end') result.completion = data.reason?.kind
  }
  return result
}

function sessionFile(folder, id) {
  if (!existsSync(folder)) return undefined
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name)
    if (entry.isDirectory()) { const found = sessionFile(file, id); if (found) return found }
    else if (entry.name === 'session.v4.jsonl.zstd' && file.includes(id)) return file
  }
}

function readEvents(file, binary) {
  if (!file) return []
  // Node 读取路径后经 stdin 交给 zstd，兼容不支持 Unicode 文件名的 Windows zstd。
  const result = spawnSync(binary, ['-dc'], { input: readFileSync(file), encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 })
  if (result.error) throw Error('无法运行 zstd；请安装后放入 PATH 或设置 --zstd-bin')
  // 日志可能仍在追加；只读取已完整写入的 JSON 行，不输出解压 stderr。
  return (result.stdout || '').split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100)
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function runOne(item, variant, repeat, config) {
  const dir = join(config.out, variant.id, item.id, String(repeat).padStart(3, '0'))
  const home = join(dir, 'private-home'), workspace = join(dir, 'workspace'), temp = join(dir, 'temp')
  for (const folder of [home, workspace, temp]) mkdirSync(folder, { recursive: true })
  const locations = [dir, config.out, config.plugin, config.entry, home, workspace]
  const clean = value => scrub(value, config.key, locations)
  const save = (name, value) => writeFileSync(join(dir, name), clean(JSON.stringify(value, null, 2)) + '\n')
  const env = { ...process.env, DSH_HOME: home, MONEYCOME_WECHAT: '0', NO_PROXY: '127.0.0.1,localhost', TEMP: temp, TMP: temp, TMPDIR: temp, npm_config_cache: join(config.out, 'cache/npm') }
  delete env.DEEPSEEK_BASE_URL
  const prefix = ['--expose-internals', config.entry]
  const result = { variant: variant.id, personaSourceCommit: variant.sourceCommit, caseId: item.id, repeat, modelRequested: suite.model, turns: [], environment: null, bookChecks: [], manualReview: 'pending', error: null }
  let child, log = ''
  try {
    if (!config.environmentOnly) {
      // Keep the archived prompts and expected figures independent of the plugin's startup defaults.
      const [{ BookStore }, { loadPack }, { seedSampleBook }] = await Promise.all(['store', 'pack', 'sample-book']
        .map(name => import(pathToFileURL(join(config.plugin, 'lib', name + '.js')).href)))
      const store = new BookStore(join(home, 'moneycome', 'book.sqlite'))
      try { assert.equal(seedSampleBook(store, loadPack(), new Date()), true) }
      finally { store.close() }
    }
    const installed = spawnSync(config.node, [...prefix, 'plugin', '--profile', 'web', 'add', 'link:' + config.plugin], { cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
    if (installed.status !== 0) throw Error('插件安装失败：' + clean((installed.stderr || installed.stdout || '').slice(-1600)))
    // JSON 是合法 YAML；只替换现有 preset 和模型配置，不增删宿主组件。
    const patch = join(dir, 'private-test.patch.yml')
    writeFileSync(patch, JSON.stringify([{ id: 'agent-default-model', config: suite.model }, { id: 'preset-moneycome-zhangjie', config: variant.preset }], null, 2))
    child = spawn(config.node, [...prefix, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: workspace, env, windowsHide: true })
    child.on('error', error => { log += '\n' + error.message })
    child.stdout.on('data', value => { log += value })
    child.stderr.on('data', value => { log += value })
    let url
    for (let i = 0; i < 180; i++) {
      url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(log)?.[0]
      if (url || child.exitCode !== null) break
      await sleep(500)
    }
    if (!url || /did not activate|failed to import/.test(log)) throw Error('DSH 启动或插件激活失败：' + clean(log.slice(-1600)))
    const base = url.split('/?')[0]
    const opened = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) })
    const cookie = opened.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    async function call(method, request) {
      const response = await fetch(base + '/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }), signal: AbortSignal.timeout(30000) })
      const body = await response.json()
      if (!response.ok || body.error) throw Error('DSH RPC 失败：' + method + '；' + clean(JSON.stringify(body)))
      return body
    }
    const created = JSON.stringify(await call('session/create', { agentPreset: suite.presetId, cwd: workspace }))
    const id = /"sessionId":"([^"]+)"/.exec(created)?.[1] || /"id":"(session-[^"]+)"/.exec(created)?.[1]
    if (!id) throw Error('DSH 未返回会话 ID')
    if (config.environmentOnly) { result.environment = { hostReady: true, presetCreated: true, modelCalled: false }; return result }
    const turns = item.turns.flatMap(turn => Array.from({ length: turn.repeatConsecutively || 1 }, () => turn))
    let file
    for (const [index, turn] of turns.entries()) {
      const content = [{ type: 'text', text: turn.say.replaceAll('{{MISSING_PATH}}', join(workspace, 'not-existing-finance-note.txt')) }]
      for (const fixtureId of turn.uploads || []) {
        const fixture = suite.fixtures.find(value => value.id === fixtureId)
        const query = new URLSearchParams({ sessionId: id, name: fixture.filename })
        const uploaded = await fetch(base + '/api/session/uploadFileBinary?' + query, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie }, body: fixture.content, signal: AbortSignal.timeout(30000) })
        const body = await uploaded.json()
        if (!uploaded.ok || !body.value?.receiptId) throw Error('合成 TXT 上传失败')
        content.push({ type: 'file', receiptId: body.value.receiptId })
      }
      await call('session/prompt', { sessionId: id, requestId: randomUUID(), mode: 'queue', clientTimeZone: 'Asia/Shanghai', content })
      let events = [], done = false
      for (let wait = 0; wait < 360; wait++) {
        file ||= sessionFile(join(home, 'sessions'), id)
        events = readEvents(file, config.zstd)
        if (events.some(event => event.type === 'turn/end' && event.data?.turn === index + 1)) { done = true; break }
        if (child.exitCode !== null) throw Error('DSH 在测试轮次中退出')
        await sleep(1000)
      }
      if (!done) throw Error('模型轮次超时：' + (index + 1))
      const view = visible(events, index + 1)
      if (view.completion !== 'completed') throw Error('模型轮次未正常完成：' + view.completion)
      result.turns.push({ turn: index + 1, input: turn.say, kind: turn.kind, ...view })
      if (index === 0) {
        const header = events.find(event => event.type === 'request/header')?.data?.header
        const tools = (header?.tools || []).map(tool => tool.name).sort()
        const system = events.filter(event => event.type === 'system/message').flatMap(event => (event.data?.message?.content || []).filter(content => content.type === 'text').map(content => content.text)).join('\n')
        const persona = variant.preset.plugins.find(row => row.id === 'persona').config
        const actual = header?.config || {}
        const runtime = events.filter(event => event.type === 'user/message').map(event => JSON.stringify(event.data)).join('\n')
        const acceptedSuffix = variants.find(value => value.id === 'accepted').preset.plugins.find(row => row.id === 'persona').config.suffix
        result.environment = { model: { provider: actual.provider, model: actual.model, reasoningEffort: actual.reasoningEffort }, tools, toolSetMatches: JSON.stringify(tools) === JSON.stringify(toolNames), personaMatches: system.includes(persona.prefix.trim()) && (!persona.suffix || system.includes(persona.suffix.trim())), permissionContextMatches: runtime.includes('workspace-write'), baselineUncontaminated: variant.id !== 'baseline' || !system.includes(acceptedSuffix.trim()), systemSha256: sha(system), node: process.version }
        if (!result.environment.toolSetMatches || !result.environment.personaMatches || !result.environment.permissionContextMatches || !result.environment.baselineUncontaminated || Object.keys(suite.model).some(key => actual[key] !== suite.model[key])) throw Error('测试环境与冻结模型、人设、权限或工具集不一致；本轮不能计入人设结果')
      }
      save('visible.json', result)
      console.log(JSON.stringify({ variant: variant.id, caseId: item.id, repeat, turn: index + 1, completed: true }))
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(home, 'moneycome/book.sqlite'), { readOnly: true })
    try {
      result.bookChecks = suite.bookChecks.map(check => { const actual = Object.values(db.prepare(check.sql).get() || {})[0]; return { sql: check.sql, expected: check.equals, actual, passed: actual === check.equals } })
      if (result.bookChecks.some(check => !check.passed)) throw Error('合成样本账检查未通过')
    } finally { db.close() }
  } catch (error) { result.error = clean(error.message) }
  finally { await stop(child); save('visible.json', result) }
  return result
}

async function main() {
  const args = options(process.argv.slice(2))
  if (args.validate) return validate()
  if (args.list) return console.log(suite.cases.map(item => item.id + '\t' + item.title).join('\n'))
  if (args.help || !args.live && !args['dry-run'] && !args['check-environment']) {
    console.log('先阅读 README.md。\n离线检查：node run.mjs --validate\n查看场景：node run.mjs --list\n预览计划：node run.mjs --dry-run --cases S03,S05 --variants baseline,accepted --repeat 20\n环境检查：--check-environment --dsh-entry <lib/bin.js> --plugin <已构建插件目录> --out <新目录>\n真模型执行：--live --dsh-entry <lib/bin.js> --plugin <已构建插件目录> --out <新目录> [--cases ... --variants ... --repeat 1]\nAPI Key 只从 DEEPSEEK_API_KEY 环境变量读取，不读取本机凭据。')
    return
  }
  const chosen = args.cases.split(',').map(id => suite.cases.find(item => item.id === id))
  const selectedVariants = args.variants.split(',').map(id => variants.find(item => item.id === id))
  if (chosen.some(item => !item) || selectedVariants.some(item => !item)) throw Error('未知场景或人设版本')
  if (new Set(chosen.map(item => item.id)).size !== chosen.length || new Set(selectedVariants.map(item => item.id)).size !== selectedVariants.length) throw Error('场景和版本不允许重复，避免复用测试现场')
  const plan = selectedVariants.flatMap(variant => chosen.map(item => ({ variant: variant.id, caseId: item.id, repeats: args.repeat, turnsPerRun: item.turns.reduce((sum, turn) => sum + (turn.repeatConsecutively || 1), 0) })))
  if (args['dry-run']) return console.log(JSON.stringify({ plan, modelCalls: plan.reduce((sum, item) => sum + item.repeats * item.turnsPerRun, 0), executed: false }, null, 2))
  if (!args.out || !args['dsh-entry'] || !args.plugin) throw Error('必须显式指定 --out、--dsh-entry、--plugin')
  const config = { out: resolve(args.out), entry: realpathSync.native(resolve(args['dsh-entry'])), node: args['dsh-node'] ? resolve(args['dsh-node']) : process.execPath, plugin: realpathSync.native(resolve(args.plugin)), zstd: args['zstd-bin'] || process.env.ZSTD_BIN || 'zstd', key: process.env.DEEPSEEK_API_KEY || '', environmentOnly: Boolean(args['check-environment']) }
  const parent = resolve(config.plugin, '..', '..')
  const packagePath = existsSync(join(parent, 'pnpm-workspace.yaml')) ? parent : config.plugin
  const rel = relative(packagePath, config.out)
  if (rel === '' || !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)) throw Error('输出目录必须位于插件源码目录之外')
  if (existsSync(config.out)) throw Error('输出目录已存在，拒绝覆盖或复用旧账本')
  if (!config.environmentOnly) {
    if (!config.key.trim()) throw Error('真模型执行需要 DEEPSEEK_API_KEY 环境变量')
    if (spawnSync(config.zstd, ['--version'], { windowsHide: true, stdio: 'ignore' }).status !== 0) throw Error('zstd 不可用；设置 --zstd-bin 或 ZSTD_BIN')
  }
  if (!existsSync(join(config.plugin, 'lib/index.js'))) throw Error('插件未构建；请先执行 pnpm install 和 pnpm build')
  mkdirSync(config.out)
  const results = []
  for (let repeat = 1; repeat <= (config.environmentOnly ? 1 : args.repeat); repeat++) {
    for (const item of config.environmentOnly ? [chosen[0]] : chosen) for (const variant of selectedVariants) {
      const result = await runOne(item, variant, repeat, config)
      results.push(result)
      writeFileSync(join(config.out, 'summary.json'), scrub(JSON.stringify({ model: suite.model, materialCasesSha256: sha(readFileSync(join(here, 'cases.json'), 'utf8').replace(/\r\n/g, '\n')), results, note: '退出 0 仅说明环境、轮次和样本账检查完成；人设语义需按 review.md 人工复核。private-home、workspace、temp 均为私有测试现场，不属于可分享材料。' }, null, 2), config.key, [config.out, config.plugin, config.entry]) + '\n')
      if (result.error) throw Error(result.error)
    }
  }
  console.log(JSON.stringify({ completedRuns: results.length, manualReview: config.environmentOnly ? 'not-applicable' : 'pending', modelCalled: !config.environmentOnly }))
}

main().catch(error => { console.error(scrub(error.message, process.env.DEEPSEEK_API_KEY || '')); process.exitCode = 1 })
