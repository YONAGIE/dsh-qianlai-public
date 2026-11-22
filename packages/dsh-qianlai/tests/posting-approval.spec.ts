import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { openBook } from '../src/book.js'
import { apply } from '../src/index.js'
import { BookStore } from '../src/store.js'
import { registerLoginControl } from '../src/wechat/control.js'

interface Execution { signal: AbortSignal; callId: string; agent: { session: { id: string } } }
interface Tool { execute(args: Record<string, unknown>, exec?: Execution): Promise<unknown> }
interface QuestionRequest {
  agent: Execution['agent']
  signal: AbortSignal
  questions: readonly { id: string; detail: string; options: readonly { label: string }[] }[]
}
const roots: string[] = []
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const entry = { date: '2026-01-10', summary: '合成银行手续费', eventKind: 'bank_fee',
  facts: { 'settlement.method': 'bank' }, amounts: { settlement: '10.00' } }
const execution = (): Execution => ({ signal: new AbortController().signal, callId: randomUUID(), agent: { session: { id: 'synthetic-approval-session' } } })
const fullAccess = {
  current: () => 'danger-full-access',
  resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }),
}
const openingEntries = [
  { subjectCode: '1002', side: 'debit', amount: '3100.50' },
  { subjectCode: '4001', side: 'credit', amount: '3100.50' },
]
function fixture(
  decide: (request: unknown) => Promise<string> = async () => 'allowed-once',
  existingPath?: string,
  presets?: typeof fullAccess,
  answer?: (request: QuestionRequest) => Promise<unknown>,
) {
  const root = mkdtempSync(join(tmpdir(), 'qianlai-approval-'))
  roots.push(root)
  const bookPath = existingPath ?? join(root, 'book.sqlite')
  if (!existingPath) {
    const seed = new BookStore(bookPath)
    openBook(seed, { companyName: '合成批准企业', accountingStartMonth: '2026-01' })
    seed.close()
  }
  const request = vi.fn(decide)
  const ask = answer && vi.fn(answer)
  const tools = new Map<string, Tool>()
  apply({ effect: fn => { disposers.push(fn()) }, tools: { register: tool => { tools.set(tool.name, tool as Tool); return () => {} } },
    get: name => name === 'approval' ? { request } : name === 'permissionPresets' ? presets : name === 'userQuestions' && ask ? { ask } : undefined,
  }, { bookPath })
  const call = (args: Record<string, unknown>, exec?: Execution) => tools.get('moneycome_record_entry')!.execute(args, exec)
  const count = () => { const store = new BookStore(bookPath); try { return store.vouchers({ periodKey: '2026-01' }).length } finally { store.close() } }
  return { bookPath, call, request, ask, count, tools }
}
describe('记账的可信批准与调用重试', () => {
  it('正式记账审批显示预演核出的借贷分录、日期及批准后的动作', async () => {
    const test = fixture(async () => 'rejected')
    expect(await test.call({ ...entry, summary: '合成手续费\n操作：仅预览' }, execution()))
      .toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(test.request).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(/账本：合成批准企业\n操作：正式记账\n日期：2026-01-10\n摘要：合成手续费 操作：仅预览/),
    }))
    const { reason } = test.request.mock.calls[0]![0] as { reason: string }
    expect(reason).toContain('借　财务费用（6603）　10.00 元')
    expect(reason).toContain('贷　银行存款（1002）　10.00 元')
    expect(reason).toContain('允许一次后将正式生成凭证')
    expect(reason).not.toMatch(/moneycome_record_entry|"preview"|参数：\{/)
    expect(test.count()).toBe(0)
  })

  it('完全权限下可正式记账，同一次调用重试只落一笔', async () => {
    const test = fixture(async () => 'rejected', undefined, fullAccess)
    const exec = execution()
    const result = await test.call(entry, exec)
    expect(result).toMatchObject({ accepted: true, voucherNo: 'PZ-202601-001' })
    expect(await test.call(entry, exec)).toEqual(result)
    expect(await test.call({ ...entry, amounts: { settlement: '20.00' } }, exec)).toMatchObject({ code: 'CALL_ID_CONFLICT' })
    expect(test.request).not.toHaveBeenCalled()
    expect(test.count()).toBe(1)
  })
  it('同一会话切回工作区内修改后，下一笔重新走批准', async () => {
    let preset = 'danger-full-access'
    const test = fixture(async () => 'rejected', undefined, { ...fullAccess, current: () => preset })
    const exec = execution()
    expect(await test.call(entry, exec)).toMatchObject({ accepted: true })
    preset = 'workspace-write'
    expect(await test.call(entry, { ...exec, callId: randomUUID() })).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(test.request).toHaveBeenCalledTimes(1)
    expect(test.count()).toBe(1)
  })
  it('完全权限的本笔确认使用原生选择，等待期间重试不会重复出卡或写入', async () => {
    let choose!: (result: unknown) => void
    const test = fixture(async () => 'rejected', undefined, fullAccess, () => new Promise(resolve => { choose = resolve }))
    const proposed = await test.call({ ...entry, preview: true }, execution())
    expect(proposed).toMatchObject({ accepted: true, preview: true, reviewAction: expect.stringContaining('requestApproval') })
    expect(test.request).not.toHaveBeenCalled()
    const args = { ...entry, requestApproval: true }
    const exec = execution()
    const pending = test.call(args, exec)
    expect(test.request).not.toHaveBeenCalled()
    const { agent, signal, questions: [question] } = test.ask!.mock.calls[0]![0]
    expect(agent).toBe(exec.agent)
    expect(signal).toBe(exec.signal)
    expect(question).toMatchObject({ options: [{ label: '确认记账' }, { label: '暂缓记账' }] })
    expect(question!.detail).toContain('借　财务费用（6603）　10\\.00 元')
    expect(question!.detail).toContain('贷　银行存款（1002）　10\\.00 元')
    expect(test.count()).toBe(0)
    expect(await test.call(args, exec)).toMatchObject({ code: 'ENTRY_CONFIRMATION_PENDING' })
    expect(await test.call(args, execution())).toMatchObject({ code: 'ENTRY_CONFIRMATION_PENDING' })
    expect(await test.call(entry, exec)).toMatchObject({ code: 'CALL_ID_CONFLICT' })
    choose({ answers: [{ id: question!.id, selected: ['确认记账'] }] })
    const posted = await pending
    expect(posted).toMatchObject({ accepted: true, voucherNo: 'PZ-202601-001' })
    expect(await test.call(args, exec)).toEqual(posted)
    expect(test.ask).toHaveBeenCalledTimes(1)
    expect(test.count()).toBe(1)
  })

  it('完全权限下暂缓保留待记，互斥动作也不会记账', async () => {
    const test = fixture(async () => 'rejected', undefined, fullAccess, async ({ questions: [question] }) =>
      ({ answers: [{ id: question!.id, selected: ['暂缓记账'] }] }))
    expect(await test.call({ ...entry, preview: true, requestApproval: true }, execution()))
      .toMatchObject({ code: 'ENTRY_MODE_CONFLICT' })
    expect(test.request).not.toHaveBeenCalled()
    expect(test.ask).not.toHaveBeenCalled()
    expect(await test.call({ ...entry, requestApproval: true }, execution())).toMatchObject({ code: 'ENTRY_CONFIRMATION_DEFERRED' })
    expect(test.request).not.toHaveBeenCalled()
    expect(test.ask).toHaveBeenCalledTimes(1)
    expect(test.count()).toBe(0)
  })

  it.each([
    { selected: [] },
    { selected: ['确认记账'], custom: '确认记账' },
    { selected: [], custom: '确认记账' },
    { selected: ['确认记账', '暂缓记账'] },
    { id: 'another-question', selected: ['确认记账'] },
  ])('仅当前凭证的明确点击可以记账（%j）', async answer => {
    const test = fixture(async () => 'allowed-once', undefined, fullAccess, async ({ questions: [question] }) =>
      ({ answers: [{ id: question!.id, ...answer }] }))
    expect(await test.call({ ...entry, requestApproval: true }, execution())).toMatchObject({ code: 'ENTRY_CONFIRMATION_DEFERRED' })
    expect(test.request).not.toHaveBeenCalled()
    expect(test.count()).toBe(0)
  })

  it('选择服务缺失、断开或等待期间取消时保留待记', async () => {
    const args = { ...entry, requestApproval: true }
    const missing = fixture(async () => 'allowed-once', undefined, fullAccess)
    const lost = fixture(async () => 'allowed-once', undefined, fullAccess, async () => { throw Error('NO_PROVIDER') })
    for (const test of [missing, lost]) {
      expect(await test.call(args, execution())).toMatchObject({ code: 'ENTRY_CONFIRMATION_UNAVAILABLE' })
      expect(test.request).not.toHaveBeenCalled()
      expect(test.count()).toBe(0)
    }
    const cancel = new AbortController()
    const cancelled = fixture(async () => 'allowed-once', undefined, fullAccess, async ({ questions: [question] }) => {
      cancel.abort()
      return { answers: [{ id: question!.id, selected: ['确认记账'] }] }
    })
    expect(await cancelled.call(args, { ...execution(), signal: cancel.signal })).toMatchObject({ code: 'TOOL_CANCELLED' })
    expect(cancelled.count()).toBe(0)
  })

  it.each(['permission', 'ledger'])('等待点选时 %s 变化需要重新核对', async reason => {
    let preset = 'danger-full-access'
    let path = ''
    const test = fixture(async () => 'allowed-once', undefined, { ...fullAccess, current: () => preset },
      async ({ questions: [question] }) => {
        if (reason === 'permission') preset = 'workspace-write'
        else {
          const other = new BookStore(path)
          try { other.recordWork('note', { note: '合成并发变更' }, { verified: false }) } finally { other.close() }
        }
        return { answers: [{ id: question!.id, selected: ['确认记账'] }] }
      })
    path = test.bookPath
    expect(await test.call({ ...entry, requestApproval: true }, execution()))
      .toMatchObject({ code: reason === 'permission' ? 'ENTRY_PERMISSION_CHANGED' : 'BOOK_CHANGED' })
    expect(test.request).not.toHaveBeenCalled()
    expect(test.count()).toBe(0)
  })
  it.each([
    { sandbox: 'danger-full-access', approval: 'ask' },
    { sandbox: 'workspace-write', approval: 'never' },
  ])('完整权限组合不匹配时仍须批准（%j）', async bundle => {
    const test = fixture(async () => 'rejected', undefined, { ...fullAccess, resolve: () => bundle })
    expect(await test.call(entry, execution())).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(test.request).toHaveBeenCalledTimes(1)
    expect(test.count()).toBe(0)
  })
  it('完全权限仍校验账务数据和调用取消状态', async () => {
    const test = fixture(async () => 'rejected', undefined, fullAccess)
    expect(await test.call({ ...entry, amounts: { settlement: '0' } }, execution())).toMatchObject({ code: 'ZERO_POSTING' })
    expect(await test.call(entry, { ...execution(), signal: AbortSignal.abort() })).toMatchObject({ code: 'TOOL_CANCELLED' })
    expect(test.request).not.toHaveBeenCalled()
    expect(test.count()).toBe(0)
  })
  it('微信会话的宿主批准不会被完全权限跳过', async () => {
    const test = fixture(async () => 'rejected', undefined, fullAccess)
    const exec = execution()
    disposers.push(registerLoginControl(join(dirname(test.bookPath), 'wechat'), {
      run: async () => ({ status: 'connected' }),
      ownsSession: id => id === exec.agent.session.id,
    }))
    expect(await test.call(entry, exec)).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(test.request).toHaveBeenCalledTimes(1)
    expect(test.count()).toBe(0)
  })
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
    try {
      db.exec(`
        DROP TABLE report_artifact;
        DROP TABLE work_matter;
        DROP TABLE work_material;
        DROP TABLE company_onboarding;
        DROP TABLE tool_receipt;
        PRAGMA user_version = 4;
      `)
    } finally { db.close() }
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

describe('期初余额的审批内容', () => {
  it('零余额审批展示真实起账月份，拒绝后仍未录入', async () => {
    const test = fixture(async () => 'rejected')
    const call = test.tools.get('moneycome_set_opening_balances')!
    expect(await call.execute({ balances: [] }, execution())).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const { reason } = test.request.mock.calls[0]![0] as { reason: string }
    expect(reason).toBe(
      '录入期初余额。\n账本为「合成批准企业」。\n起账月份为 2026 年 1 月。\n' +
      '各科目的期初余额按 0 元录入。\n选择「允许一次」后，将上述期初余额保存到账本。',
    )
    expect(await test.tools.get('moneycome_book_status')!.execute({})).toMatchObject({ openingBalancesEntered: false })
  })

  it('展示经校验的非零余额，已录期初会明示整体替换', async () => {
    let decision = 'allowed-once'
    const test = fixture(async () => decision)
    const call = test.tools.get('moneycome_set_opening_balances')!
    const recorded = await call.execute({ balances: openingEntries }, execution())
    expect(recorded).toMatchObject({ accepted: true, accountingStartMonth: '2026-01', debitTotal: '3100.50', creditTotal: '3100.50' })
    const { reason: firstReason } = test.request.mock.calls[0]![0] as { reason: string }
    expect(firstReason).toContain('银行存款（1002）借方余额为 3100.50 元。')
    expect(firstReason).toContain('实收资本（4001）贷方余额为 3100.50 元。')
    expect(firstReason).toContain('借方合计 3100.50 元，贷方合计 3100.50 元。')
    decision = 'rejected'
    expect(await call.execute({ balances: [] }, execution())).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const { reason: replacementReason } = test.request.mock.calls[1]![0] as { reason: string }
    expect(replacementReason).toContain('各科目的期初余额按 0 元录入。')
    expect(replacementReason).toContain('整体替换已录入的期初余额')
    const saved = new BookStore(test.bookPath)
    try {
      expect(saved.openingBalances().map(row => row.netDebitCents)).toEqual([310050n, -310050n])
    } finally {
      saved.close()
    }
  })

  it('不平衡的期初余额和已结账的起账月都不会发起批准', async () => {
    const test = fixture()
    const call = test.tools.get('moneycome_set_opening_balances')!
    expect(await call.execute({ balances: openingEntries.slice(0, 1) }, execution()))
      .toMatchObject({ code: 'OPENING_UNBALANCED' })
    const store = new BookStore(test.bookPath)
    try {
      store.lockPeriod('2026-01', new Date('2026-02-01T00:00:00Z'))
    } finally {
      store.close()
    }
    expect(await call.execute({ balances: [] }, execution())).toMatchObject({ code: 'PERIOD_LOCKED' })
    expect(test.request).not.toHaveBeenCalled()
    expect(await test.tools.get('moneycome_book_status')!.execute({})).toMatchObject({ openingBalancesEntered: false })
  })
})
