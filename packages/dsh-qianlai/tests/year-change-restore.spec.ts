import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { openBook, setCompanyFacts, setOpeningBalances } from '../src/book.js'
import { closePeriod, closingCheck } from '../src/closing.js'
import { recordEntry } from '../src/entries.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import { readStatements } from '../src/reports.js'
import { BookStore } from '../src/store.js'

it('年末结账后恢复账本，次年余额承接、利润表本年累计重新起算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qianlai-year-change-'))
  const original = join(dir, 'book.sqlite')
  const pack = loadPack()
  const now = new Date('2026-02-03T03:00:00Z')
  const company = '合成跨年恢复测试企业'
  const purchase = (store: BookStore, date: string, invoiceNumber: string, total: string) => {
    expect(checkInvoice(store, { issueDate: date, invoiceNumber, buyerName: company, sellerName: '合成供方', totalInclTax: total }, now))
      .toMatchObject({ recordable: true })
    expect(recordEntry(store, pack, {
      date, invoiceNumber, summary: '购买办公用品', eventKind: 'office_supply',
      facts: { 'settlement.method': 'cash' }, amounts: { invoice_total: total },
    }, now)).toMatchObject({ accepted: true })
  }
  try {
    const store = new BookStore(original)
    try {
      openBook(store, { companyName: company, accountingStartMonth: '2025-12' })
      setOpeningBalances(store, pack, [
        { subjectCode: '1001', side: 'debit', amount: '1000.00' }, { subjectCode: '4001', side: 'credit', amount: '1000.00' },
      ], now)
      purchase(store, '2025-12-04', '00000000000000000001', '101.00')
      expect(readStatements(store, pack, '2025-12')).toMatchObject({
        balanceSheet: { balanced: true, assetsTotal: '899.00', unclosedProfitInRetained: '-101.00' },
        profit: { yearToDate: { totals: { profit: '-101.00' } } },
      })
      const check = closingCheck(store, pack, '2025-12', now)
      if (!('checks' in check)) throw new Error('没有生成结账检查')
      const facts = check.checks.flatMap(c => c.blockers).flatMap(b => 'factKey' in b ? [[b.factKey, 'no']] : [])
      setCompanyFacts(store, pack, Object.fromEntries(facts))
      expect(closePeriod(store, pack, '2025-12', now)).toMatchObject({
        accepted: true, locked: true, transferVouchers: ['PZ-202512-002'], profit: { profit: '-101.00' },
      })
    } finally {
      store.close()
    }
    const copy = join(dir, 'restored.sqlite')
    copyFileSync(original, copy)
    const restored = new BookStore(copy)
    try {
      expect(restored.lockedPeriods()).toContain('2025-12')
      expect(readStatements(restored, pack, '2025-12')).toMatchObject({
        balanceSheet: { balanced: true, assetsTotal: '899.00', liabilitiesAndEquityTotal: '899.00' },
        profit: { month: { totals: { profit: '-101.00' } } },
      })
      purchase(restored, '2026-01-04', '00000000000000000002', '202.00')
      expect(readStatements(restored, pack, '2026-01')).toMatchObject({
        balanceSheet: { balanced: true, assetsTotal: '697.00' },
        profit: { month: { totals: { profit: '-202.00' } }, yearToDate: { from: '2026-01', totals: { profit: '-202.00' } } },
      })
    } finally {
      restored.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
