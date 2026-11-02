import { afterEach, describe, expect, it } from 'vitest'

import { checkArgs } from '../src/args.js'
import { openBook } from '../src/book.js'
import { checkInvoice } from '../src/invoices.js'
import { BookStore } from '../src/store.js'

const schema = { type: 'object', properties: { invoiceNumber: { type: 'string' } }, required: ['invoiceNumber'] }
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const now = new Date('2026-02-01T00:00:00Z')
const invoice = { invoiceNumber: '00000000000000000001', issueDate: '2026-01-10', buyerName: '合成精度企业', sellerName: '合成供方',
  amountExclTax: '100.00', taxAmount: '0.00', totalInclTax: '100.00', taxRate: '0%' }
function fixture() {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: invoice.buyerName, accountingStartMonth: '2026-01' })
  return store
}
describe('数值边界的精确信息', () => {
  it('不能把已损失精度的长数字静默转成票号字符串', () => {
    expect(checkArgs(schema, { invoiceNumber: Number('26330000000087654321') }).problems)
      .toEqual([expect.stringContaining('字符串')])
  })
  it('原始长字符串保留所有数字及前导零', () => {
    for (const value of ['26330000000087654321', '00000000000000000001'])
      expect(checkArgs(schema, { invoiceNumber: value })).toEqual({ args: { invoiceNumber: value }, problems: [] })
  })
  it.each([0, 123, 12.5, Number.MAX_SAFE_INTEGER])('保留普通安全数字 %s 的字符串兼容', value => {
    expect(checkArgs(schema, { invoiceNumber: value })).toEqual({ args: { invoiceNumber: String(value) }, problems: [] })
  })
  it('超出核心精确整数契约的核票金额明确拒绝，不返回已舍入金额', () => {
    const store = fixture()
    const result = checkInvoice(store, { ...invoice, amountExclTax: '90071992547409.93', totalInclTax: '90071992547409.93' }, now)
    expect(result).toMatchObject({ accepted: false, code: 'INVOICE_AMOUNT_OUT_OF_RANGE' })
    expect(result).not.toHaveProperty('amounts')
    expect(store.invoice(invoice.invoiceNumber)).toBeUndefined()
  })
  it('精确安全边界仍按原始整数分返回', () => {
    expect(checkInvoice(fixture(), { ...invoice, amountExclTax: '90071992547409.91', totalInclTax: '90071992547409.91' }, now))
      .toMatchObject({ amounts: { invoice_net: '90071992547409.91', invoice_total: '90071992547409.91' } })
  })
  it('正常核票继续保存精确整数分', () => {
    const store = fixture()
    expect(checkInvoice(store, invoice, now)).toMatchObject({ recordable: true, amounts: { invoice_total: '100.00' } })
    expect(store.invoice(invoice.invoiceNumber)?.totalCents).toBe(10000n)
  })
  it('标记不可读的超大候选不当成已确定金额进行范围判断', () => {
    expect(checkInvoice(fixture(), { ...invoice, amountExclTax: '90071992547409.93', unreadable: ['amountExclTax'] }, now))
      .toMatchObject({ accepted: true, amounts: { invoice_net: null } })
  })
})
