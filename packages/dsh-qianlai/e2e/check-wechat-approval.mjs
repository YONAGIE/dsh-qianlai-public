// Paid real-model/real-DSH check. Only iLink is synthetic; no real WeChat account.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { openBook, setOpeningBalances } from '../lib/book.js'
import { loadPack } from '../lib/pack.js'
import { BookStore } from '../lib/store.js'

if (!process.env.DEEPSEEK_API_KEY || !process.env.DSH_ENTRY) throw Error('Supply DEEPSEEK_API_KEY and DSH_ENTRY; this check calls the real model.')
const cli = resolve(process.env.DSH_ENTRY)
const executable = process.env.DSH_BIN ?? process.execPath
const plugin = fileURLToPath(new URL('../', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'qianlai-wechat-approval-'))
const home = join(root, 'home'), stateDir = join(home, 'moneycome')
const bookPath = join(stateDir, 'book.sqlite')
const marker = join(root, 'synthetic-delivery.json')
const preload = join(root, 'synthetic-ilink.mjs')
mkdirSync(stateDir, { recursive: true })
const store = new BookStore(bookPath)
try {
  openBook(store, { companyName: '合成微信批准企业', accountingStartMonth: '2026-01' })
  setOpeningBalances(store, loadPack(), [], new Date())
} finally { store.close() }
writeFileSync(join(stateDir, 'wechat.json'), JSON.stringify({ botToken: 'synthetic-test-token', ownerUserId: 'synthetic-owner', welcomePending: false, welcomeProgress: 4, welcomeId: 'synthetic-complete' }))
writeFileSync(marker, '{}')
writeFileSync(preload, `
import { renameSync, writeFileSync } from 'node:fs'
const realFetch = globalThis.fetch
let stage = 0, waiting, sequence = 0
const queue = ['2026年1月10日银行扣手续费10元。只预演，不要入账。']
const deliver = () => {
  if (!waiting || !queue.length) return
  const resolve = waiting; waiting = undefined
  resolve(Response.json({ ret: 0, get_updates_buf: 'synthetic-cursor-' + ++sequence,
    msgs: [{ message_type: 1, from_user_id: 'synthetic-owner', context_token: 'synthetic-context',
      msg_id: 'synthetic-message-' + sequence, item_list: [{ text_item: { text: queue.shift() } }] }] }))
}
globalThis.fetch = async (url, init) => {
  const parsed = new URL(url instanceof Request ? url.url : url)
  if (parsed.hostname !== 'ilinkai.weixin.qq.com') return realFetch(url, init)
  if (parsed.pathname.endsWith('/getupdates')) return new Promise((resolve, reject) => {
    waiting = resolve
    const abort = () => { if (waiting === resolve) waiting = undefined; reject(Object.assign(Error('aborted'), { name: 'AbortError' })) }
    if (init.signal.aborted) abort()
    else init.signal.addEventListener('abort', abort, { once: true })
    deliver()
  })
  if (parsed.pathname.endsWith('/sendtyping')) return Response.json({ ret: 0 })
  if (parsed.pathname.endsWith('/sendmessage')) {
    const text = JSON.parse(init.body).msg.item_list[0].text_item.text
    const code = /确认 ([A-F0-9]{12})/.exec(text)?.[1]
    if (stage === 0 && !code) { stage = 1; queue.push('确认按预演记账。'); deliver() }
    else if (stage === 1 && code) { stage = 2; queue.push('确认 ' + code); deliver() }
    else if (stage === 2 && !code) { stage = 3 }
    writeFileSync(${JSON.stringify(marker + '.tmp')}, JSON.stringify({ stage }))
    renameSync(${JSON.stringify(marker + '.tmp')}, ${JSON.stringify(marker)})
    return Response.json({ message_id: 'synthetic-sent' })
  }
  throw Error('Unexpected synthetic iLink endpoint')
}
`)
const env = { ...process.env, DSH_HOME: home, MONEYCOME_WECHAT: '1', NO_PROXY: '127.0.0.1,localhost' }
delete env.DEEPSEEK_BASE_URL
const clean = text => String(text).split(process.env.DEEPSEEK_API_KEY).join('[REDACTED]').replace(/([?&]token=)[^\s"'<>]+/g, '$1[REDACTED]')
let child
let log = ''
let closed = false
try {
  const installed = spawnSync(executable, [cli, 'plugin', '--profile', 'web', 'add', 'link:' + plugin], { env, encoding: 'utf8', windowsHide: true, timeout: 180_000 })
  assert.equal(installed.status, 0, clean(installed.stderr || installed.stdout))
  child = spawn(executable, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() }, windowsHide: true,
  })
  let spawnError
  child.once('close', () => { closed = true })
  child.on('error', error => { spawnError = error })
  child.stdout.on('data', bytes => { log += bytes })
  child.stderr.on('data', bytes => { log += bytes })
  const deadline = Date.now() + 180_000
  let result
  while (Date.now() < deadline && !closed && !spawnError) {
    const delivery = JSON.parse(readFileSync(marker, 'utf8'))
    const db = new DatabaseSync(bookPath, { readOnly: true })
    try {
      const vouchers = Number(db.prepare('SELECT count(*) AS n FROM voucher').get().n)
      if (delivery.stage < 2) assert.equal(vouchers, 0, 'Ledger changed before native owner approval')
      if (delivery.stage === 3) {
        const receipts = Number(db.prepare('SELECT count(*) AS n FROM tool_receipt').get().n)
        const amount = Number(db.prepare("SELECT sum(amount_cents) AS cents FROM voucher_leg WHERE direction = 'debit'").get().cents)
        assert.equal(vouchers, 1)
        assert.equal(receipts, 1)
        assert.equal(amount, 1000)
        result = { realDsh: true, realModel: true, syntheticIlink: true, ownerNonceConsumed: true, vouchers, receipts, cents: amount }
        break
      }
    } finally { db.close() }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert(result, clean('Native WeChat approval did not complete: ' + (spawnError?.message ?? '') + '\n' + log.slice(-1600)))
  console.log(JSON.stringify(result))
} finally {
  if (child && !closed) {
    child.kill()
    await new Promise(resolve => { if (closed) resolve(); else child.once('close', resolve) })
  }
  const own = relative(tmpdir(), root)
  assert(own && own !== '..' && !own.startsWith('..' + sep) && !own.includes(sep))
  rmSync(root, { recursive: true, force: true })
}
