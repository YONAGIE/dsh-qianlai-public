import { afterEach, describe, expect, it } from 'vitest'

import { bookStatus, openBook, setCompanyFacts, setOpeningBalances } from '../src/book.js'
import { closePeriod, closingCheck } from '../src/closing.js'
import { loadPack } from '../src/pack.js'
import { importStatement } from '../src/statements.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function fixture(opening: boolean, accountingStartMonth = '2026-01') {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成结账企业', accountingStartMonth })
  setCompanyFacts(store, pack, Object.fromEntries(pack.payload.closingItems.flatMap(item => item.requiredWhen.map(condition => [condition.factKey, 'no']))))
  if (opening) setOpeningBalances(store, pack, [], new Date(accountingStartMonth + '-01T00:00:00Z'))
  return store
}

describe('结账必须完成期初与业务期间', () => {
  it('不能跳过期初确认，失败后仍可录入零期初再结账', () => {
    const store = fixture(false)
    const now = new Date('2026-02-02T00:00:00Z')
    expect(closingCheck(store, pack, '2026-01', now)).toMatchObject({
      canClose: false, checks: expect.arrayContaining([expect.objectContaining({ passed: false, blockers: [{ kind: 'opening_balances_unconfirmed' }] })]),
    })
    expect(closePeriod(store, pack, '2026-01', now)).toMatchObject({ accepted: false, code: 'CLOSING_BLOCKED' })
    expect(store.lockedPeriods()).toEqual([])
    expect(setOpeningBalances(store, pack, [], now)).toMatchObject({ accepted: true })
    expect(closePeriod(store, pack, '2026-01', now)).toMatchObject({ accepted: true, locked: true })
  })

  it.each(['2026-01-15T00:00:00Z', '2026-01-31T15:59:59Z'])('%s 北京时间期间结束前不能锁月', timestamp => {
    const store = fixture(true)
    const now = new Date(timestamp)
    expect(closingCheck(store, pack, '2026-01', now)).toMatchObject({ canClose: false })
    expect(closePeriod(store, pack, '2026-01', now)).toMatchObject({ accepted: false, code: 'CLOSING_BLOCKED' })
    expect(store.lockedPeriods()).toEqual([])
    expect(store.vouchers({ periodKey: '2026-01' })).toEqual([])
  })

  it('北京时间次月零点即可结账，不等待UTC换月', () => {
    const store = fixture(true)
    expect(closePeriod(store, pack, '2026-01', new Date('2026-01-31T16:00:00Z'))).toMatchObject({ accepted: true, locked: true })
  })

  it('月中只报已经到期的流水缺口，期满后恢复全月校验', () => {
    const store = fixture(true, '2026-11')
    // UTC 仍是 12 日，业务日已是北京时间的 13 日。
    const now = new Date('2026-11-12T16:00:00Z')
    const accountRef = '合成银行 尾号 1234'
    const statement = (from: string, to: string) => ({
      accountRef, periodStart: from, periodEnd: to,
      printedPeriodStart: from, printedPeriodEnd: to, printedOpeningBalance: '0.00',
      printedClosingBalance: '0.00', printedRowCount: 0, rows: [],
    })
    const periodKey = '2026-11'
    const closing = (date: Date) => closingCheck(store, pack, periodKey, date)
    const gaps = (date: Date) => {
      const report = closing(date)
      if (!('checks' in report)) throw Error('缺少结账检查')
      return report.checks[0]
    }

    expect(bookStatus(store, { pack, now })).toMatchObject({ businessDate: '2026-11-13' })
    expect(importStatement(store, statement('2026-11-01', '2026-11-11'), now)).toMatchObject({
      accepted: true, coveredRange: { from: '2026-11-01', to: '2026-11-11' },
    })
    expect(gaps(now)).toMatchObject({
      passed: false, blockers: [{ kind: 'statement_gap', account: accountRef, from: '2026-11-12', to: '2026-11-13' }],
    })
    expect(importStatement(store, statement('2026-11-12', '2026-11-13'), now)).toMatchObject({ accepted: true })
    expect(gaps(now)).toMatchObject({ passed: true, blockers: [] })
    expect(closing(now)).toMatchObject({
      canClose: false, periodEnded: false, statementRange: { from: '2026-11-01', to: '2026-11-13' },
    })

    const remaining = statement('2026-11-14', '2026-11-30')
    expect(importStatement(store, remaining, now)).toMatchObject({
      code: 'PERIOD_FUTURE', details: { businessDate: '2026-11-13', periodEnd: '2026-11-30' },
    })
    expect(store.statementCoverage()).toHaveLength(2)
    expect(closePeriod(store, pack, periodKey, now)).toMatchObject({ code: 'CLOSING_BLOCKED' })

    const nextMonth = new Date('2026-11-30T16:00:00Z')
    expect(gaps(nextMonth)).toMatchObject({
      passed: false, blockers: [{ kind: 'statement_gap', account: accountRef, from: '2026-11-14', to: '2026-11-30' }],
    })
    expect(closePeriod(store, pack, periodKey, nextMonth)).toMatchObject({ code: 'CLOSING_BLOCKED' })
    expect(importStatement(store, remaining, nextMonth)).toMatchObject({ accepted: true })
    expect(closePeriod(store, pack, periodKey, nextMonth)).toMatchObject({ accepted: true, locked: true })
  })

  it('未来月份继续拒绝，当前月份可列出其他预检问题', () => {
    const store = fixture(true)
    const now = new Date('2026-01-15T00:00:00Z')
    expect(closingCheck(store, pack, '2026-02', now)).toMatchObject({ code: 'PERIOD_FUTURE' })
    expect(closingCheck(store, pack, '2026-01', now)).toMatchObject({ accepted: true, locked: false, canClose: false })
  })
})
