import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readBalances } from '../src/balances.js'
import { openBook } from '../src/book.js'
import { CompanyOnboarding } from '../src/company-onboarding.js'
import { apply } from '../src/index.js'
import { loadPack } from '../src/pack.js'
import { SAMPLE_COMPANY, seedSampleBook } from '../src/sample-book.js'
import { BookStore } from '../src/store.js'

const NOW = new Date('2026-04-01T00:00:00Z')

function sampleStore(): BookStore {
  const store = new BookStore(':memory:')
  seedSampleBook(store, loadPack(), NOW)
  return store
}

const balanceOf = (result: ReturnType<typeof readBalances>, code: string) =>
  result.accepted ? result.rows.find((r) => r.subjectCode === code) : undefined

describe('样本账', () => {
  it('经会计包记账，凭证按期间连续编号', () => {
    const store = sampleStore()
    expect(store.company()).toEqual({ ...SAMPLE_COMPANY, isSample: true })
    expect(store.postedPeriods()).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  it('已有企业时不重复建', () => {
    const store = sampleStore()
    expect(seedSampleBook(store, loadPack(), NOW)).toBe(false)
    expect(store.postedPeriods()).toHaveLength(3)
  })

  it('每张凭证借贷平衡，累计净额合计为零', () => {
    const store = sampleStore()
    const total = store.movements('2026-03').reduce((sum, m) => sum + m.netDebitCents, 0n)
    expect(total).toBe(0n)
  })
})

describe('查余额', () => {
  it('3 月末银行存款、库存现金、应收账款、应交增值税', () => {
    const result = readBalances(sampleStore(), '2026-03')
    // 银行：300000 - 1280 + 50500 - 860.50 - 25 - 5000 - 3200 + 80800 - 30 - 920.40 - 25
    expect(balanceOf(result, '1002')).toMatchObject({ side: '借', balance: '419959.10' })
    expect(balanceOf(result, '1001')).toMatchObject({ side: '借', balance: '4700.00' })
    expect(balanceOf(result, '1122')).toMatchObject({ side: '借', balance: '60600.00' })
    expect(balanceOf(result, '222101')).toMatchObject({ side: '贷', balance: '1900.00' })
    expect(balanceOf(result, '4001')).toMatchObject({ side: '贷', balance: '300000.00' })
  })

  it('1 月末只累计到 1 月', () => {
    const result = readBalances(sampleStore(), '2026-01')
    expect(balanceOf(result, '1002')).toMatchObject({ balance: '348334.50' })
    expect(balanceOf(result, '1001')).toBeUndefined()
  })

  it.each([
    ['2025-12', 'PERIOD_BEFORE_BOOK'],
    ['2026-04', 'PERIOD_NOT_POSTED'],
    ['2026-3', 'PERIOD_INVALID'],
    ['2026-13', 'PERIOD_INVALID'],
  ])('%s 照实拒绝（%s）', (periodKey, code) => {
    expect(readBalances(sampleStore(), periodKey)).toMatchObject({ accepted: false, code })
  })

  it('没有账本时拒绝', () => {
    expect(readBalances(new BookStore(':memory:'), '2026-03')).toMatchObject({ accepted: false, code: 'NO_BOOK' })
  })
})

describe('插件入口', () => {
  type Tool = Parameters<Parameters<typeof apply>[0]['tools']['register']>[0]
  const cleanups: (() => void)[] = []
  afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

  function location() {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-qianlai-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    return join(directory, 'book.sqlite')
  }

  function activate(bookPath: string) {
    const registered: Tool[] = []
    let dispose = () => {}
    let unregistered = 0
    apply({
      effect(fn) { dispose = fn() },
      tools: {
        register(tool) {
          registered.push(tool)
          return () => { unregistered++ }
        },
      },
    }, { bookPath })
    const stop = () => { dispose(); dispose = () => {} }
    cleanups.push(stop)
    const call = (name: string, args: Record<string, unknown> = {}) =>
      registered.find(tool => tool.name === name)!.execute(args)
    return { registered, call, stop, unregistered: () => unregistered }
  }

  it('注册工具和空库，冷启动与重启都不创建样本账', async () => {
    const bookPath = location()
    const { registered, call, stop, unregistered } = activate(bookPath)
    expect(registered.map((t) => t.name)).toContain('moneycome_read_balances')
    expect(registered.every((t) => t.name.startsWith('moneycome_'))).toBe(true)
    await expect(call('moneycome_book_status')).resolves.toMatchObject({
      accepted: false, code: 'NO_BOOK', businessDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
    await expect(call('moneycome_read_balances', { periodKey: '2026-02' }))
      .resolves.toMatchObject({ accepted: false, code: 'NO_BOOK' })
    stop()
    expect(unregistered()).toBe(registered.length)
    const reopened = new BookStore(bookPath)
    try {
      expect(reopened.company()).toBeUndefined()
      expect(reopened.postedPeriods()).toEqual([])
      const wizard = new CompanyOnboarding(reopened)
      expect(wizard.setMode(wizard.status().revision, 'manual')).toMatchObject({ accepted: true })
    } finally { reopened.close() }
    await expect(activate(bookPath).call('moneycome_book_status')).resolves.toMatchObject({
      accepted: false, code: 'NO_BOOK', onboarding: { completed: false, step: 1 },
    })
  })

  it('升级后旧样本账仍可按原数据查询', async () => {
    const bookPath = location()
    const previous = new BookStore(bookPath)
    try { seedSampleBook(previous, loadPack(), NOW) } finally { previous.close() }
    const { call } = activate(bookPath)
    await expect(call('moneycome_read_balances', { periodKey: '2026-02' })).resolves.toMatchObject({
      accepted: true,
      isSampleBook: true,
      bookedThrough: '2026-03',
    })
  })

  it('升级后保留正式账本，期限仍可通过专用工具查询', async () => {
    const bookPath = location()
    const previous = new BookStore(bookPath)
    try {
      expect(openBook(previous, { companyName: '合成正式账本企业', accountingStartMonth: '2026-01' }))
        .toMatchObject({ accepted: true })
      previous.setOpeningBalances([], NOW)
    } finally { previous.close() }
    const { call } = activate(bookPath)
    const status = await call('moneycome_book_status')
    expect(status).toMatchObject({ accepted: true, company: '合成正式账本企业', isSampleBook: false, openingBalancesEntered: true })
    expect(status).not.toHaveProperty('dueSoon')
    await expect(call('moneycome_upcoming')).resolves.toMatchObject({
      accepted: true, items: expect.arrayContaining([expect.objectContaining({ dueDate: expect.any(String) })]),
    })
  })
})

describe('界面那一行', () => {
  it('mode: ui 不注册工具、不开账本', () => {
    let effects = 0
    apply({ effect: () => effects++, tools: { register: () => () => undefined } } as never, { mode: 'ui' })
    expect(effects).toBe(0)
  })
})
