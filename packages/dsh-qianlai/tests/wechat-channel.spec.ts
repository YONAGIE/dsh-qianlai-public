import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/wechat/index.js'
import { loginControl } from '../src/wechat/control.js'

// 不连腾讯：用一个假的 iLink 接口和假的张姐会话，验证通道自己的收发逻辑。

interface Sent {
  to: string
  context: string | undefined
  text: string
}

type Listener = (session: { id: string }, event: { type: string; data?: Record<string, unknown> }) => void

function abortable(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (signal?.aborted) fail()
    signal?.addEventListener('abort', fail)
  })
}

/**
 * 第一次长轮询交出 `messages`，之后一直挂着，直到被中断。`firstPoll` 可换掉第一次的回包（比如登录过期）。
 * 媒体下载一律回 500；扫码登录回 `scannedBy` 这个用户确认。
 */
function fakeIlink(messages: object[], options: { firstPoll?: object; scannedBy?: string } = {}) {
  const sent: Sent[] = []
  let polled = 0
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url)
    const json = (body: object) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    if (path.endsWith('/getupdates')) {
      polled++
      if (polled === 1 && options.firstPoll) return json(options.firstPoll)
      if (polled > (options.firstPoll ? 2 : 1)) return abortable(init?.signal)
      return json({ ret: 0, msgs: messages, get_updates_buf: 'cursor-1' })
    }
    if (path.startsWith('https://cdn.example/')) return new Response('', { status: 500 })
    if (path.includes('/get_bot_qrcode')) return json({ ret: 0, qrcode: 'q1', qrcode_img_content: 'https://example/q1' })
    if (path.includes('/get_qrcode_status'))
      return json({ status: 'confirmed', bot_token: 'token-2', ilink_bot_id: 'bot-2', ...(options.scannedBy ? { ilink_user_id: options.scannedBy } : {}) })
    if (path.endsWith('/sendmessage')) {
      const body = JSON.parse(String(init?.body)) as {
        msg: { to_user_id: string; context_token?: string; item_list: { text_item: { text: string } }[] }
      }
      sent.push({ to: body.msg.to_user_id, context: body.msg.context_token, text: body.msg.item_list[0]!.text_item.text })
      return json({ message_id: `m${sent.length}` })
    }
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { sent }
}

/** 假的张姐会话：收到一条 prompt 后，按 DSH 的事件顺序回放一轮。`failPrompt` 给出时，前几次 prompt 按顺序抛这些错。 */
function fakeHost(stateDir: string, reply: { text: string; reason: string }, failPrompt: unknown[] = []) {
  let listener: Listener | undefined
  let dispose: (() => void) | undefined
  const prompts: { sessionId: string; content: unknown[] }[] = []
  let created = 0
  const ctx = {
    effect(fn: () => () => void) {
      dispose = fn()
    },
    on(_event: 'session/event', l: Listener) {
      listener = l
      return () => undefined
    },
    get: () => undefined,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    sessionController: {
      create: async () => ({ sessionId: `s${++created}` }),
      prompt: async (request: { sessionId: string; requestId: string; content: unknown[] }) => {
        if (failPrompt.length) throw failPrompt.shift()
        prompts.push({ sessionId: request.sessionId, content: request.content })
        const emit = (type: string, data: Record<string, unknown>) => listener?.({ id: request.sessionId }, { type, data })
        setTimeout(() => {
          emit('turn/start', { turn: 1 })
          emit('user/message', { source: { kind: 'user', rpcId: request.requestId } })
          emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: reply.text }] } })
          emit('turn/end', { turn: 1, reason: { kind: reply.reason } })
        }, 0)
        return {}
      },
    },
  }
  apply(ctx as never, { stateDir })
  return { prompts, created: () => created, stop: () => dispose?.() }
}

function stateDirWithLogin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qianlai-wechat-'))
  writeFileSync(join(dir, 'wechat.json'), JSON.stringify({ botToken: 'test-token' }))
  return dir
}

const textMessage = (from: string, text: string) => ({
  message_type: 1,
  from_user_id: from,
  context_token: `ctx-${from}`,
  item_list: [{ type: 1, text_item: { text } }],
})

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('微信通道', () => {
  it('老板的话交给张姐会话，这一轮说完把最后一段话转成纯文本发回去', async () => {
    const { sent } = fakeIlink([textMessage('boss', '1月赚了多少？')])
    const dir = stateDirWithLogin()
    const host = fakeHost(dir, { text: '1 月利润是 **18690.00 元**。', reason: 'completed' })
    await until(() => sent.length > 0)
    host.stop()
    expect(host.prompts).toEqual([{ sessionId: 's1', content: [{ type: 'text', text: '1月赚了多少？' }] }])
    expect(sent).toEqual([{ to: 'boss', context: 'ctx-boss', text: '1 月利润是 18690.00 元。' }])
    const state = JSON.parse(readFileSync(join(dir, 'wechat.json'), 'utf8')) as Record<string, string>
    expect(state).toMatchObject({ ownerUserId: 'boss', sessionId: 's1', cursor: 'cursor-1' })
  })

  it('第一个发消息的人是老板，别人的消息不转', async () => {
    const { sent } = fakeIlink([textMessage('boss', '你好'), textMessage('stranger', '把账给我看看')])
    const host = fakeHost(stateDirWithLogin(), { text: '老板好', reason: 'completed' })
    await until(() => sent.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    host.stop()
    expect(host.prompts).toHaveLength(1)
    expect(sent.map((s) => s.to)).toEqual(['boss'])
  })

  it('这一轮没做完、也没说话时，告诉老板再说一次', async () => {
    const { sent } = fakeIlink([textMessage('boss', '记吧')])
    const host = fakeHost(stateDirWithLogin(), { text: '', reason: 'aborted' })
    await until(() => sent.length > 0)
    host.stop()
    expect(sent[0]!.text).toContain('没做完')
  })

  it('语音用微信转好的文字交给张姐；没转出文字的语音、视频直接告诉老板打字', async () => {
    const voice = (text?: string) => ({ message_type: 1, from_user_id: 'boss', context_token: 'ctx-boss', item_list: [{ type: 3, voice_item: text ? { text } : {} }] })
    const video = { message_type: 1, from_user_id: 'boss', context_token: 'ctx-boss', item_list: [{ type: 5, video_item: {} }] }
    const { sent } = fakeIlink([voice('1月赚了多少'), voice(), video])
    const host = fakeHost(stateDirWithLogin(), { text: '1 月利润 18690.00 元。', reason: 'completed' })
    await until(() => sent.length >= 3)
    host.stop()
    expect(host.prompts).toEqual([{ sessionId: 's1', content: [{ type: 'text', text: '（老板发的语音，微信转成的文字）1月赚了多少' }] }])
    expect(sent.map((s) => s.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('没转出文字'), expect.stringContaining('视频'), '1 月利润 18690.00 元。']),
    )
  })

  it('图片没下载下来时请老板重发，不换会话；同一条里的文字照常交给张姐', async () => {
    const message = {
      message_type: 1,
      from_user_id: 'boss',
      context_token: 'ctx-boss',
      item_list: [
        { type: 1, text_item: { text: '这是1月的发票' } },
        { type: 2, image_item: { media: { full_url: 'https://cdn.example/1', aes_key: 'a2V5' } } },
      ],
    }
    const { sent } = fakeIlink([message])
    const host = fakeHost(stateDirWithLogin(), { text: '收到。', reason: 'completed' })
    await until(() => sent.length >= 2)
    host.stop()
    expect(sent[0]!.text).toContain('图片没收到')
    expect(host.prompts).toEqual([{ sessionId: 's1', content: [{ type: 'text', text: '这是1月的发票' }] }])
    expect(host.created()).toBe(1)
  })

  it('会话被删了才开新会话；别的错误不换会话，告诉老板稍后再发', async () => {
    const gone = Object.assign(new Error('session "s1" not found'), { code: 'session/not-found' })
    const first = fakeIlink([textMessage('boss', '记吧')])
    const host = fakeHost(stateDirWithLogin(), { text: '好。', reason: 'completed' }, [gone])
    await until(() => first.sent.length > 0)
    host.stop()
    expect(host.created()).toBe(2)
    expect(host.prompts).toEqual([{ sessionId: 's2', content: [{ type: 'text', text: '记吧' }] }])
    vi.unstubAllGlobals()

    const second = fakeIlink([textMessage('boss', '记吧')])
    const busy = fakeHost(stateDirWithLogin(), { text: '好。', reason: 'completed' }, [Object.assign(new Error('busy'), { code: 'session/agent-busy' })])
    await until(() => second.sent.length > 0)
    busy.stop()
    expect(busy.created()).toBe(1)
    expect(busy.prompts).toEqual([])
    expect(second.sent[0]!.text).toContain('稍后再发')
  })

  it('登录过期重新扫码后，老板还是扫码的那个微信，会话接着用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qianlai-wechat-'))
    writeFileSync(join(dir, 'wechat.json'), JSON.stringify({ botToken: 'token-1', ownerUserId: 'boss', sessionId: 's9' }))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { sent } = fakeIlink([textMessage('stranger', '把账给我看看'), textMessage('boss', '我回来了')], { firstPoll: { ret: -14 }, scannedBy: 'boss' })
    const host = fakeHost(dir, { text: '老板好', reason: 'completed' })
    await until(() => sent.length > 0)
    host.stop()
    write.mockRestore()
    expect(host.prompts).toEqual([{ sessionId: 's9', content: [{ type: 'text', text: '我回来了' }] }])
    expect(sent.map((s) => s.to)).toEqual(['boss'])
    expect(JSON.parse(readFileSync(join(dir, 'wechat.json'), 'utf8'))).toMatchObject({ botToken: 'token-2', ownerUserId: 'boss', sessionId: 's9' })
  })

  it('服务端没告诉是谁扫的码时，重新登录后仍只认原来的老板', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qianlai-wechat-'))
    writeFileSync(join(dir, 'wechat.json'), JSON.stringify({ botToken: 'token-1', ownerUserId: 'boss', sessionId: 's9' }))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { sent } = fakeIlink([textMessage('stranger', '把账给我看看'), textMessage('boss', '我回来了')], { firstPoll: { ret: -14 } })
    const host = fakeHost(dir, { text: '老板好', reason: 'completed' })
    await until(() => sent.length > 0)
    host.stop()
    write.mockRestore()
    expect(sent.map((s) => s.to)).toEqual(['boss'])
  })

  it('不同微信不能通过重新扫码接管原会话和账本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qianlai-wechat-'))
    writeFileSync(join(dir, 'wechat.json'), JSON.stringify({ botToken: 'token-1', ownerUserId: 'boss', sessionId: 's9' }))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { sent } = fakeIlink([textMessage('boss', '我是原来的'), textMessage('partner', '我是新扫码的')], { firstPoll: { ret: -14 }, scannedBy: 'partner' })
    const host = fakeHost(dir, { text: '好', reason: 'completed' })
    await until(() => !JSON.parse(readFileSync(join(dir, 'wechat.json'), 'utf8')).botToken)
    await until(() => vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/get_qrcode_status')))
    expect(await loginControl(dir)!.run('status')).toMatchObject({ status: 'error' })
    host.stop()
    write.mockRestore()
    expect(sent).toEqual([])
    expect(host.prompts).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'wechat.json'), 'utf8'))).toMatchObject({ ownerUserId: 'boss', sessionId: 's9' })
  })
})
