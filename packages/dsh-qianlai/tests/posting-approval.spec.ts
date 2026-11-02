import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { openBook } from '../src/book.js'
import { apply } from '../src/index.js'
import { BookStore } from '../src/store.js'

interface Execution { signal: AbortSignal; callId: string; agent: { session: { id: string } } }
interface Tool { execute(args: Record<string, unknown>, exec?: Execution): Promise<unknown> }
const roots: string[] = []
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const entry = { date: '2026-01-10', summary: '合成银行手续费', eventKind: 'bank_fee',
  facts: { 'settlement.method': 'bank' }, amounts: { settlement: '10.00' } }
const execution = (): Execution => ({ signal: new AbortController().signal, callId: randomUUID(), agent: { session: { id: 'synthetic-approval-session' } } })
function fixture(decide: (request: unknown) => Promise<string> = async () => 'allowed-once', existingPath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'qianlai-approval-'))
  roots.push(root)
  const bookPath = existingPath ?? join(root, 'book.sqlite')
  if (!existingPath) {
    const seed = new BookStore(bookPath)
    openBook(seed, { companyName: '合成批准企业', accountingStartMonth: '2026-01' })
    seed.close()
  }
  const request = vi.fn(decide)
  const tools = new Map<string, Tool>()
  apply({ effect: fn => { disposers.push(fn()) }, tools: { register: tool => { tools.set(tool.name, tool as Tool); return () => {} } },
    get: name => name === 'approval' ? { request } : undefined,
  }, { bookPath })
  const call = (args: Record<string, unknown>, exec?: Execution) => tools.get('moneycome_record_entry')!.execute(args, exec)
  const count = () => { const store = new BookStore(bookPath); try { return store.vouchers({ periodKey: '2026-01' }).length } finally { store.close() } }
  return { bookPath, call, request, count, tools }
}
describe('记账的可信批准与调用重试', () => {
  it('没有宿主调用身份时不能用模型填写的 confirmed 字段替代批准', async () => {
    const test = fixture()
    expect(await test.call({ ...entry, confirmed: true })).toMatchObject({ accepted: false, code: 'APPROVAL_UNAVAILABLE' })
    expect(test.count()).toBe(0)
    expect(test.request).not.toHaveBeenCalled()
  })
  it.each(['rejected', 'cancelled', 'unavailable'])('%s 不落账', async outcome => {
    const test = fixture(async () => outcome)
    expect(await test.call(entry, execution())).toMatchObject({ accepted: false })
    expect(test.count()).toBe(0)
  })
  it('预演不请求批准；没有批准的后续正式调用仍拒绝', async () => {
    const test = fixture(async () => 'rejected')
    expect(await test.call({ ...entry, preview: true })).toMatchObject({ accepted: true, preview: true })
    expect(test.request).not.toHaveBeenCalled()
    expect(await test.call(entry, execution())).toMatchObject({ accepted: false })
    expect(test.count()).toBe(0)
  })
  it('一次批准只执行一次，同一宿主调用重试返回原凭证', async () => {
    const test = fixture()
    const exec = execution()
    const first = await test.call(entry, exec)
    expect(first).toMatchObject({ accepted: true, voucherNo: 'PZ-202601-001' })
    expect(await test.call(entry, exec)).toEqual(first)
    expect(test.request).toHaveBeenCalledTimes(1)
    expect(test.count()).toBe(1)
  })
  it('相同金额的独立业务可以取得各自批准，不按文字或金额误去重', async () => {
    const test = fixture()
    expect(await test.call(entry, execution())).toMatchObject({ accepted: true })
    expect(await test.call(entry, execution())).toMatchObject({ accepted: true })
    expect(test.count()).toBe(2)
    expect(test.request).toHaveBeenCalledTimes(2)
  })
  it('同一宿主调用身份不能替换为不同参数再记一笔', async () => {
    const test = fixture()
    const exec = execution()
    expect(await test.call(entry, exec)).toMatchObject({ accepted: true })
    expect(await test.call({ ...entry, amounts: { settlement: '20.00' } }, exec))
      .toMatchObject({ accepted: false, code: 'CALL_ID_CONFLICT' })
    expect(test.count()).toBe(1)
  })
  it('批准等待中账本发生变化时拒绝过期操作，也不持有写锁', async () => {
    let path = ''
    const test = fixture(async () => {
      const other = new BookStore(path)
      try { other.recordWork('note', { note: '合成并发变更' }, { verified: false }) } finally { other.close() }
      return 'allowed-once'
    })
    path = test.bookPath
    expect(await test.call(entry, execution())).toMatchObject({ accepted: false, code: 'BOOK_CHANGED' })
    expect(test.count()).toBe(0)
  })
  it('批准期间被取消，不落账', async () => {
    const cancel = new AbortController()
    const test = fixture(async () => { cancel.abort(); return 'allowed-once' })
    expect(await test.call(entry, { ...execution(), signal: cancel.signal })).toMatchObject({ accepted: false })
    expect(test.count()).toBe(0)
  })
  it('重启插件后同一宿主调用仍返回原回执，不再次批准或入账', async () => {
    const first = fixture()
    const exec = execution()
    const result = await first.call(entry, exec)
    disposers.pop()!()
    const second = fixture(async () => 'rejected', first.bookPath)
    expect(await second.call(entry, exec)).toEqual(result)
    expect(second.request).not.toHaveBeenCalled()
    expect(second.count()).toBe(1)
  })
  it('旧版账本追加迁移后保留已有凭证与业务记录', async () => {
    const old = fixture()
    expect(await old.call(entry, execution())).toMatchObject({ accepted: true })
    disposers.pop()!()
    const db = new DatabaseSync(old.bookPath)
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
    db.exec(`DROP TABLE tool_receipt; PRAGMA user_version = ${version - 1}`)
    db.close()
    const migrated = fixture(async () => 'allowed-once', old.bookPath)
    expect(migrated.count()).toBe(1)
    expect(await migrated.call(entry, execution())).toMatchObject({ accepted: true, voucherNo: 'PZ-202601-002' })
    const store = new BookStore(old.bookPath)
    try { expect(store.workEvents()).toHaveLength(2) } finally { store.close() }
  })
  it('并发重试同一调用只提交一份账务结果', async () => {
    const resolve: (() => void)[] = []
    const test = fixture(async () => { await new Promise<void>(done => { resolve.push(done) }); return 'allowed-once' })
    const exec = execution()
    const first = test.call(entry, exec)
    const second = test.call(entry, exec)
    expect(resolve).toHaveLength(2)
    for (const done of resolve) done()
    const results = await Promise.all([first, second])
    expect(results[0]).toEqual(results[1])
    expect(test.count()).toBe(1)
  })
  it.each(['open_book', 'set_opening_balances', 'void_voucher', 'reverse_voucher', 'close_period'])('%s 同样拒绝缺少宿主身份的写入', async name => {
    const test = fixture()
    const args: Record<string, Record<string, unknown>> = {
      open_book: { companyName: '合成替换企业', accountingStartMonth: '2026-01' },
      set_opening_balances: { balances: [] }, void_voucher: { voucherNo: 'PZ-202601-001', reason: '合成作废理由' },
      reverse_voucher: { voucherNo: 'PZ-202601-001', date: '2026-02-01', reason: '合成冲销理由' }, close_period: { periodKey: '2026-01' },
    }
    expect(await test.tools.get(`moneycome_${name}`)!.execute(args[name]!)).toMatchObject({ accepted: false, code: 'APPROVAL_UNAVAILABLE' })
    expect(test.count()).toBe(0)
  })
})
