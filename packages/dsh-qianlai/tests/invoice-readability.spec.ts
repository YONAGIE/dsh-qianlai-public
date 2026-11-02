import { afterEach, describe, expect, it } from 'vitest'

import { openBook } from '../src/book.js'
import { recordEntry } from '../src/entries.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'

const now = new Date('2026-02-02T00:00:00Z')
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const invoice = {
  invoiceNumber: '00000000000000000001', issueDate: '2026-01-10',
  buyerName: '合成不可读测试企业', sellerName: '合成供方',
  amountExclTax: '1287.13', taxAmount: '12.87', totalInclTax: '1300.00', taxRate: '1%',
}
function ownBook() {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: invoice.buyerName, accountingStartMonth: '2026-01' })
  return store
}

describe('发票不可读字段优先级', () => {
  it.each(['totalInclTax', 'totalInclTaxCents'])('%s 标记优先于候选合计，不保存发票', key => {
    const store = ownBook()
    expect(checkInvoice(store, { ...invoice, unreadable: [key] }, now))
      .toMatchObject({ recordable: false, readability: 'unreadable', amounts: { invoice_total: null } })
    expect(store.invoice(invoice.invoiceNumber)).toBeUndefined()
  })

  it.each([
    ['amountExclTax', 'invoice_net'], ['taxAmount', 'invoice_tax'],
  ])('%s 不被可解析候选值覆盖', (key, amountKey) => {
    expect(checkInvoice(ownBook(), { ...invoice, unreadable: [key] }, now))
      .toMatchObject({ readability: 'partiallyUnreadable', amounts: { [amountKey!]: null } })
  })

  it('未声明不可读的真实候选值仍正常解析', () => {
    const store = ownBook()
    expect(checkInvoice(store, invoice, now))
      .toMatchObject({ recordable: true, amounts: { invoice_total: '1300.00', invoice_net: '1287.13', invoice_tax: '12.87' } })
    expect(store.invoice(invoice.invoiceNumber)?.totalCents).toBe(130000n)
  })

  it('可读合计不能让不可读净额进入已核票据或被后续销售记账使用', () => {
    const store = ownBook()
    expect(checkInvoice(store, {
      ...invoice, sellerName: invoice.buyerName, buyerName: '合成客户', unreadable: ['amountExclTax'],
    }, now)).toMatchObject({ recordable: true, readability: 'partiallyUnreadable' })
    expect(store.invoice(invoice.invoiceNumber)?.facts.amountExclTax).toBeUndefined()
    expect(recordEntry(store, loadPack(), {
      date: invoice.issueDate, summary: '合成销售', eventKind: 'sale_service', facts: { 'settlement.method': 'unsettled' },
      amounts: { invoice_total: '1300.00', invoice_net: '1287.13', invoice_tax: '12.87' }, invoiceNumber: invoice.invoiceNumber,
    }, now)).toMatchObject({ accepted: false, code: 'INVOICE_AMOUNT_MISMATCH' })
    expect(store.vouchers({ periodKey: '2026-01' })).toEqual([])
  })
})
