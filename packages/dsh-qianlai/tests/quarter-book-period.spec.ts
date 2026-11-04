import { afterEach, describe, expect, it } from 'vitest'

import { openBook, setOpeningBalances } from '../src/book.js'
import { quarterFilingPrep } from '../src/deadlines.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const now = new Date('2026-01-05T03:00:00Z')
const company = '合成季度边界测试企业'
let store: BookStore
afterEach(() => store.close())

function openDecember() {
  store = new BookStore(':memory:')
  openBook(store, { companyName: company, accountingStartMonth: '2025-12' })
  setOpeningBalances(store, pack, [], now)
}

describe('季度申报准备单的建账边界', () => {
  it('完全在建账前的季度返回原因，不生成零收入汇总', () => {
    openDecember()
    expect(quarterFilingPrep(store, pack, '2025-Q1', now)).toMatchObject({
      accepted: false, code: 'PERIOD_BEFORE_BOOK', message: expect.stringContaining('2025-12'),
    })
  })

  it('跨建账月只汇总本账覆盖的月份和同一范围的销项票', () => {
    openDecember()
    for (const [issueDate, invoiceNumber] of [
      ['2025-11-20', '00000000000000000001'], ['2025-12-20', '00000000000000000002'],
    ] as const) {
      expect(checkInvoice(store, {
        issueDate, invoiceNumber, sellerName: company, buyerName: '合成买方',
        amountExclTax: '100.00', taxRate: '1%', taxAmount: '1.00', totalInclTax: '101.00',
      }, now)).toMatchObject({ recordable: true })
    }
    const result = quarterFilingPrep(store, pack, '2025-Q4', now)
    expect(result).toMatchObject({
      accepted: true,
      coverage: { from: '2025-12-01', to: '2025-12-31' },
      months: [{ month: '2025-12', revenueOnBooks: '0.00' }],
      revenueOnBooks: '0.00',
      outputInvoices: [{ count: 1, amountExclTax: '100.00', tax: '1.00' }],
      revenueMinusInvoiced: '-100.00',
      outputInvoicesNotRecorded: ['00000000000000000002'],
      warnings: expect.arrayContaining([expect.stringContaining('建账前')]),
    })
  })
})
