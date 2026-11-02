import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/wechat/index.js'

type Listener = (session: { id: string }, event: { type: string; data?: Record<string, unknown> }) => void
const roots: string[] = []
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const read = (root: string) => JSON.parse(readFileSync(join(root, 'wechat.json'), 'utf8'))
async function until(condition: () => boolean, attempts = 100) {
  for (let i = 0; i < attempts && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qianlai-outbox-'))
  roots.push(root)
  writeFileSync(join(root, 'wechat.json'), JSON.stringify({ botToken: 'synthetic-token', ownerUserId: 'synthetic-owner', sessionId: 'synthetic-session', welcomePending: false, welcomeProgress: 4, welcomeId: 'synthetic-complete' }))
  return root
}
function host(root: string) {
  apply({ effect: fn => { stops.push(fn()) }, on: () => () => {},
    get: () => undefined, logger: { info() {}, warn() {}, error() {} },
    sessionController: { create: async () => ({ sessionId: 'synthetic-session' }), prompt: async () => ({}) },
  }, { stateDir: root })
}
function network(fail: (index: number) => boolean, incoming = true) {
  let polled = false
  const sent: { client_id: string; item_list: { text_item: { text: string } }[] }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/getupdates')) {
      if (!polled && incoming) {
        polled = true
        return Response.json({ ret: 0, msgs: [{ message_type: 1, msg_id: 'synthetic-incoming', from_user_id: 'synthetic-owner', item_list: [{ text_item: { text: '合成问题' } }] }], get_updates_buf: 'synthetic-cursor' })
      }
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }))
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (String(url).endsWith('/sendmessage')) {
      sent.push(JSON.parse(String(init?.body)).msg)
      return fail(sent.length) ? new Response('', { status: 503 }) : Response.json({ message_id: 'synthetic-sent' })
    }
    return Response.json({})
  }))
  return sent
}
function replyingHost(root: string, text: string) {
  let listener: Listener | undefined
  let dispose = () => {}
  apply({ effect: fn => { dispose = fn(); stops.push(dispose) }, on: (_event, fn) => { listener = fn; return () => {} },
    get: () => undefined, logger: { info() {}, warn() {}, error() {} }, sessionController: {
      create: async () => ({ sessionId: 'synthetic-session' }),
      prompt: async request => {
        const emit = (type: string, data: Record<string, unknown>) => listener?.({ id: request.sessionId }, { type, data })
        emit('turn/start', { turn: 1 })
        emit('user/message', { source: { rpcId: request.requestId } })
        emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text }] } })
        emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
        return {}
      },
    },
  }, { stateDir: root })
  return () => dispose()
}
describe('微信回复发送恢复', () => {
  it('临时发送失败自动重试且沿用同一 client_id', async () => {
    const root = fixture()
    const sent = network(index => index === 1)
    replyingHost(root, '合成回复')
    await until(() => sent.length >= 2, 1000)
    expect(sent[1]).toEqual(sent[0])
    await until(() => (read(root).outbox?.length ?? 0) === 0)
  })
  it('长回复中途失败后重启，只续发未确认片段并保留发送身份', async () => {
    const root = fixture()
    const first = network(index => index >= 2)
    const stop = replyingHost(root, '合'.repeat(3200))
    await until(() => first.length >= 2)
    stop()
    expect(read(root).outbox).toHaveLength(2)
    const second = network(() => false, false)
    host(root)
    await until(() => second.length >= 2)
    expect(second[0]!.client_id).toBe(first[1]!.client_id)
    expect(second.map(item => item.item_list[0]!.text_item.text).join('')).toHaveLength(1700)
    await until(() => read(root).outbox.length === 0)
  })
})
