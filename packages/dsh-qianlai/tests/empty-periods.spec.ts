import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readBalances } from '../src/balances.js'
import { openBook, setCompanyFacts, setOpeningBalances } from '../src/book.js'
import { closePeriod } from '../src/closing.js'
import { loadPack } from '../src/pack.js'
import { readProfit, readStatements } from '../src/reports.js'
import { exportReviewPack } from '../src/review-pack.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const now = new Date('2026-04-02T00:00:00Z')
const stores: BookStore[] = []
const roots: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(amount?: string) {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成零业务企业', accountingStartMonth: '2026-01' })
  if (amount !== undefined) setOpeningBalances(store, pack, amount === '0.00' ? [] : [
    { subjectCode: '1001', side: 'debit', amount }, { subjectCode: '4001', side: 'credit', amount },
  ], now)
  setCompanyFacts(store, pack, Object.fromEntries(pack.payload.closingItems.flatMap(item => item.requiredWhen.map(condition => [condition.factKey, 'no']))))
  return store
}

describe('无凭证有效账期', () => {
  it('已确认的期初余额可以直接查询', () => {
    expect(readBalances(fixture('1000.00'), '2026-01')).toMatchObject({ accepted: true, rows: [
      { subjectCode: '1001', balance: '1000.00' }, { subjectCode: '4001', balance: '1000.00' },
    ] })
  })

  it('已确认期初的利润表是零发生额，资产负债表保留期初', () => {
    const store = fixture('1000.00')
    expect(readProfit(store, pack, '2026-01')).toMatchObject({ accepted: true, month: { totals: { profit: '0.00' } } })
    expect(readStatements(store, pack, '2026-01')).toMatchObject({ accepted: true,
      balanceSheet: { assetsTotal: '1000.00', liabilitiesAndEquityTotal: '1000.00', balanced: true },
    })
  })

  it('连续零业务月结账后可查询并导出完整复核包', () => {
    const store = fixture('1000.00')
    expect(closePeriod(store, pack, '2026-01', now)).toMatchObject({ accepted: true })
    expect(closePeriod(store, pack, '2026-02', now)).toMatchObject({ accepted: true })
    expect(store.postedPeriods()).toEqual([])
    expect(readBalances(store, '2026-02')).toMatchObject({ accepted: true, bookedThrough: '2026-02' })
    const root = mkdtempSync(join(tmpdir(), 'qianlai-empty-export-'))
    roots.push(root)
    const result = exportReviewPack(store, pack, '2026-02', root, now)
    expect(result).toMatchObject({ accepted: true, openItems: 0 })
    if (!result.accepted) throw Error('export failed')
    expect(result.files).toHaveLength(8)
    expect(readFileSync(join(result.dir, '4-科目余额.csv'), 'utf8')).toContain('1000.00')
  })

  it('明确确认全零也可读，无确认记录时仍拒绝', () => {
    expect(readBalances(fixture('0.00'), '2026-01')).toMatchObject({ accepted: true, rows: [] })
    expect(readBalances(fixture(), '2026-01')).toMatchObject({ code: 'PERIOD_NOT_POSTED' })
  })

  it('不扩展到没有事实支持的更晚月份，也不越过建账起点', () => {
    const store = fixture('1000.00')
    expect(readBalances(store, '2026-02')).toMatchObject({ code: 'PERIOD_NOT_POSTED' })
    expect(readBalances(store, '2025-12')).toMatchObject({ code: 'PERIOD_BEFORE_BOOK' })
  })
})
