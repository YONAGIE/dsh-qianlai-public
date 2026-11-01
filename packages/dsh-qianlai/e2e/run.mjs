#!/usr/bin/env node
/**
 * 真模型场景测试：每个场景一个全新的 DSH_HOME，按剧本和张姐对话，再核对她调了哪些工具、说了什么、账本里落了什么。
 *
 *   DEEPSEEK_API_KEY=… node e2e/run.mjs              跑全部场景
 *   DEEPSEEK_API_KEY=… node e2e/run.mjs invoice-bad  只跑名字里带这段的场景
 *
 * 环境变量：DSH_BIN（默认 dsh）、E2E_OUT（记录放哪，默认系统临时目录）、E2E_JOBS（同时跑几个，默认 3）、
 * E2E_PORT（起始端口，默认 8900）、E2E_REPEAT（每个场景跑几遍，看模型表现稳不稳，默认 1）。读会话记录要用系统的 zstd 命令。会真调 DeepSeek，不进 CI；企业、发票、流水全部是编的。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { scenarios } from './scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = dirname(here)
const fixtures = join(here, 'fixtures')
const DSH_PREFIX = process.env.DSH_ENTRY ? [resolve(process.env.DSH_ENTRY)] : []
const DSH = process.env.DSH_BIN ?? (DSH_PREFIX.length ? process.execPath : 'dsh')
const approvalMode = process.env.E2E_APPROVAL_MODE
if (approvalMode && !['allow', 'reject'].includes(approvalMode)) throw Error('E2E_APPROVAL_MODE must be allow or reject; omit it for normal interactive approval.')
const OUT = process.env.E2E_OUT ?? join(tmpdir(), `dsh-qianlai-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const JOBS = Number(process.env.E2E_JOBS ?? 3)
let nextPort = Number(process.env.E2E_PORT ?? 8900)
if (!Number.isSafeInteger(JOBS) || JOBS < 1 || JOBS > 10 || !Number.isSafeInteger(nextPort) || nextPort < 1 || nextPort > 65535)
  throw Error('E2E_JOBS must be 1–10 and E2E_PORT must be 1–65535.')

if (process.argv.includes('--list')) {
  console.log(scenarios.map(scenario => scenario.name).join('\n'))
  process.exit(0)
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('要先设 DEEPSEEK_API_KEY。')
  process.exit(2)
}
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost' }
delete env.DEEPSEEK_BASE_URL

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startDsh(home, ws, port) {
  execFileSync(DSH, [...DSH_PREFIX, 'plugin', '--profile', 'web', 'add', `link:${pkgDir}`], { cwd: ws, env: { ...env, DSH_HOME: home }, stdio: 'ignore', windowsHide: true, timeout: 180_000 })
  const patchArgs = []
  if (approvalMode) {
    const runId = crypto.randomUUID()
    writeFileSync(join(home, '.synthetic-e2e-home'), runId)
    const patch = join(home, 'synthetic-approval.patch.yml')
    writeFileSync(patch, JSON.stringify([{ insert: [{ id: 'synthetic-e2e-approval',
      name: pathToFileURL(join(here, 'approval-fixture.mjs')).href, config: { mode: approvalMode, home, runId } }] }]))
    patchArgs.push('--patch', patch)
  }
  const child = spawn(DSH, [...DSH_PREFIX, '--profile', 'web', ...patchArgs, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: ws,
    env: { ...env, DSH_HOME: home },
    windowsHide: true,
  })
  let out = ''
  let spawnError
  child.on('error', error => { spawnError = error })
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  for (let i = 0; i < 120; i++) {
    const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(out)
    if (m) return { child, url: m[0], log: () => out }
    if (child.exitCode !== null || spawnError) break
    await sleep(500)
  }
  child.kill()
  throw new Error(`DSH 没起来：${spawnError?.message ?? ''}\n${out.slice(-2000)}`)
}

function client(url) {
  const base = url.split('/?')[0]
  let cookie = ''
  // 带 token 的地址会种一个 cookie 再跳转；不跟跳转，cookie 才拿得到。
  const init = fetch(url, { redirect: 'manual' }).then((r) => {
    cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  })
  const call = async (method, request) => {
    await init
    const body = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }
    const r = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    return r.json()
  }
  const upload = async (sessionId, path) => {
    await init
    const q = new URLSearchParams({ sessionId, name: basename(path) })
    const r = await fetch(`${base}/api/session/uploadFileBinary?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', cookie },
      body: readFileSync(path),
    })
    const json = await r.json()
    return json.value.receiptId
  }
  return { call, upload }
}

function findSessionFile(dir, sessionId) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findSessionFile(p, sessionId)
      if (found) return found
    } else if (entry.name === 'session.v4.jsonl.zstd' && p.includes(sessionId)) return p
  }
  return undefined
}

function readEvents(home, sessionId) {
  const file = existsSync(join(home, 'sessions')) ? findSessionFile(join(home, 'sessions'), sessionId) : undefined
  if (!file) return []
  // 会话记录是一帧一帧追加的 zstd，Node 自带的解压只认第一帧，所以用 zstd 命令。
  // 正在写的最后一帧可能不完整，只取能解析的整行。
  // Read through Node and pass bytes on stdin: some Windows zstd builds cannot open Unicode filenames.
  const decoded = spawnSync(process.env.ZSTD_BIN ?? 'zstd', ['-dc'], { input: readFileSync(file), encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 })
  if (decoded.error) throw Error('zstd unavailable; set ZSTD_BIN to an installed executable.')
  const text = decoded.stdout ?? ''
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      break
    }
  }
  return events
}

/** 某一轮的工具调用、工具结果和她最后说的话。 */
function turnView(events, turn) {
  const calls = []
  const results = []
  let say = ''
  let reason
  for (const e of events) {
    const d = e.data ?? {}
    if (d.turn !== turn) continue
    if (e.type === 'assistant/message')
      for (const c of d.message?.content ?? []) {
        if (c.type === 'tool-call') calls.push({ name: c.name, args: c.arguments })
        else if (c.type === 'text' && c.text.trim()) say = c.text
      }
    if (e.type === 'tool/result') for (const c of d.message?.content ?? []) if (c.type === 'text') results.push(c.text)
    if (e.type === 'turn/end') reason = d.reason?.kind
  }
  return { calls, results, say, reason }
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])

/** 一条调用是否命中规则：规则是工具名，或 {tool, args: 正则, unless: 正则}。 */
function matches(rule, call) {
  const r = typeof rule === 'string' ? { tool: rule } : rule
  if (call.name !== r.tool) return false
  if (r.args && !r.args.test(call.args)) return false
  if (r.unless && r.unless.test(call.args)) return false
  return true
}

function judgeTurn(expect, view) {
  const failures = []
  for (const rule of asList(expect.calls))
    if (!view.calls.some((c) => matches(rule, c))) failures.push(`该调没调：${JSON.stringify(rule, regexToString)}`)
  for (const rule of asList(expect.noCalls))
    if (view.calls.some((c) => matches(rule, c))) failures.push(`不该调却调了：${JSON.stringify(rule, regexToString)}`)
  for (const re of asList(expect.says)) if (!re.test(view.say)) failures.push(`回复里没有 ${re}`)
  for (const re of asList(expect.notSays)) if (re.test(view.say)) failures.push(`回复里不该有 ${re}`)
  if (view.reason !== 'completed') failures.push(`这一轮没正常结束：${view.reason}`)
  return failures
}

function regexToString(_k, v) {
  return v instanceof RegExp ? String(v) : v
}

async function runScenario(s) {
  const dir = join(OUT, s.name)
  const home = join(dir, 'home')
  const ws = join(dir, 'ws')
  if (existsSync(home) && readdirSync(home).length) throw Error('Scenario home already contains data; choose a fresh E2E_OUT.')
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const port = nextPort++
  const transcript = [`# ${s.name}\n\n${s.description}\n`]
  const failures = []
  const dsh = await startDsh(home, ws, port)
  try {
    const { call, upload } = client(dsh.url)
    const created = JSON.stringify(await call('session/create', { agentPreset: 'moneycome-zhangjie', cwd: ws }))
    const sessionId = (/"sessionId":"([^"]+)"/.exec(created) ?? /"id":"(session-[^"]+)"/.exec(created))[1]
    for (const [i, turn] of s.turns.entries()) {
      const content = [{ type: 'text', text: turn.say }]
      for (const name of asList(turn.image))
        content.push({ type: 'image', mediaType: 'image/png', data: readFileSync(join(fixtures, name)).toString('base64'), name })
      for (const name of asList(turn.file)) content.push({ type: 'file', receiptId: await upload(sessionId, join(fixtures, name)) })
      await call('session/prompt', { sessionId, requestId: crypto.randomUUID(), mode: 'queue', clientTimeZone: 'Asia/Shanghai', content })
      let events = []
      for (let w = 0; w < 600; w++) {
        events = readEvents(home, sessionId) ?? events
        if (events.filter((e) => e.type === 'turn/end').length > i) break
        await sleep(1000)
      }
      const view = turnView(events, i + 1)
      const turnFailures = judgeTurn(turn.expect ?? {}, view)
      failures.push(...turnFailures.map((f) => `第 ${i + 1} 轮：${f}`))
      transcript.push(`## 第 ${i + 1} 轮\n\n**老板**：${turn.say}${turn.image ? `（图：${asList(turn.image).join('、')}）` : ''}${turn.file ? `（文件：${asList(turn.file).join('、')}）` : ''}\n`)
      for (const c of view.calls) transcript.push(`- 调用 \`${c.name}\` ${c.args.slice(0, 400)}`)
      transcript.push(`\n**张姐**：${view.say}\n`)
      if (turnFailures.length) transcript.push(`> 未通过：${turnFailures.join('；')}\n`)
    }
  } finally {
    dsh.child.kill('SIGTERM')
    for (let i = 0; i < 40 && dsh.child.exitCode === null; i++) await sleep(250)
    writeFileSync(join(dir, 'dsh.log'), dsh.log())
  }

  const bookPath = join(home, 'moneycome', 'book.sqlite')
  if (s.book?.length) {
    const db = new DatabaseSync(bookPath, { readOnly: true })
    for (const check of s.book) {
      const value = db.prepare(check.sql).get()
      const got = value ? Object.values(value)[0] : undefined
      const ok = got === check.equals
      if (!ok) failures.push(`账本：${check.what}，期望 ${check.equals}，实际 ${got}`)
      transcript.push(`- 账本核对 ${ok ? '通过' : '未通过'}：${check.what}（期望 ${check.equals}，实际 ${got}）`)
    }
    db.close()
  }
  writeFileSync(join(dir, 'transcript.md'), transcript.join('\n') + '\n')
  return { name: s.name, failures }
}

const filter = process.argv.slice(2)
const repeat = Number(process.env.E2E_REPEAT ?? 1)
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) throw Error('E2E_REPEAT must be 1–100.')
const chosen = scenarios
  .filter(s => !s.requiredApprovalMode || s.requiredApprovalMode === approvalMode)
  .filter((s) => filter.length === 0 || filter.some((f) => s.name.includes(f)))
  .flatMap((s) => (repeat > 1 ? Array.from({ length: repeat }, (_, i) => ({ ...s, name: `${s.name}-${i + 1}` })) : [s]))
if (!chosen.length) throw Error('No matching scenarios; use --list to inspect names.')
mkdirSync(OUT, { recursive: true })
console.log(`跑 ${chosen.length} 个场景，记录在 ${OUT}`)
const queue = [...chosen]
const results = []
await Promise.all(
  Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try {
        const r = await runScenario(s)
        results.push(r)
        console.log(`${r.failures.length ? '未通过' : '通过'}  ${s.name}${r.failures.map((f) => `\n    ${f}`).join('')}`)
      } catch (error) {
        results.push({ name: s.name, failures: [String(error)] })
        console.log(`出错  ${s.name}\n    ${error}`)
      }
    }
  }),
)
const failed = results.filter((r) => r.failures.length)
writeFileSync(
  join(OUT, 'summary.md'),
  `# 场景测试结果\n\n${results.map((r) => `- ${r.failures.length ? '未通过' : '通过'} ${r.name}${r.failures.map((f) => `\n  - ${f}`).join('')}`).join('\n')}\n`,
)
console.log(`\n${results.length - failed.length}/${results.length} 通过。逐轮记录见 ${OUT}/<场景>/transcript.md`)
process.exit(failed.length ? 1 : 0)
