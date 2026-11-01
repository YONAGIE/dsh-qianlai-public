import { afterEach, describe, expect, it } from 'vitest'

import { openBook } from '../src/book.js'
import { recordEntry } from '../src/entries.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const now = new Date('2026-02-02T00:00:00Z')
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const ownBook = () => {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成凭据测试企业', accountingStartMonth: '2026-01' })
  return store
}
const office = {
  date: '2026-01-10', summary: '合成办公用品', eventKind: 'office_supply',
  facts: { 'settlement.method': 'cash' }, amounts: { invoice_total: '1300.00' },
}

describe('记账自动凭据边界', () => {
  for (const role of ['invoice', 'settlement']) {
    it.each([true, false])(`拒绝手填 ${role}（preview=%s），且不留下凭证`, preview => {
      const store = ownBook()
      expect(recordEntry(store, pack, { ...office, evidenceRoles: [role], preview }, now))
        .toMatchObject({ accepted: false, code: 'ROLE_AUTOMATIC', details: { roles: [role] } })
      expect(store.vouchers({ periodKey: '2026-01' })).toEqual([])
      expect(store.pendingInvoices()).toEqual([])
    })
  }

  it('合同声明不能冒充发票，真实核票关联仍正常补齐发票角色', () => {
    const store = ownBook()
    expect(recordEntry(store, pack, { ...office, evidenceRoles: ['contract'], preview: true }, now))
      .toMatchObject({ accepted: true, missingEvidence: ['invoice'] })
    const invoiceNumber = '00000000000000000001'
    expect(checkInvoice(store, {
      invoiceNumber, issueDate: office.date, buyerName: '合成凭据测试企业', sellerName: '合成供方',
      amountExclTax: '1287.13', taxAmount: '12.87', totalInclTax: '1300.00', taxRate: '1%',
    }, now)).toMatchObject({ recordable: true })
    expect(recordEntry(store, pack, { ...office, invoiceNumber, evidenceRoles: ['contract'] }, now))
      .toMatchObject({ accepted: true, missingEvidence: [] })
    expect(store.invoice(invoiceNumber)?.voucherNo).toBe('PZ-202601-001')
  })
})
