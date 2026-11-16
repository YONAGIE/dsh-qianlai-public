import { createCipheriv } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply as applyTools } from '../src/index.js'
import { BookStore } from '../src/store.js'
import { isIntroductionSession, loginControl, type LoginRpcControl } from '../src/wechat/control.js'
import type { IlinkItem } from '../src/wechat/ilink.js'
import { apply } from '../src/wechat/index.js'

const disposers: (() => void)[] = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const json = (value: object) => Response.json(value)
const readState = (dir: string) => JSON.parse(readFileSync(join(dir, 'wechat.json'), 'utf8'))
const writeState = (dir: string, state: object) => writeFileSync(join(dir, 'wechat.json'), JSON.stringify(state))
const source = 'synthetic-desktop'
const secondSource = 'synthetic-desktop-b'
const sessionId = 'synthetic-wechat'
const reply = '刚才提到核对2026年三月利润，还没有查询，要接着查吗？'
const imageKey = Buffer.alloc(16, 7)
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7V0AAAAASUVORK5CYII=', 'base64')
const imageUrl = 'https://example.invalid/synthetic-image'

function directory(state: object = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qianlai-onboarding-'))
  writeState(dir, state)
  const store = new BookStore(join(dir, 'book.sqlite'))
  store.createCompany({ name: '合成续接企业', accountingStartMonth: '2026-01', isSample: true })
  store.close()
  return dir
}
function hanging(signal?: AbortSignal | null) {
  return new Promise<Response>((_resolve, reject) => {
    const fail = () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' }))
    if (signal?.aborted) fail()
    else signal?.addEventListener('abort', fail, { once: true })
  })
}
function network(imageGate?: Promise<void>) {
  const sent: { id: string; type: number; text?: string }[] = []
  let failSummary = false
  let failWelcome = false
  let contextRequired = false
  let incoming: ((response: Response) => void) | undefined
  let messageNumber = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url)
    if (path.includes('/get_bot_qrcode')) return json({ ret: 0, qrcode: 'synthetic-code', qrcode_img_content: 'https://example.invalid/synthetic-code' })
    if (path.includes('/get_qrcode_status')) return json({ status: 'confirmed', bot_token: 'synthetic-token', ilink_user_id: 'synthetic-owner' })
    if (path.endsWith('/getupdates')) return new Promise<Response>((resolve, reject) => {
      incoming = resolve
      const fail = () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' }))
      if (init?.signal?.aborted) fail()
      else init?.signal?.addEventListener('abort', fail, { once: true })
    })
    if (path.endsWith('/getuploadurl')) {
      await imageGate
      return json({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/synthetic-upload' })
    }
    if (path.endsWith('/synthetic-upload')) return new Response('', { headers: { 'x-encrypted-param': 'synthetic-image' } })
    if (path === imageUrl) {
      const cipher = createCipheriv('aes-128-ecb', imageKey, null)
      return new Response(new Uint8Array(Buffer.concat([cipher.update(image), cipher.final()])))
    }
    if (path.endsWith('/sendtyping')) return json({ ret: 0 })
    if (path.endsWith('/sendmessage')) {
      const body = JSON.parse(String(init?.body)) as { msg: { client_id: string; context_token?: string; item_list: { type: number; text_item?: { text: string } }[] } }
      if (contextRequired && !body.msg.context_token) return json({ ret: -2, errcode: 42, errmsg: 'private-server-detail' })
      if (failWelcome && body.msg.client_id.startsWith('mc-welcome-')) return new Response('', { status: 503 })
      if (failSummary && body.msg.client_id.startsWith('mc-handoff-')) return new Response('', { status: 503 })
      const item = body.msg.item_list[0]!
      sent.push({ id: body.msg.client_id, type: item.type, ...(item.text_item ? { text: item.text_item.text } : {}) })
      return json({ ret: 0 })
    }
    return hanging(init?.signal)
  }))
  return {
    sent,
    failSummary: (value: boolean) => { failSummary = value },
    failWelcome: () => { failWelcome = true },
    requireContext: () => { contextRequired = true },
    canReceive: () => incoming !== undefined,
    hello(items: IlinkItem[] = [{ type: 1, text_item: { text: '你好' } }]) {
      const receive = incoming
      incoming = undefined
      receive?.(json({
        ret: 0, get_updates_buf: `synthetic-cursor-${++messageNumber}`,
        msgs: [{ msg_id: `synthetic-message-${messageNumber}`, message_type: 1, from_user_id: 'synthetic-owner', context_token: 'synthetic-context', item_list: items }],
      }))
    },
  }
}
type Event = { type: string; seq?: number; time?: number; data?: Record<string, unknown> }
type Assembly = { agent: { session: { id: string } }; signal: AbortSignal }
type Decision = { kind: 'enter'; messages: { source: { kind: 'user'; rpcId: string } }[] }
function desktopEvents(): Event[] {
  return [
    { type: 'agent-preset/selected', seq: 0, data: { agentPreset: 'moneycome-zhangjie' } },
    { type: 'user/message', seq: 1, time: Date.now(), data: { content: [{ type: 'text', text: '稍后继续核对2026年三月利润；现在先连接微信。' }] } },
    { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text: '这一步还没有查询，稍后继续。' }] } } },
  ]
}
function host(dir: string, options: {
  events?: Event[]; preset?: string; text?: string; histories?: Event[]; during?: () => Promise<void>
  workspaces?: { id: string; sessionIds: string[] }[]
} = {}) {
  let dispose = () => {}
  let eventListener: ((session: { id: string }, event: Event) => void) | undefined
  let preStep: ((assembly: Assembly, next: () => Promise<Decision>) => Promise<Decision>) | undefined
  let context: ((assembly: Assembly) => string) | undefined
  const histories = options.histories ?? []
  const prompts: { sessionId: string; requestId: string; content: { type: string; text?: string }[] }[] = []
  const contexts: string[] = []
  const modelContext = async (sessionId: string, requestId: string) => {
    const assembly = { agent: { session: { id: sessionId } }, signal: new AbortController().signal }
    await preStep?.(assembly, async () => ({ kind: 'enter', messages: [{ source: { kind: 'user', rpcId: requestId } }] }))
    return context?.(assembly) ?? ''
  }
  let turn = 0
  const inspect = vi.fn(async (id: string) => ({ meta: { agentPreset: options.preset ?? 'moneycome-zhangjie' }, events: id === source || id === secondSource
    ? options.events ?? desktopEvents().map(event => event.type === 'agent-preset/selected' && options.preset ? { ...event, data: { agentPreset: options.preset } } : event)
    : histories }))
  const workspaceRegistry = {
    list: () => options.workspaces ?? [],
    get: (id: string) => options.workspaces?.find(item => item.id === id),
  }
  const create = vi.fn(async (request: { workspaceId?: string; cwd?: string }) => {
    const sequence = create.mock.calls.length
    const created = sequence === 1 ? sessionId : sessionId + '-' + sequence
    if (request.workspaceId) workspaceRegistry.get(request.workspaceId)!.sessionIds.push(created)
    return { sessionId: created }
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  apply({ effect: (fn: () => () => void) => { dispose = fn() },
    on: (name: string, listener: unknown) => {
      if (name === 'session/event') eventListener = listener as typeof eventListener
      if (name === 'agent/pre-step') preStep = listener as typeof preStep
      return () => {}
    },
    get: (name: string) => name === 'systemPrompt'
      ? { context: ({ text }: { text: typeof context }) => { context = text; return () => { context = undefined } } }
      : name === 'workspaceRegistry' ? workspaceRegistry : undefined,
    logger: { info() {}, warn() {}, error() {} },
    sessionController: { inspect, create, prompt: async (request: typeof prompts[number]) => {
      contexts.push(await modelContext(request.sessionId, request.requestId))
      prompts.push(request)
      const emit = (type: string, data: Record<string, unknown>) => { const event = { type, data }; histories.push(event); eventListener?.({ id: request.sessionId }, event) }
      setTimeout(() => { void (async () => {
        const currentTurn = ++turn
        emit('turn/start', { turn: currentTurn })
        emit('user/message', { source: { kind: 'user', rpcId: request.requestId } })
        emit('user/message', { source: { kind: 'runtime-context' } })
        await options.during?.()
        emit('assistant/message', { turn: currentTurn, message: { content: [{ type: 'text', text: options.text ?? reply }] } })
        emit('turn/end', { turn: currentTurn, reason: { kind: 'completed' } })
      })() }, 0)
      return { accepted: true }
    } },
  } as never, { stateDir: dir, autoStart: false })
  disposers.push(() => dispose())
  return { control: loginControl(dir) as LoginRpcControl, prompts, contexts, modelContext, inspect, create, stop: () => dispose() }
}
const completedWelcome = { welcomePending: false, welcomeProgress: 4, welcomeId: 'synthetic-finished' }
const savedLogin = { botToken: 'synthetic-token', ownerUserId: 'synthetic-owner', contextToken: 'synthetic-context', ...completedWelcome }

describe('微信欢迎与桌面任务主动续接', () => {
  it('首次扫码后发送欢迎与三张素材，并由现有 Agent 生成对应桌面任务的续接', async () => {
    const workspace = { id: 'workspace-a', sessionIds: [source] }
    const net = network(), dir = directory(), active = host(dir, { workspaces: [workspace] })
    await active.control.run('start', source)
    await vi.waitFor(() => expect(net.sent).toHaveLength(5))
    expect(net.sent.map(item => item.type)).toEqual([1, 2, 2, 2, 1])
    expect(net.sent.at(-1)?.text).toBe(reply)
    expect(active.prompts).toHaveLength(1)
    expect(active.contexts).toEqual([''])
    expect(active.prompts[0]!.content[0]!.text).toContain('三月利润')
    expect(active.create).toHaveBeenCalledExactlyOnceWith({ agentPreset: 'moneycome-zhangjie', workspaceId: workspace.id })
    expect(workspace.sessionIds).toEqual([source, sessionId])
    expect(readState(dir)).toMatchObject({ workspaceId: workspace.id, welcomePending: false, desktopHandoff: { sourceSessionId: source, throughSeq: 2, phase: 'complete' } })
  })
  it('从空白的已登记桌面对话扫码，重启后首条微信消息仍归入原工作区', async () => {
    const workspace = { id: 'workspace-a', sessionIds: [source] }
    const net = network(), dir = directory(completedWelcome)
    const active = host(dir, { events: [], workspaces: [workspace] })
    await active.control.run('start', source)
    await vi.waitFor(() => expect(readState(dir)).toMatchObject({ botToken: 'synthetic-token', workspaceId: workspace.id }))
    expect(active.create).not.toHaveBeenCalled()
    active.stop()

    const restarted = host(dir, { workspaces: [workspace] })
    await vi.waitFor(() => expect(net.canReceive()).toBe(true))
    net.hello()
    await vi.waitFor(() => expect(restarted.prompts).toHaveLength(1))
    expect(restarted.create).toHaveBeenCalledExactlyOnceWith({ agentPreset: 'moneycome-zhangjie', workspaceId: workspace.id })
    expect(workspace.sessionIds).toEqual([source, sessionId])
  })
  it('更换工作区需重新扫码，旧微信会话仍留在原工作区', async () => {
    const first = { id: 'workspace-a', sessionIds: [source, 'previous-wechat'] }
    const second = { id: 'workspace-b', sessionIds: [secondSource] }
    const net = network(), dir = directory({ ...savedLogin, workspaceId: first.id, sessionId: 'previous-wechat' })
    const active = host(dir, { workspaces: [first, second] })
    expect(await active.control.run('status', secondSource)).toMatchObject({ status: 'connected' })
    expect(active.inspect).not.toHaveBeenCalled()
    await active.control.run('start', secondSource)
    expect(active.create).not.toHaveBeenCalled()
    expect(readState(dir)).toMatchObject({ workspaceId: first.id, sessionId: 'previous-wechat' })
    expect(readState(dir).desktopHandoff).toBeUndefined()

    active.control.disconnect()
    await active.control.run('start', secondSource)
    await vi.waitFor(() => expect(net.sent.some(item => item.id.startsWith('mc-handoff-'))).toBe(true))
    expect(active.create).toHaveBeenCalledExactlyOnceWith({ agentPreset: 'moneycome-zhangjie', workspaceId: second.id })
    expect(readState(dir)).toMatchObject({ workspaceId: second.id, sessionId, desktopHandoff: { sourceSessionId: secondSource } })
    expect(first.sessionIds).toEqual([source, 'previous-wechat'])
    expect(second.sessionIds).toEqual([secondSource, sessionId])
  })
  it('旧绑定重新接入已登记工作区时，为之后的微信消息创建有归属的对话', async () => {
    const workspace = { id: 'workspace-a', sessionIds: [source] }
    const net = network(), dir = directory({ ...savedLogin, sessionId: 'legacy-ungrouped' })
    const active = host(dir, { events: [], workspaces: [workspace] })
    await active.control.run('start', source)
    expect(readState(dir)).toMatchObject({ workspaceId: workspace.id, sessionId: 'legacy-ungrouped' })
    await vi.waitFor(() => expect(net.canReceive()).toBe(true))
    net.hello()
    await vi.waitFor(() => expect(active.prompts).toHaveLength(1))
    expect(active.create).toHaveBeenCalledExactlyOnceWith({ agentPreset: 'moneycome-zhangjie', workspaceId: workspace.id })
    expect(readState(dir).sessionId).toBe(sessionId)
    expect(workspace.sessionIds).toEqual([source, sessionId])
  })
  it('有来源会话而无业务写入记录时，查询意图仍进入 AI 摘要；重连和重启不重复', async () => {
    const net = network(), dir = directory(savedLogin), active = host(dir)
    await active.control.run('start', source)
    await vi.waitFor(() => expect(net.sent).toHaveLength(1))
    expect(active.create).toHaveBeenCalledExactlyOnceWith({ agentPreset: 'moneycome-zhangjie', cwd: join(dir, 'wechat-workspace') })
    expect(active.prompts[0]!.content[0]!.text).toContain('"progress":[]')
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/get_bot_qrcode'))).toBe(false)
    await active.control.run('refresh', source)
    active.stop()
    const restarted = host(dir)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(net.sent).toHaveLength(1)
    expect(restarted.prompts).toHaveLength(0)
  })
  it('不读取无关预设会话，不转发系统提示、推理或密钥', async () => {
    const net = network(), dir = directory(savedLogin)
    const unrelated = host(dir, { preset: 'other-preset' })
    await unrelated.control.run('start', source)
    expect(unrelated.prompts).toHaveLength(0)
    unrelated.stop()
    const secret = 'sk-' + 'syntheticsecret0123456789'
    const active = host(dir, { events: [...desktopEvents(),
      { type: 'system/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'private-system-instruction' }] } } },
      { type: 'assistant/message', seq: 4, time: Date.now(), data: { message: { content: [{ type: 'thinking', text: 'private-reasoning' }, { type: 'text', text: '临时测试值 ' + secret }] } } },
    ] })
    await active.control.run('start', source)
    await vi.waitFor(() => expect(net.sent).toHaveLength(1))
    const submitted = active.prompts[0]!.content[0]!.text!
    expect(submitted).not.toContain('private-system-instruction')
    expect(submitted).not.toContain('private-reasoning')
    expect(submitted).not.toContain(secret)
    expect(submitted).toContain('[REDACTED]')
  })
  it('服务端要求先有入站上下文时，旧绑定在首条消息后补齐未完成欢迎', async () => {
    const net = network(); net.requireContext()
    const dir = directory({ botToken: 'synthetic-token', ownerUserId: 'synthetic-owner' }), active = host(dir)
    const readLog = () => readFileSync(join(dir, 'wechat.log'), 'utf8')
    const rejection = /welcome delivery incomplete welcome=([0-9a-f]{12}) attempt=1 trigger=saved-binding step=text hasContext=false operation=sendmessage reason=api http=200 ret=-2 errcode=42/
    await vi.waitFor(() => expect(readLog()).toMatch(rejection))
    const trace = readLog().match(rejection)![1]
    expect(readState(dir).welcomePending).toBe(true)
    expect(net.sent).toHaveLength(0)
    net.hello()
    await vi.waitFor(() => expect(net.sent.filter(item => item.id.startsWith('mc-welcome-'))).toHaveLength(4))
    expect(readState(dir).welcomePending).toBe(false)
    const log = readLog()
    expect(log).toContain(`owner message welcome=${trace} hasIncomingContext=true hasContext=true`)
    expect(log).toContain(`welcome accepted welcome=${trace} attempt=2 trigger=owner-message step=text hasContext=true`)
    expect(log).toContain(`welcome complete welcome=${trace} attempt=2 trigger=owner-message`)
    expect(log).not.toMatch(/synthetic-token|synthetic-owner|synthetic-context|private-server-detail/)
    active.stop()
  })
  it('首条业务消息收到准确的欢迎上下文，保留原文和附件，图片续发不阻塞模型', async () => {
    let resumeImages = () => {}
    const images = new Promise<void>(resolve => { resumeImages = resolve })
    const net = network(images); net.requireContext()
    const dir = directory({ botToken: 'synthetic-token', ownerUserId: 'synthetic-owner' }), active = host(dir)
    try {
      await vi.waitFor(() => expect(readFileSync(join(dir, 'wechat.log'), 'utf8')).toContain('welcome delivery incomplete'))
      const text = '帮我核对这张合成票据'
      net.hello([
        { type: 1, text_item: { text } },
        { type: 2, image_item: { media: { full_url: imageUrl, aes_key: Buffer.from(imageKey.toString('hex')).toString('base64') } } },
      ])
      await vi.waitFor(() => expect(active.prompts).toHaveLength(1))
      const welcome = net.sent.find(item => item.id.endsWith('-intro'))
      expect(welcome?.text).toBeTruthy()
      expect(active.contexts[0]).toContain(welcome!.text!)
      expect(active.contexts[0]).toContain('手机端显示尚未核实')
      expect(active.prompts[0]?.content).toEqual([{ type: 'text', text }, { type: 'image', mediaType: 'image/png', data: image.toString('base64') }])
      expect(net.sent.filter(item => item.type === 2)).toHaveLength(0)
      expect(await active.modelContext(source, active.prompts[0]!.requestId)).toBe('')
      expect(await active.modelContext(sessionId, 'unrelated-desktop-request')).toBe('')
      resumeImages()
      await vi.waitFor(() => expect(net.sent.filter(item => item.type === 2)).toHaveLength(3))
      await vi.waitFor(() => expect(net.canReceive()).toBe(true))
      net.hello()
      await vi.waitFor(() => expect(active.contexts).toHaveLength(2))
      expect(active.contexts[1]).toBe('')
    } finally { resumeImages() }
  })
  it('固定欢迎发送失败时，首条模型请求仍继续处理且只得到未确认状态', async () => {
    const net = network(); net.failWelcome()
    const dir = directory({ botToken: 'synthetic-token', ownerUserId: 'synthetic-owner' }), active = host(dir)
    await vi.waitFor(() => expect(readFileSync(join(dir, 'wechat.log'), 'utf8')).toContain('welcome delivery incomplete'))
    net.hello()
    await vi.waitFor(() => expect(active.prompts).toHaveLength(1))
    expect(active.contexts[0]).toContain('固定欢迎文字的发送尚未确认')
    expect(active.contexts[0]).not.toContain('欢迎原文')
    expect(active.prompts[0]?.content).toEqual([{ type: 'text', text: '你好' }])
    expect(net.sent.some(item => item.id.startsWith('mc-welcome-'))).toBe(false)
  })
  it('摘要发送失败时保留回复，重启续发而不再调用模型', async () => {
    const net = network(); net.failSummary(true)
    const dir = directory(savedLogin), active = host(dir)
    await active.control.run('start', source)
    await vi.waitFor(() => expect(readState(dir)).toMatchObject({ desktopHandoff: { phase: 'complete' }, outbox: [expect.objectContaining({ text: reply })] }))
    expect(active.prompts).toHaveLength(1)
    active.stop(); net.failSummary(false)
    const restarted = host(dir)
    await vi.waitFor(() => expect(net.sent).toHaveLength(1))
    expect(restarted.prompts).toHaveLength(0)
    expect(net.sent[0]!.text).toBe(reply)
  })
  it('只谈扫码时，不把模型的无事项标记发到微信', async () => {
    const net = network(), dir = directory(savedLogin), active = host(dir, { text: '[无待续接事项]' })
    await active.control.run('start', source)
    await vi.waitFor(() => expect(readState(dir).desktopHandoff.phase).toBe('complete'))
    expect(net.sent).toHaveLength(0)
  })
  it('重启恢复已完成但尚未排队的模型结果，不重复生成', async () => {
    const net = network(), dir = directory(savedLogin)
    const store = new BookStore(join(dir, 'book.sqlite'))
    const company = JSON.stringify(store.company()); store.close()
    const requestId = 'synthetic-handoff-request'
    writeState(dir, { ...savedLogin, sessionId, desktopHandoff: { key: 'synthetic-handoff-key', sourceSessionId: source, throughSeq: 2, company, requestId, phase: 'submitted' } })
    const active = host(dir, { histories: [
      { type: 'user/message', data: { source: { rpcId: requestId } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ] })
    await vi.waitFor(() => expect(net.sent).toHaveLength(1))
    expect(active.prompts).toHaveLength(0)
    expect(net.sent[0]!.text).toBe(reply)
  })
  it('生成期间切换公司时不发送上一家公司的续接', async () => {
    const net = network(), dir = directory(savedLogin)
    const active = host(dir, { during: async () => {
      const store = new BookStore(join(dir, 'book.sqlite'))
      store.clearBook(); store.createCompany({ name: '另一家合成企业', accountingStartMonth: '2026-02', isSample: false }); store.close()
    } })
    await active.control.run('start', source)
    await vi.waitFor(() => expect(readState(dir).desktopHandoff.phase).toBe('failed'))
    expect(net.sent).toHaveLength(0)
  })
  it('主动摘要轮拒绝账务修改，普通老板轮不受只读标记影响', async () => {
    const net = network(), dir = directory(savedLogin)
    const tools = new Map<string, Parameters<Parameters<typeof applyTools>[0]['tools']['register']>[0]>()
    let disposeTools = () => {}
    applyTools({ effect: fn => { disposeTools = fn() }, tools: { register: tool => { tools.set(tool.name, tool); return () => {} } } }, { bookPath: join(dir, 'book.sqlite') })
    disposers.push(() => disposeTools())
    let denied: unknown
    const active = host(dir, { during: async () => {
      expect(isIntroductionSession(sessionId)).toBe(true)
      denied = await tools.get('moneycome_set_company_facts')!.execute({ facts: { 'assets.fixed': 'yes' } }, { signal: new AbortController().signal, agent: { session: { id: sessionId } } })
    } })
    await active.control.run('start', source)
    await vi.waitFor(() => expect(net.sent).toHaveLength(1))
    expect(denied).toMatchObject({ accepted: false, code: 'INTRODUCTION_READ_ONLY' })
    expect(isIntroductionSession(sessionId)).toBe(false)
    expect(await tools.get('moneycome_save_work_note')!.execute({ note: '普通老板轮的合成待办' }, { signal: new AbortController().signal, agent: { session: { id: sessionId } } }))
      .toMatchObject({ accepted: true })
    const store = new BookStore(join(dir, 'book.sqlite'))
    expect(store.companyFacts()).toEqual({})
    store.close()
  })
})
