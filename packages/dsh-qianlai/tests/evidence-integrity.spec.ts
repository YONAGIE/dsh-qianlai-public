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

  it.each(['input', 'output'])('%s 发票不能用于相反的业务；预演和写入均保留待记票', direction => {
    const store = ownBook()
    const invoiceNumber = '00000000000000000002'
    const company = store.company()!.name
    expect(checkInvoice(store, {
      invoiceNumber, issueDate: office.date,
      buyerName: direction === 'input' ? company : '合成客户',
      sellerName: direction === 'input' ? '合成供方' : company,
      amountExclTax: '1287.13', taxAmount: '12.87', totalInclTax: '1300.00', taxRate: '1%',
    }, now)).toMatchObject({ recordable: true })
    const sale = { ...office, eventKind: 'sale_service', amounts: { invoice_net: '1287.13', invoice_tax: '12.87', invoice_total: '1300.00' } }
    for (const preview of [true, false]) {
      const wrong = direction === 'input' ? sale : office
      expect(recordEntry(store, pack, { ...wrong, invoiceNumber, preview }, now))
        .toMatchObject({ code: 'INVOICE_DIRECTION_MISMATCH', details: { actual: direction } })
      expect(store.invoice(invoiceNumber)?.voucherNo).toBeNull()
      expect(store.vouchers({ periodKey: '2026-01' })).toEqual([])
    }
    const right = direction === 'input' ? office : sale
    expect(recordEntry(store, pack, { ...right, invoiceNumber }, now)).toMatchObject({ voucherNo: 'PZ-202601-001', missingEvidence: [] })
  })

  it('全零不占凭证号，正常业务中的零税额仍可正常记账', () => {
    const store = ownBook()
    for (const preview of [true, false]) {
      expect(recordEntry(store, pack, {
        ...office, eventKind: 'bank_fee', facts: { 'settlement.method': 'bank' }, amounts: { settlement: '0.00' }, preview,
      }, now)).toMatchObject({ code: 'ZERO_POSTING' })
      expect(store.vouchers({ periodKey: '2026-01' })).toEqual([])
    }
    const result = recordEntry(store, pack, {
      ...office, eventKind: 'sale_service', amounts: { invoice_net: '100', invoice_tax: '0', invoice_total: '100' },
    }, now)
    expect(result).toMatchObject({ voucherNo: 'PZ-202601-001', legs: [{ amount: '100.00' }, { amount: '100.00' }] })
  })

  it('会计包明确跳过的业务仍返回该规则的处理意见', () => {
    const store = ownBook()
    const skipRule = { ruleId: 'rule.test.skip', when: [{ factKey: 'event.kind', equals: 'bank_fee' }], skip: true as const, treatment: '本档不记账' }
    const skipPack = { ...pack, payload: { ...pack.payload, decisionTables: [{ tableId: 'test.skip', rules: [skipRule] }] } }
    expect(recordEntry(store, skipPack, { ...office, eventKind: 'bank_fee', facts: {}, amounts: {} }, now))
      .toMatchObject({ code: 'LEDGER_RULE_SKIPS_EVENT', details: { treatment: '本档不记账' } })
    expect(store.vouchers({ periodKey: '2026-01' })).toEqual([])
  })
})
