// Paid real DSH/model acceptance of explicit desktop -> WeChat handoff.
// Only iLink/CDN are synthetic. No real account and no automatic approval.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (!process.env.DEEPSEEK_API_KEY || !process.env.DSH_ENTRY) throw Error('Supply DEEPSEEK_API_KEY and DSH_ENTRY; calls the real model.')
const plugin = fileURLToPath(new URL('../', import.meta.url))
const cli = resolve(process.env.DSH_ENTRY), node = process.env.DSH_BIN ?? process.execPath
const root = mkdtempSync(join(tmpdir(), 'qianlai-real-onboarding-'))
const repeat = Number(process.env.E2E_REPEAT ?? 1)
assert(Number.isSafeInteger(repeat) && repeat >= 1 && repeat <= 10)
const clean = text => String(text).split(process.env.DEEPSEEK_API_KEY).join('[REDACTED]').replace(/([?&]token=)[^\s"'<>]+/g, '$1[REDACTED]')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
const processes = new Set()
function eventFile(dir, sessionId) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, item.name)
    if (item.isDirectory()) { const found = eventFile(p, sessionId); if (found) return found }
    else if (item.name === 'session.v4.jsonl.zstd' && p.includes(sessionId)) return p
  }
}
function events(home, sessionId) {
  const file = eventFile(join(home, 'sessions'), sessionId)
  if (!file) return []
  const decoded = spawnSync(process.env.ZSTD_BIN ?? 'zstd', ['-dc'], { input: readFileSync(file), encoding: 'utf8', windowsHide: true })
  if (decoded.error) throw decoded.error
  const records = []
  for (const line of decoded.stdout.split('\n')) { if (!line) continue; try { records.push(JSON.parse(line)) } catch { break } }
  return records
}
async function until(test, message, timeout = 180_000) {
  const end = Date.now() + timeout
  do { if (await test()) return; await sleep(100) } while (Date.now() < end)
  throw Error(message)
}
async function start(home, preload) {
  const child = spawn(node, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_HOME: home, NO_PROXY: '127.0.0.1,localhost', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, windowsHide: true,
  })
  processes.add(child)
  let log = '', error
  child.on('error', value => { error = value })
  child.on('close', () => processes.delete(child))
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  await until(() => /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.test(log) || error || child.exitCode !== null, 'DSH startup timed out', 60_000)
  const url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(log)?.[0]
  assert(url, clean(error?.message ?? log.slice(-1800)))
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const base = url.split('/?')[0]
  const call = async (method, request, direct = false) => {
    const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: direct ? request : { args: { request } } }), signal: AbortSignal.timeout(30_000) })
    return response.json()
  }
  return { child, call }
}
async function stop(child) {
  if (child.exitCode !== null) return
  child.kill()
  await until(() => !processes.has(child), 'Synthetic host did not stop', 15_000)
}
try {
  for (let run = 1; run <= repeat; run++) for (const requireContext of [false, true]) {
    const dir = join(root, `${run}-${requireContext ? 'context-required' : 'context-free'}`), home = join(dir, 'home')
    const stateDir = join(home, 'moneycome'), delivery = join(dir, 'delivery.json'), preload = join(dir, 'synthetic-ilink.mjs')
    mkdirSync(stateDir, { recursive: true }); writeFileSync(delivery, '[]')
    writeFileSync(preload, `
import {readFileSync,writeFileSync,renameSync} from 'node:fs'
const original=globalThis.fetch;let incoming,sequence=0,hello=false
const release=()=>{if(incoming){const done=incoming;incoming=undefined;done(Response.json({ret:0,get_updates_buf:'synthetic-'+ ++sequence,msgs:[{message_type:1,msg_id:'synthetic-hello',from_user_id:'synthetic-owner',context_token:'synthetic-context',item_list:[{type:1,text_item:{text:'你好'}}]}]}))}}
globalThis.fetch=async(url,init)=>{
 const p=new URL(url instanceof Request?url.url:url)
 if(!['ilinkai.weixin.qq.com','novac2c.cdn.weixin.qq.com'].includes(p.hostname))return original(url,init)
 if(p.pathname.endsWith('/get_bot_qrcode'))return Response.json({ret:0,qrcode:'synthetic-qr',qrcode_img_content:'https://example.invalid/synthetic'})
 if(p.pathname.endsWith('/get_qrcode_status'))return Response.json({status:'confirmed',bot_token:'synthetic-token',ilink_user_id:'synthetic-owner'})
 if(p.pathname.endsWith('/getupdates'))return new Promise((resolve,reject)=>{incoming=resolve;const fail=()=>reject(Object.assign(Error('cancelled'),{name:'AbortError'}));if(init.signal.aborted)fail();else init.signal.addEventListener('abort',fail,{once:true})})
 if(p.pathname.endsWith('/getuploadurl'))return Response.json({upload_full_url:'https://novac2c.cdn.weixin.qq.com/synthetic-upload'})
 if(p.hostname==='novac2c.cdn.weixin.qq.com')return new Response('',{headers:{'x-encrypted-param':'synthetic-image'}})
 if(p.pathname.endsWith('/sendtyping'))return Response.json({ret:0})
 if(p.pathname.endsWith('/sendmessage')){
  const msg=JSON.parse(init.body).msg
  if(${requireContext}&&!msg.context_token){if(!hello){hello=true;setTimeout(release,25)}return Response.json({ret:-2,errmsg:'synthetic context required'})}
  const all=JSON.parse(readFileSync(${JSON.stringify(delivery)},'utf8'));all.push({id:msg.client_id,items:msg.item_list});writeFileSync(${JSON.stringify(delivery + '.tmp')},JSON.stringify(all));renameSync(${JSON.stringify(delivery + '.tmp')},${JSON.stringify(delivery)});return Response.json({ret:0})
 }
 throw Error('Unexpected synthetic endpoint')
}
`)
    const env = { ...process.env, DSH_HOME: home, NO_PROXY: '127.0.0.1,localhost' }
    delete env.DEEPSEEK_BASE_URL
    const installed = spawnSync(node, [cli, 'plugin', '--profile', 'web', 'add', 'link:' + plugin], { env, encoding: 'utf8', windowsHide: true, timeout: 180_000 })
    assert.equal(installed.status, 0, clean(installed.stderr || installed.stdout))
    const dsh = await start(home, preload)
    const created = await dsh.call('session/create', { agentPreset: 'moneycome-zhangjie', cwd: dir })
    const sourceId = created.value?.sessionId ?? created.result?.value?.sessionId
    assert(sourceId, JSON.stringify(created))
    const desktopRequest = '稍后我想核对2026年三月利润。现在只讨论这个计划，先不要查询利润，不保存笔记，不记账，也不要开自己的账。'
    await dsh.call('session/prompt', { sessionId: sourceId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: desktopRequest }] })
    await until(() => events(home, sourceId).some(event => event.type === 'turn/end'), 'Desktop discussion did not complete')
    const desktopReply = events(home, sourceId).filter(event => event.type === 'assistant/message').at(-1)?.data?.message?.content.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
    const bookPath = join(stateDir, 'book.sqlite')
    const before = new DatabaseSync(bookPath, { readOnly: true })
    const vouchers = Number(before.prepare('SELECT count(*) AS n FROM voucher').get().n)
    const work = Number(before.prepare('SELECT count(*) AS n FROM work_event').get().n)
    before.close()
    assert.equal(work, 0, 'Discussion unexpectedly changed business progress')
    const login = await dsh.call('qianlai/wechat', { action: 'start', sessionId: sourceId }, true)
    assert.equal(login.result?.ok, true)
    await until(() => JSON.parse(readFileSync(delivery, 'utf8')).some(item => item.id.startsWith('mc-handoff-')), 'No model-generated proactive handoff')
    const sent = JSON.parse(readFileSync(delivery, 'utf8'))
    const welcome = sent.filter(item => item.id.startsWith('mc-welcome-'))
    const handoff = sent.filter(item => item.id.startsWith('mc-handoff-'))
    assert.deepEqual(welcome.map(item => item.items[0].type), [1, 2, 2, 2])
    assert.equal(handoff.length, 1)
    const text = handoff[0].items.map(item => item.text_item?.text ?? '').join('\n')
    assert.match(text, /三月|3\s*月|2026-03/)
    // The full visible message is emitted for human review of factual status
    // and continuation intent. "Tell me to start" is also a valid invitation;
    // no keyword or question-mark heuristic substitutes for that review.
    const after = new DatabaseSync(bookPath, { readOnly: true })
    assert.equal(Number(after.prepare('SELECT count(*) AS n FROM voucher').get().n), vouchers)
    assert.equal(Number(after.prepare('SELECT count(*) AS n FROM work_event').get().n), work)
    assert.equal(Number(after.prepare('SELECT is_sample FROM company').get().is_sample), 1)
    after.close()
    const state = JSON.parse(readFileSync(join(stateDir, 'wechat.json'), 'utf8'))
    assert.equal(state.desktopHandoff.sourceSessionId, sourceId)
    assert.equal(state.desktopHandoff.phase, 'complete')
    await stop(dsh.child)
    const restarted = await start(home, preload)
    await sleep(750)
    assert.equal(JSON.parse(readFileSync(delivery, 'utf8')).filter(item => item.id.startsWith('mc-handoff-')).length, 1)
    await stop(restarted.child)
    const result = { run, realDsh: true, realModel: true, syntheticIlink: true, requireContext, welcomeParts: 4, desktopRequest, desktopReply, handoff: text, semanticReviewRequired: true, restartedWithoutDuplicate: true, ledgerUnchanged: true }
    results.push(result); console.log(JSON.stringify(result))
  }
} finally {
  for (const child of [...processes]) await stop(child)
  if (process.env.E2E_OUT) {
    mkdirSync(process.env.E2E_OUT, { recursive: true })
    writeFileSync(join(process.env.E2E_OUT, 'onboarding-results.json'), JSON.stringify(results, null, 2))
  }
  assert(root.startsWith(join(tmpdir(), 'qianlai-real-onboarding-')))
  rmSync(root, { recursive: true, force: true })
}
