import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { loginControl, registerLoginRpc } from '../src/wechat/control.js'
import { apply } from '../src/wechat/index.js'
import { BookStore } from '../src/store.js'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const json = (value: object) => new Response(JSON.stringify(value))
async function until(fn: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw Error('condition timed out')
}
function host(dir = mkdtempSync(join(tmpdir(), 'qianlai-login-'))) {
  let dispose = () => {}
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  apply({
    effect: fn => { dispose = fn() }, on: () => () => {}, get: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sessionController: { create: async () => ({ sessionId: 'synthetic-session' }), prompt: async () => ({}) },
  }, { stateDir: dir, autoStart: false })
  cleanups.push(() => dispose())
  return { dir, stop: () => dispose(), control: loginControl(dir)! }
}
function hanging(signal?: AbortSignal | null) {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' }))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

describe('微信登录与首次欢迎', () => {
  it('升级前已绑定但从未登记欢迎的旧状态也发送一次欢迎和三张素材', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qianlai-legacy-welcome-'))
    writeFileSync(join(dir, 'wechat.json'), JSON.stringify({ botToken: 'synthetic-old-token', ownerUserId: 'synthetic-owner', contextToken: 'synthetic-context' }))
    const sent: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url)
      if (path.endsWith('/getupdates')) return hanging(init?.signal)
      if (path.endsWith('/getuploadurl')) return json({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/synthetic-upload' })
      if (path.endsWith('/synthetic-upload')) return new Response('', { headers: { 'x-encrypted-param': 'synthetic-image' } })
      if (path.endsWith('/sendmessage')) {
        const body = JSON.parse(String(init?.body)) as { msg: { item_list: { type: number }[] } }
        sent.push(body.msg.item_list[0]!.type)
        return json({ ret: 0 })
      }
      throw Error('unexpected request')
    }))
    const first = host(dir)
    await vi.waitFor(() => expect(sent).toEqual([1, 2, 2, 2]), { timeout: 1500, interval: 10 })
    expect(JSON.parse(readFileSync(join(dir, 'wechat.json'), 'utf8')).welcomePending).toBe(false)
    first.stop()
    host(dir)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(sent).toHaveLength(4)
  })

  it('按需申请真实新码，过期不展示旧码，刷新无需重启', async () => {
    let count = 0
    let expired = false
    const network = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/get_bot_qrcode')) return json({ ret: 0, qrcode: `q${++count}`, qrcode_img_content: `https://example.invalid/q${count}` })
      if (String(url).includes('/get_qrcode_status')) return expired ? json({ status: 'expired' }) : hanging(init?.signal)
      throw Error('unexpected request')
    })
    vi.stubGlobal('fetch', network)
    const { control } = host()
    expect(await control.run('status')).toEqual({ status: 'disconnected' })
    expect(network).not.toHaveBeenCalled()
    await control.run('start')
    await until(async () => (await control.run('status')).status === 'waiting')
    const first = (await control.run('status')).qrDataUrl
    expect(first).toMatch(/^data:image\/png;base64,/)
    expired = true
    await control.run('refresh')
    await until(async () => (await control.run('status')).status === 'expired')
    expect((await control.run('status')).qrDataUrl).toBeUndefined()
    expired = false
    await control.run('refresh')
    await until(async () => (await control.run('status')).status === 'waiting')
    expect((await control.run('status')).qrDataUrl).not.toBe(first)
    expect(count).toBe(3)
  })

  it('持续的长轮询故障会撤下已连接状态，轮询恢复后重新标记已连接', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qianlai-poll-health-'))
    writeFileSync(join(dir, 'wechat.json'), JSON.stringify({ botToken: 'synthetic-token', welcomePending: false, welcomeProgress: 4, welcomeId: 'synthetic-complete' }))
    let failing = true
    let qrRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/get_bot_qrcode')) qrRequests++
      return json(failing ? { ret: -1, errmsg: 'synthetic unavailable' } : { ret: 0, msgs: [] })
    }))
    vi.useFakeTimers()
    const { control } = host(dir)

    await vi.advanceTimersByTimeAsync(0)
    expect(await control.run('status')).toMatchObject({ status: 'connected' })
    await vi.advanceTimersByTimeAsync(9001)
    expect(await control.run('status')).toMatchObject({ status: 'error', message: '微信连接中断，正在自动重连。' })
    expect(await control.run('start')).toMatchObject({ status: 'error', message: '微信连接中断，正在自动重连。' })
    expect(qrRequests).toBe(0)

    failing = false
    await vi.advanceTimersByTimeAsync(12001)
    expect(await control.run('status')).toMatchObject({ status: 'connected', message: '微信连接已恢复。' })
  })

  it('停止后迟到的出码响应不能重新连接或保留控制器', async () => {
    let resolve!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolve = r })))
    const { control, dir, stop } = host()
    await control.run('start')
    stop()
    resolve(json({ ret: 0, qrcode: 'late', qrcode_img_content: 'https://example.invalid/late' }))
    await new Promise(r => setTimeout(r, 50))
    expect(loginControl(dir)).toBeUndefined()
    expect(await control.run('status')).toMatchObject({ status: 'error' })
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('欢迎和三张素材成功后持久去重，状态从不暴露 token', async () => {
    const sent: { type: number; text_item?: { text: string } }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url)
      if (path.includes('/get_bot_qrcode')) return json({ ret: 0, qrcode: 'synthetic', qrcode_img_content: 'https://example.invalid/synthetic' })
      if (path.includes('/get_qrcode_status')) return json({ status: 'confirmed', bot_token: 'private-test-token', ilink_user_id: 'synthetic-owner' })
      if (path.endsWith('/getupdates')) return hanging(init?.signal)
      if (path.endsWith('/getuploadurl')) return json({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/synthetic-upload' })
      if (path.endsWith('/synthetic-upload')) return new Response('', { status: 200, headers: { 'x-encrypted-param': 'synthetic-download' } })
      if (path.endsWith('/sendmessage')) {
        const body = JSON.parse(String(init?.body)) as { msg: { item_list: { type: number }[] } }
        sent.push(...body.msg.item_list)
        return json({ ret: 0 })
      }
      throw Error('unexpected request')
    }))
    const first = host()
    const book = new BookStore(join(first.dir, 'book.sqlite'))
    book.createCompany({ name: 'Synthetic book', accountingStartMonth: '2026-01', isSample: true })
    book.recordWork('moneycome_record_entry', { preview: true }, { accepted: true })
    book.close()
    await first.control.run('start')
    await until(() => sent.length === 4)
    await until(() => JSON.parse(readFileSync(join(first.dir, 'wechat.json'), 'utf8')).welcomePending === false)
    expect(sent.map(item => item.type)).toEqual([1, 2, 2, 2])
    expect(sent[0]!.text_item!.text).toContain('凭证预演（尚未记账）')
    expect(JSON.stringify(await first.control.run('status'))).not.toContain('private-test-token')
    first.stop()
    const next = host(first.dir)
    expect(await next.control.run('status')).toMatchObject({ status: 'connected' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(sent).toHaveLength(4)
  })

  it('图片发送失败后保留未完成进度，重启只续发未成功步骤', async () => {
    let failure = true
    const delivered: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url)
      if (path.includes('/get_bot_qrcode')) return json({ ret: 0, qrcode: 'synthetic', qrcode_img_content: 'https://example.invalid/synthetic' })
      if (path.includes('/get_qrcode_status')) return json({ status: 'confirmed', bot_token: 'synthetic-token', ilink_user_id: 'synthetic-owner' })
      if (path.endsWith('/getupdates')) return hanging(init?.signal)
      if (path.endsWith('/getuploadurl')) return json({ upload_param: 'synthetic' })
      if (new URL(url).hostname === 'novac2c.cdn.weixin.qq.com') return new Response('', { headers: { 'x-encrypted-param': 'synthetic-download' } })
      if (path.endsWith('/sendmessage')) {
        const body = JSON.parse(String(init?.body)) as { msg: { client_id: string; item_list: { type: number }[] } }
        if (failure && body.msg.item_list[0]!.type === 2) return json({ ret: -1 })
        delivered.push(body.msg.client_id)
        return json({ ret: 0 })
      }
      throw Error('unexpected request')
    }))
    const first = host()
    await first.control.run('start')
    await until(() => delivered.length === 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(JSON.parse(readFileSync(join(first.dir, 'wechat.json'), 'utf8'))).toMatchObject({ welcomePending: true, welcomeProgress: 1 })
    first.stop()
    failure = false
    host(first.dir)
    await until(() => delivered.length === 4)
    await until(() => JSON.parse(readFileSync(join(first.dir, 'wechat.json'), 'utf8')).welcomePending === false)
    expect(new Set(delivered).size).toBe(4)
    expect(delivered.filter(id => id.endsWith('-intro'))).toHaveLength(1)
  })

  it('注册宿主 owner 专用精确路由，校验 RPC 信封与有限动作', async () => {
    let route!: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }
    const run = vi.fn(async () => ({ status: 'disconnected' as const }))
    registerLoginRpc({ fetch: { register: value => { route = value; return async () => {} } } }, { run })
    expect(route).toMatchObject({ path: '/api/qianlai/wechat', methods: ['POST'], requestBody: 'buffered' })
    const request = (body: unknown) => new Request('http://localhost/api/qianlai/wechat', { method: 'POST', body: JSON.stringify(body) })
    expect((await route.fetch(request({ action: 'start' }))).status).toBe(400)
    const envelope = { type: 'client-request', rpcId: 'synthetic-request', method: 'qianlai/wechat' }
    expect(await (await route.fetch(request({ ...envelope, payload: { action: 'send', text: 'unexpected' } }))).json()).toMatchObject({ result: { ok: false } })
    expect(run).not.toHaveBeenCalled()
    expect(await (await route.fetch(request({ ...envelope, payload: { action: 'status' } }))).json()).toMatchObject({ result: { ok: true } })
    expect(await (await route.fetch(request({ ...envelope, payload: { action: 'start', sessionId: 'synthetic-desktop' } }))).json()).toMatchObject({ result: { ok: true } })
    expect(run).toHaveBeenLastCalledWith('start', 'synthetic-desktop')
    expect(await (await route.fetch(request({ ...envelope, payload: { action: 'start', sessionId: '../other' } }))).json()).toMatchObject({ result: { ok: false } })
  })
})
