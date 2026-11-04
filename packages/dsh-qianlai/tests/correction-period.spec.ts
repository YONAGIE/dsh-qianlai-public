import { afterEach, describe, expect, it } from 'vitest'

import { openBook, setCompanyFacts, setOpeningBalances } from '../src/book.js'
import { closePeriod } from '../src/closing.js'
import { recordEntry, reverseVoucher, voidVoucher } from '../src/entries.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const now = new Date('2026-04-02T00:00:00Z')
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const entry = {
  date: '2026-01-10', summary: '合成办公用品', eventKind: 'office_supply',
  facts: { 'settlement.method': 'cash' }, amounts: { invoice_total: '1300.00' }, invoiceNumber: '00000000000000000001',
}
function fixture() {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成更正企业', accountingStartMonth: '2026-01' })
  setOpeningBalances(store, pack, [
    { subjectCode: '1001', side: 'debit', amount: '5000.00' }, { subjectCode: '4001', side: 'credit', amount: '5000.00' },
  ], now)
  setCompanyFacts(store, pack, Object.fromEntries(pack.payload.closingItems.flatMap(item => item.requiredWhen.map(condition => [condition.factKey, 'no']))))
  expect(checkInvoice(store, {
    invoiceNumber: entry.invoiceNumber, issueDate: entry.date, buyerName: '合成更正企业', sellerName: '合成供方',
    amountExclTax: '1287.13', taxAmount: '12.87', totalInclTax: '1300.00', taxRate: '1%',
  }, now)).toMatchObject({ recordable: true })
  expect(recordEntry(store, pack, entry, now)).toMatchObject({ voucherNo: 'PZ-202601-001' })
  expect(closePeriod(store, pack, '2026-01', now)).toMatchObject({ accepted: true })
  expect(reverseVoucher(store, pack, ['closing.pl_transfer'], {
    voucherNo: 'PZ-202601-001', date: '2026-03-05', reason: '合成付款方式更正',
  }, now)).toMatchObject({ voucherNo: 'PZ-202603-001' })
  return store
}

describe('更正不得先于冲销期间', () => {
  it.each([true, false])('拒绝更早月份（preview=%s），不改变原月、发票与冲销', preview => {
    const store = fixture()
    const before = store.vouchers({ periodKey: '2026-01' })
    expect(recordEntry(store, pack, { ...entry, date: '2026-02-05', correctsVoucherNo: 'PZ-202601-001', preview }, now))
      .toMatchObject({ accepted: false, code: 'CORRECTION_BEFORE_REVERSAL' })
    expect(store.vouchers({ periodKey: '2026-02' })).toEqual([])
    expect(store.vouchers({ periodKey: '2026-01' })).toEqual(before)
    expect(store.vouchers({ periodKey: '2026-03' })).toHaveLength(1)
    expect(store.invoice(entry.invoiceNumber)?.voucherNo).toBe('PZ-202601-001')
  })

  it.each(['2026-03-05', '2026-04-01'])('%s 同期或以后仍可更正，不能重复更正', date => {
    const store = fixture()
    const input = { ...entry, date, correctsVoucherNo: 'PZ-202601-001' }
    expect(recordEntry(store, pack, input, now)).toMatchObject({ accepted: true, correctsVoucherNo: 'PZ-202601-001' })
    expect(recordEntry(store, pack, input, now)).toMatchObject({ code: 'ALREADY_CORRECTED' })
  })

  it('作废的冲销记录不授予更正资格', () => {
    const store = fixture()
    expect(voidVoucher(store, [], { voucherNo: 'PZ-202603-001', reason: '合成撤回冲销' }, now)).toMatchObject({ accepted: true })
    expect(recordEntry(store, pack, { ...entry, date: '2026-03-05', correctsVoucherNo: 'PZ-202601-001' }, now)).toMatchObject({ code: 'NOT_REVERSED' })
  })

  it('更正时自动沿用原票，同样校验购销方向和金额，并保留原月的关联', () => {
    const store = fixture()
    const correction = { date: '2026-03-05', correctsVoucherNo: 'PZ-202601-001', summary: entry.summary, facts: entry.facts }
    for (const preview of [true, false]) {
      expect(recordEntry(store, pack, {
        ...correction, preview, eventKind: 'sale_service', amounts: { invoice_total: '1300', invoice_net: '1287.13', invoice_tax: '12.87' },
      }, now)).toMatchObject({ code: 'INVOICE_DIRECTION_MISMATCH' })
      expect(recordEntry(store, pack, {
        ...correction, preview, eventKind: 'office_supply', amounts: { invoice_total: '200' },
      }, now)).toMatchObject({ code: 'INVOICE_AMOUNT_MISMATCH' })
    }
    expect(recordEntry(store, pack, { ...correction, eventKind: 'office_supply', amounts: entry.amounts }, now))
      .toMatchObject({ voucherNo: 'PZ-202603-002', missingEvidence: [] })
    expect(store.invoice(entry.invoiceNumber)?.voucherNo).toBe('PZ-202601-001')
    expect(store.invoiceForVoucher(store.vouchers({ voucherNo: 'PZ-202603-002' })[0]!.id)?.invoiceNumber).toBe(entry.invoiceNumber)
  })

  it('更正采用新的有效票据时挂在更正凭证上，不能再拿去重复记账', () => {
    const store = fixture()
    const invoiceNumber = '00000000000000000002'
    expect(checkInvoice(store, {
      invoiceNumber, issueDate: '2026-03-05', buyerName: '合成客户', sellerName: '合成更正企业',
      amountExclTax: '100.00', taxAmount: '1.00', totalInclTax: '101.00', taxRate: '1%',
    }, now)).toMatchObject({ recordable: true })
    const sale = { ...entry, invoiceNumber, date: '2026-03-05', eventKind: 'sale_service',
      amounts: { invoice_total: '101', invoice_net: '100', invoice_tax: '1' } }
    expect(recordEntry(store, pack, { ...sale, correctsVoucherNo: 'PZ-202601-001' }, now)).toMatchObject({ voucherNo: 'PZ-202603-002' })
    expect(store.invoice(entry.invoiceNumber)?.voucherNo).toBe('PZ-202601-001')
    expect(store.invoice(invoiceNumber)?.voucherNo).toBe('PZ-202603-002')
    expect(store.invoiceForVoucher(store.vouchers({ voucherNo: 'PZ-202603-002' })[0]!.id)?.invoiceNumber).toBe(invoiceNumber)
    expect(recordEntry(store, pack, sale, now)).toMatchObject({ code: 'INVOICE_ALREADY_RECORDED' })
  })
})
