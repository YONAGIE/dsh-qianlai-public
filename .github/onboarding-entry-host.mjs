import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { completeOnboarding, fields } from './pdf-onboarding-cards.mjs'

const cli = resolve(process.argv[2])
const plugin = fileURLToPath(new URL('../packages/dsh-qianlai', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'qianlai-onboarding-entry-'))
const home = join(root, 'home')
const preload = join(root, 'synthetic-replies.mjs')
const modelCalls = join(root, 'model.jsonl')
const statusReplies = new Map()
const replyText = '好的，我先帮您理清这件事，再接着准备企业资料。'
const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'sk-synthetic-onboarding-entry', NO_PROXY: '127.0.0.1,localhost' }
delete env.DEEPSEEK_BASE_URL
delete env.MONEYCOME_WECHAT
writeFileSync(preload, [
  "import { appendFileSync } from 'node:fs'",
  "const original = globalThis.fetch",
  "globalThis.fetch = async (target, init) => {",
  "  const url = new URL(target instanceof Request ? target.url : target)",
  "  if (url.hostname !== 'api.deepseek.com') return original(target, init)",
  "  appendFileSync(" + JSON.stringify(modelCalls) + ", JSON.stringify({ pathname: url.pathname }) + '\\n')",
  "  if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model' }, { id: 'deepseek-reasoner', object: 'model' }, { id: 'deepseek-v4-flash', object: 'model' }, { id: 'deepseek-v4.1-flash', object: 'model' }] })",
  "  const raw = init?.body === undefined && target instanceof Request ? await target.text() : String(init?.body ?? '')",
  "  const body = JSON.parse(raw)",
  "  const setupContext = raw.includes('这家公司还未开始建档。') || raw.includes('企业已有未完成的建档草稿。')",
  "  appendFileSync(" + JSON.stringify(modelCalls) + ", JSON.stringify({ setupContext }) + '\\n')",
  "  const basics = { id: 'synthetic-onboarding-turn', created: 1, model: body.model }",
  "  const fixture = " + JSON.stringify(fields),
  "  let text = " + JSON.stringify(replyText),
  "  if (raw.includes('你是资料字段识别程序')) {",
  "    const kind = /SyntheticAcceptance:(license|tax|bank)/.exec(raw)?.[1]",
  "    if (!kind) throw Error('Expected text extracted from a generated acceptance PDF')",
  "    text = JSON.stringify(fixture[kind])",
  "  }",
  "  if (url.pathname.endsWith('/messages')) {",
  "    const message = { id: basics.id, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } }",
  "    if (!body.stream) return Response.json({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } })",
  "    const events = [",
  "      { type: 'message_start', message },",
  "      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },",
  "      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },",
  "      { type: 'content_block_stop', index: 0 },",
  "      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },",
  "      { type: 'message_stop' },",
  "    ]",
  "    return new Response(events.map(event => 'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })",
  "  }",
  "  if (!url.pathname.endsWith('/chat/completions')) throw Error('Unexpected synthetic model endpoint ' + url.pathname)",
  "  const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }",
  "  if (!body.stream) return Response.json({ ...basics, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage })",
  "  const stub = [{ delta: { role: 'assistant', content: '' }, finish_reason: null }, { delta: { content: text }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]",
  "  const frames = stub.map(choice => 'data: ' + JSON.stringify({ ...basics, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }], usage }) + '\\n\\n')",
  "  return new Response(frames.join('') + 'data: [DONE]\\n\\n', { headers: { 'Content-Type': 'text/event-stream' } })",
  "}",
].join('\n'))

async function until(check, description, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(200)
  }
  throw Error(description)
}

let child
let log = ''
try {
  const installation = spawnSync(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', 'link:' + plugin],
    { env, encoding: 'utf8', timeout: 130_000 })
  assert.equal(installation.status, 0, installation.stderr || installation.stdout)
  child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
    { env: { ...env, NODE_OPTIONS: '--import=' + pathToFileURL(preload).href } })
  child.stdout.on('data', bytes => { log += bytes })
  child.stderr.on('data', bytes => { log += bytes })
  const login = await until(() => /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(log)?.[0], 'DSH server did not start')
  const unlocked = await fetch(login, { redirect: 'manual' })
  const cookie = unlocked.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const base = login.split('/?')[0]

  async function call(method, input, direct = false) {
    const response = await fetch(base + '/api/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: direct ? input : { args: { request: input } } }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await response.json()
    assert.notEqual(data.result?.ok, false, JSON.stringify(data))
    return data.result?.value ?? data.value
  }

  const created = await call('session/create', { agentPreset: 'moneycome-zhangjie', cwd: root })
  console.log('Created preset:', created.agentPreset ?? '(not returned)')
  const { sessionId } = created
  assert(sessionId)
  const onboarding = (action, extra = {}) => call('qianlai/company-onboarding', { action, sessionId, ...extra }, true)
  async function completeTurn(text, turns, entry) {
    await call('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] })
    return until(async () => {
      for (const turn of turns) {
        const state = await onboarding('entry-status', { turn })
        statusReplies.set(turn, state)
        if (state?.entry === entry) return { turn }
      }
    }, 'No completed user reply with onboarding entry ' + entry)
  }

  const { turn } = await completeTurn('我这里有点乱，先帮我捋一下。', [1, 0], 'start')
  assert(existsSync(modelCalls) && readFileSync(modelCalls, 'utf8').includes('"setupContext":true'), 'No live onboarding context reached the model')
  if (process.env.PDF_TEST_BROWSER === '1') {
    const { checkOnboardingBrowser } = await import('./pdf-browser.mjs')
    await checkOnboardingBrowser({ loginUrl: login, sessionId, cookie, replyText })
    console.log('PASS: actual browser, first reply followed by start button, mode card at left and editable company panel at right')
  } else {
    const start = await onboarding('open-entry', { turn })
    assert.equal(start.accepted, true)
    assert.equal(start.card.kind, 'mode')
    const selected = await onboarding('submit-card', { cardId: start.card.id, draftId: start.card.draftId,
      revision: start.card.revision, mode: 'manual' })
    assert.equal(selected.accepted, true)
    const later = await completeTurn('等一下，先把前面说的事情记在心里。', [turn + 1], 'continue')
    assert.equal((await onboarding('entry-status', { turn })).entry, null)
    assert.equal((await onboarding('open-entry', { turn: later.turn })).card.kind, 'document')
    console.log('PASS: real DSH model context, completed reply, direct setup action, resumed draft and stale-reply guard')
    const require = createRequire(join(plugin, 'package.json'))
    await completeOnboarding(onboarding, later.turn, require('pdf-lib'))
    assert(child.kill(), 'Could not stop the isolated DSH host')
    await until(() => child.exitCode !== null || child.signalCode !== null, 'DSH host did not exit')
    const booked = spawnSync(process.execPath, [
      fileURLToPath(new URL('./pdf-accounting.mjs', import.meta.url)),
      plugin,
      join(home, 'moneycome', 'book.sqlite'),
    ], { env, stdio: 'inherit', timeout: 90_000 })
    assert.equal(booked.status, 0, booked.error?.message ?? 'Accounting validation failed')
  }
} catch (error) {
  console.error(log.replace(/([?&]token=)[\w-]+/g, '$1[redacted]').slice(-6500))
  console.error('Model requests:', existsSync(modelCalls) ? readFileSync(modelCalls, 'utf8').slice(-2500) : 'none')
  console.error('Onboarding states:', JSON.stringify([...statusReplies]))
  const dir = join(home, 'sessions')
  if (existsSync(dir)) {
    for (const file of readdirSync(dir, { recursive: true }).filter(file => String(file).endsWith('session.v4.jsonl.zstd'))) {
      try {
        const body = zstdDecompressSync(readFileSync(join(dir, file))).toString('utf8')
        const records = body.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
        console.error('Session events:', JSON.stringify(records.map(({ type, data, agentPreset }) => ({
          type, turn: data?.turn, source: data?.source?.kind ?? data?.message?.source?.kind,
          preset: agentPreset ?? data?.agentPreset ?? data?.meta?.agentPreset,
          reason: data?.reason?.kind, parts: (data?.content ?? data?.message?.content)?.map?.(part => part.type),
        })).slice(-34)))
      } catch (decodeError) { console.error(String(decodeError)) }
    }
  }
  throw error
} finally {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill()
    await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)])
  }
  rmSync(root, { recursive: true, force: true })
}
