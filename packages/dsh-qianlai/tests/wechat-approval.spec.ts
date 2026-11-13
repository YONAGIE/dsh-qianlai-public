import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/wechat/index.js'

interface Question { agent: { session: { id: string } }; toolName: string; reason: string; signal: AbortSignal }
type Answer = (question: Question, next: () => Promise<string>) => Promise<string>
type ToolGuard = (execution: { name: string; agent: { session: { id: string } } }) => string | undefined
const stops: (() => void)[] = []
const roots: string[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qianlai-wechat-approval-'))
  roots.push(root)
  writeFileSync(join(root, 'wechat.json'), JSON.stringify({ botToken: 'synthetic-token', ownerUserId: 'synthetic-owner', sessionId: 'synthetic-session', welcomePending: false, welcomeProgress: 4, welcomeId: 'synthetic-complete' }))
  // A generic UI broker may wait indefinitely even with no browser attached.
  // The channel must claim its own session before that broker, and delegate others.
  const answers: Answer[] = [async (question, next) => question.agent.session.id !== 'synthetic-session' ? next()
    : new Promise(resolve => question.signal.addEventListener('abort', () => resolve('cancelled'), { once: true }))]
  let dispose = () => {}
  let questionGuard: ToolGuard | undefined
  let deliver: ((response: Response) => void) | undefined
  const sent: string[] = []
  const prompt = vi.fn(async () => ({}))
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/getupdates')) return new Promise<Response>((resolve, reject) => {
      deliver = resolve
      const abort = () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }))
      if (init?.signal?.aborted) abort()
      else init?.signal?.addEventListener('abort', abort, { once: true })
    })
    if (String(url).endsWith('/sendmessage')) sent.push(JSON.parse(String(init?.body)).msg.item_list[0].text_item.text)
    return Response.json({ message_id: 'synthetic-delivery' })
  }))
  apply({ effect: (fn: () => () => void) => { dispose = fn(); stops.push(dispose) },
    on: (event: string, listener: unknown, options?: { prepend?: boolean }) => {
      if (event === 'approval/request') {
        if (options?.prepend) answers.unshift(listener as Answer)
        else answers.push(listener as Answer)
      }
      return () => {}
    },
    // The real host has no agent-scoped approval service before session creation.
    get: (name: string) => name === 'tools' ? {
      guard(check: ToolGuard) {
        questionGuard = check
        return () => { questionGuard = undefined }
      },
    } : undefined,
    logger: { info() {}, warn() {}, error() {} }, sessionController: { create: async () => ({ sessionId: 'synthetic-session' }), prompt },
  } as never, { stateDir: root })
  const send = async (text: string, from = 'synthetic-owner') => {
    await until(() => !!deliver)
    const resolve = deliver!
    deliver = undefined
    resolve(Response.json({ ret: 0, get_updates_buf: randomUUID(), msgs: [{ message_type: 1, msg_id: randomUUID(), from_user_id: from, item_list: [{ text_item: { text } }] }] }))
    await until(() => !!deliver)
  }
  const ask = (signal = new AbortController().signal, session = 'synthetic-session') => {
    const question = { agent: { session: { id: session } }, toolName: 'moneycome_record_entry', reason: '合成账本：银行手续费10.00元', signal }
    const dispatch = (index: number): Promise<string> => answers[index]?.(question, () => dispatch(index + 1)) ?? Promise.resolve('next-answerer')
    return dispatch(0)
  }
  const checkTool = (name: string, sessionId = 'synthetic-session') => questionGuard?.({ name, agent: { session: { id: sessionId } } })
  return { root, sent, prompt, send, ask, checkTool, stop: () => dispose() }
}
describe('微信原生批准应答', () => {
  it('微信的事实确认回退到文字，桌面和记账批准仍按原流程', () => {
    const test = fixture()
    expect(test.checkTool('ask_user_question')).toContain('带选项的文字')
    expect(test.checkTool('ask_user_question', 'synthetic-desktop')).toBeUndefined()
    expect(test.checkTool('moneycome_record_entry')).toBeUndefined()
    test.stop()
    expect(test.checkTool('ask_user_question')).toBeUndefined()
  })
  it('只有绑定老板携带本次随机码可批准，确认消息不转给模型', async () => {
    const test = fixture()
    let settled = false
    const decision = test.ask().then(value => { settled = true; return value })
    await until(() => test.sent.length > 0)
    const code = /确认 ([A-F0-9]{12})/.exec(test.sent.join('\n'))![1]!
    await test.send(`确认 ${code}`, 'synthetic-stranger')
    expect(settled).toBe(false)
    await test.send('确认 ABCDEF123456')
    expect(settled).toBe(false)
    await test.send(`确认 ${code}`)
    expect(await decision).toBe('allowed-once')
    expect(test.prompt).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(test.root, 'wechat.json'), 'utf8')).outbox).toEqual([])
  })
  it('明确拒绝返回 rejected', async () => {
    const test = fixture()
    const decision = test.ask()
    await until(() => test.sent.length > 0)
    const code = /确认 ([A-F0-9]{12})/.exec(test.sent.join('\n'))![1]!
    await test.send(`拒绝 ${code}`)
    expect(await decision).toBe('rejected')
    expect(test.prompt).not.toHaveBeenCalled()
  })
  it('取消后旧确认码不能再次批准', async () => {
    const test = fixture()
    const cancel = new AbortController()
    const decision = test.ask(cancel.signal)
    await until(() => test.sent.length > 0)
    const code = /确认 ([A-F0-9]{12})/.exec(test.sent.join('\n'))![1]!
    cancel.abort()
    expect(await decision).toBe('cancelled')
    await test.send(`确认 ${code}`)
    expect(test.sent.join('\n')).toContain('已失效')
    expect(test.prompt).not.toHaveBeenCalled()
  })
  it('停止插件撤销等待，不替桌面或其他会话批准', async () => {
    const test = fixture()
    expect(await test.ask(undefined, 'synthetic-other-session')).toBe('next-answerer')
    expect(test.sent).toEqual([])
    const decision = test.ask()
    await until(() => test.sent.length > 0)
    test.stop()
    expect(await decision).toBe('cancelled')
  })
  it('五分钟没有有效确认则取消', async () => {
    vi.useFakeTimers()
    try {
      const test = fixture()
      const decision = test.ask()
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(await decision).toBe('cancelled')
      test.stop()
    } finally { vi.useRealTimers() }
  })
})
