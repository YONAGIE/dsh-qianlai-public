import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { IlinkConnection } from '../src/wechat/ilink.js'
import { apply } from '../src/wechat/index.js'

const roots: string[] = []
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const message = (id: string, text = '合成查询') => ({ msg_id: id, message_type: 1, from_user_id: 'synthetic-owner',
  context_token: 'synthetic-context', item_list: [{ type: 1, text_item: { text } }] })
function poll(messages: object[], batches = 1) {
  let polls = 0
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith('/getupdates')) return Response.json({})
    if (++polls <= batches) return Response.json({ ret: 0, msgs: messages, get_updates_buf: 'cursor-after-batch' })
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }))
      if (init?.signal?.aborted) fail()
      else init?.signal?.addEventListener('abort', fail, { once: true })
    })
  })
  vi.stubGlobal('fetch', fetcher)
}
async function until(condition: () => boolean, attempts = 100) {
  for (let i = 0; i < attempts && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}
function stateDirectory() {
  const root = mkdtempSync(join(tmpdir(), 'qianlai-replay-'))
  roots.push(root)
  writeFileSync(join(root, 'wechat.json'), JSON.stringify({ botToken: 'synthetic-token', ownerUserId: 'synthetic-owner' }))
  return root
}
function host(stateDir: string, prompt = vi.fn(async (_request: unknown) => ({}))) {
  apply({ effect: fn => { stops.push(fn()) }, on: () => () => {}, get: () => undefined,
    logger: { info() {}, warn() {}, error() {} },
    sessionController: { create: async () => ({ sessionId: 'synthetic-session' }), prompt },
  }, { stateDir })
  return prompt
}
describe('微信消息接收的重试边界', () => {
  it('处理失败不确认整批游标，也不越过失败消息处理后续消息', async () => {
    poll([message('one'), message('two')])
    const seen: string[] = []
    const cursors: string[] = []
    const errors: string[] = []
    const connection = new IlinkConnection('synthetic-token', async item => {
      seen.push(item.msg_id!)
      throw Error('synthetic unavailable')
    }, { onCursor: cursor => { cursors.push(cursor) }, onError: error => { errors.push(error) } })
    stops.push(() => connection.stop())
    connection.start()
    await until(() => errors.length > 0)
    connection.stop()
    expect(seen).toEqual(['one'])
    expect(cursors).toEqual([])
  })

  it('同一消息重投只提交一次，不同消息即使文字相同仍分别提交', async () => {
    poll([message('one'), message('one'), message('two')])
    const root = stateDirectory()
    const prompt = host(root)
    await until(() => JSON.parse(readFileSync(join(root, 'wechat.json'), 'utf8')).cursor === 'cursor-after-batch')
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('已处理消息重启后仍去重，不重新上传或提交会话', async () => {
    const root = stateDirectory()
    poll([message('one')])
    const first = host(root)
    await until(() => JSON.parse(readFileSync(join(root, 'wechat.json'), 'utf8')).cursor === 'cursor-after-batch')
    expect(first).toHaveBeenCalledTimes(1)
    stops.pop()!()
    poll([message('one'), message('two')])
    const second = host(root)
    await until(() => second.mock.calls.length > 0)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('会话提交失败不保存成功游标，并使用稳定请求身份供宿主去重', async () => {
    const root = stateDirectory()
    poll([message('one')])
    const first = host(root, vi.fn(async (_request: unknown) => { throw Error('synthetic lost acknowledgement') }))
    await until(() => first.mock.calls.length > 0)
    stops.pop()!()
    expect(JSON.parse(readFileSync(join(root, 'wechat.json'), 'utf8')).cursor).toBeUndefined()
    poll([message('one')])
    const second = host(root)
    await until(() => second.mock.calls.length > 0)
    expect(second.mock.calls[0]![0]).toMatchObject({ requestId: (first.mock.calls[0]![0] as { requestId: string }).requestId })
  })

  it('退避重收失败批次时跳过先前成功消息，只重试失败消息', async () => {
    const root = stateDirectory()
    poll([message('one'), message('two')], 2)
    let attempts = 0
    const prompt = host(root, vi.fn(async (_request: unknown) => {
      if (++attempts === 2) throw Error('synthetic admission unavailable')
      return {}
    }))
    await until(() => JSON.parse(readFileSync(join(root, 'wechat.json'), 'utf8')).cursor === 'cursor-after-batch', 1000)
    expect(prompt).toHaveBeenCalledTimes(3)
    expect(prompt.mock.calls[1]![0]).toMatchObject({ requestId: (prompt.mock.calls[2]![0] as { requestId: string }).requestId })
  })
})
