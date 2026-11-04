import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'

import { openBook, setCompanyFacts, setOpeningBalances } from '../src/book.js'
import { closePeriod, closingCheck } from '../src/closing.js'
import { recordEntry, reverseVoucher, voidVoucher } from '../src/entries.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import { exportReviewPack } from '../src/review-pack.js'
import { BookStore } from '../src/store.js'

const now = new Date('2026-05-15T04:00:00Z')
const pack = loadPack()
const company = '合成冲销验收企业'
const originalNo = 'PZ-202601-001'
const invoiceNumber = '00000000000000000001'
const office = { eventKind: 'office_supply', summary: '合成现金支付办公用品', facts: { 'settlement.method': 'cash' }, amounts: { invoice_total: '20.00' } }
const reversal = { voucherNo: originalNo, date: '2026-02-03', reason: '已核对原始凭据' }
let store: BookStore

beforeEach(() => {
  store = new BookStore(':memory:')
  openBook(store, { companyName: company, accountingStartMonth: '2026-01' })
  setOpeningBalances(store, pack, [
    { subjectCode: '1001', side: 'debit', amount: '100.00' }, { subjectCode: '4001', side: 'credit', amount: '100.00' },
  ], now)
  setCompanyFacts(store, pack, Object.fromEntries(pack.payload.closingItems.flatMap(i => i.requiredWhen.map(c => [c.factKey, 'no']))))
  expect(checkInvoice(store, { invoiceNumber, issueDate: '2026-01-06', buyerName: company, sellerName: '合成供方', totalInclTax: '20.00' }, now)).toMatchObject({ recordable: true })
  expect(recordEntry(store, pack, { ...office, date: '2026-01-06', invoiceNumber }, now)).toMatchObject({ voucherNo: originalNo })
  expect(closePeriod(store, pack, '2026-01', now)).toMatchObject({ accepted: true })
})
afterEach(() => store.close())

it('整笔误记撤销不要求重记，保留原月及其他关账检查', () => {
  const original = store.vouchers({ periodKey: '2026-01' })
  expect(reverseVoucher(store, pack, [], { ...reversal, intent: 'cancel' }, now)).toMatchObject({ accepted: true, next: expect.stringContaining('无需重记') })
  for (const preview of [true, false]) {
    expect(recordEntry(store, pack, { ...office, date: '2026-02-04', correctsVoucherNo: originalNo, preview }, now)).toMatchObject({ code: 'REVERSAL_CANCEL_ONLY' })
  }
  expect(closePeriod(store, pack, '2026-02', now)).toMatchObject({ accepted: true })
  expect(store.vouchers({ periodKey: '2026-01' })).toEqual(original)
})

it('只在指定更正月份阻断未完成更正，预演或作废的更正均不能结清', () => {
  expect(reverseVoucher(store, pack, [], { ...reversal, intent: 'correct', replacementPeriod: '2026-03' }, now)).toMatchObject({ accepted: true })
  expect(closePeriod(store, pack, '2026-02', now)).toMatchObject({ accepted: true })
  expect(recordEntry(store, pack, { ...office, date: '2026-04-03', correctsVoucherNo: originalNo }, now)).toMatchObject({ code: 'CORRECTION_PERIOD_MISMATCH' })
  const replacement = { ...office, date: '2026-03-05', correctsVoucherNo: originalNo }
  expect(recordEntry(store, pack, { ...replacement, preview: true }, now)).toMatchObject({ accepted: true })
  const check = closingCheck(store, pack, '2026-03', now)
  expect(check).toMatchObject({ canClose: false, checks: expect.arrayContaining([expect.objectContaining({ passed: false,
    blockers: [{ kind: 'correction_pending', originalVoucherNo: originalNo, reversalVoucherNo: 'PZ-202602-001', replacementPeriod: '2026-03' }],
  })]) })
  expect(closePeriod(store, pack, '2026-03', now)).toMatchObject({ code: 'CLOSING_BLOCKED' })
  const posted = recordEntry(store, pack, replacement, now)
  expect(posted).toMatchObject({ voucherNo: 'PZ-202603-001' })
  expect(closingCheck(store, pack, '2026-03', now)).toMatchObject({ canClose: true })
  expect(voidVoucher(store, [], { voucherNo: 'PZ-202603-001', reason: '撤回合成测试更正' }, now)).toMatchObject({ accepted: true })
  expect(closingCheck(store, pack, '2026-03', now)).toMatchObject({ canClose: false })
  // 留一笔独立的三月业务，使该月有正式报表可供导出。
  const other = '00000000000000000002'
  expect(checkInvoice(store, { invoiceNumber: other, issueDate: '2026-03-06', buyerName: company, sellerName: '合成供方', totalInclTax: '20.00' }, now)).toMatchObject({ recordable: true })
  expect(recordEntry(store, pack, { ...office, date: '2026-03-06', invoiceNumber: other }, now)).toMatchObject({ voucherNo: 'PZ-202603-002' })
  const dir = mkdtempSync(join(tmpdir(), 'reversal-review-'))
  try {
    const result = exportReviewPack(store, pack, '2026-03', dir, now)
    if (!result.accepted) throw Error(result.message)
    expect(readFileSync(join(result.dir, '7-还没处理完的事.csv'), 'utf8')).toContain(originalNo)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  expect(recordEntry(store, pack, replacement, now)).toMatchObject({ voucherNo: 'PZ-202603-003' })
  expect(closePeriod(store, pack, '2026-03', now)).toMatchObject({ accepted: true })
})

it('拒绝矛盾或无效计划，不留下冲销；撤回一张开放月冲销也会撤下其待办', () => {
  for (const input of [
    { intent: 'cancel' as const, replacementPeriod: '2026-02' },
    { intent: 'correct' as const, replacementPeriod: '2026-01' },
    { intent: 'correct' as const, replacementPeriod: '2026-13' },
    { intent: 'correct' as const },
    { replacementPeriod: '2026-02' },
  ]) expect(reverseVoucher(store, pack, [], { ...reversal, ...input }, now)).toMatchObject({ accepted: false })
  expect(store.vouchers({ periodKey: '2026-02' })).toEqual([])
  expect(reverseVoucher(store, pack, [], { ...reversal, intent: 'correct', replacementPeriod: '2026-02' }, now)).toMatchObject({ accepted: true })
  expect(closingCheck(store, pack, '2026-02', now)).toMatchObject({ canClose: false })
  expect(voidVoucher(store, [], { voucherNo: 'PZ-202602-001', reason: '冲销决定已撤回' }, now)).toMatchObject({ accepted: true })
  expect(closingCheck(store, pack, '2026-02', now)).toMatchObject({ canClose: true })
})

it('兼容原接口及没有用途标记的旧冲销，继续允许在之后的开放月更正', () => {
  expect(reverseVoucher(store, pack, [], reversal, now)).toMatchObject({ accepted: true, next: expect.stringContaining('确认') })
  expect(closePeriod(store, pack, '2026-02', now)).toMatchObject({ accepted: true })
  expect(recordEntry(store, pack, { ...office, date: '2026-03-03', correctsVoucherNo: originalNo }, now)).toMatchObject({ accepted: true })
})
