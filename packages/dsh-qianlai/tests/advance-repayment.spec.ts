import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openBook, setOpeningBalances } from '../src/book.js'
import { postingGuide, recordEntry } from '../src/entries.js'
import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const now = new Date('2026-01-20T12:00:00Z')
const repayment = {
  date: '2026-01-15', eventKind: 'personal_advance_repayment', summary: '偿还个人垫付',
  facts: { 'settlement.method': 'bank' }, amounts: { settlement: '100.00' },
}
let store: BookStore
beforeEach(() => {
  store = new BookStore(':memory:')
  openBook(store, { companyName: '合成个人垫付测试企业', accountingStartMonth: '2026-01' })
  setOpeningBalances(store, pack, [], now)
})
afterEach(() => store.close())

describe('归还个人垫付必须能逐笔核销', () => {
  it('向导提示核销限制，空账的预演和反复正式调用均不生成凭证', () => {
    expect(postingGuide(pack.payload, repayment.eventKind)).toMatchObject({
      variants: [{ supported: false, reason: expect.stringContaining('未偿余额') }],
    })
    for (const preview of [true, false, false]) {
      expect(recordEntry(store, pack, { ...repayment, preview }, now)).toMatchObject({
        accepted: false, code: 'NOT_SUPPORTED', message: expect.stringContaining('未偿余额'),
      })
    }
    expect(store.vouchers({ periodKey: '2026-01' })).toEqual([])
  })

  it('可登记垫付费用，后续手填的凭证号、姓名和材料名不能作为核销依据', () => {
    const source = recordEntry(store, pack, {
      date: '2026-01-03', eventKind: 'office_supply', summary: '员工垫付办公用品',
      facts: { 'settlement.method': 'personal_card' }, amounts: { invoice_total: '500.00' }, evidenceRoles: ['receipt'],
    }, now)
    expect(source).toMatchObject({ accepted: true, voucherNo: 'PZ-202601-001', missingEvidence: [] })
    const facts = {
      ...repayment.facts, 'source.event': 'PZ-202601-001', 'source.creditor': '合成员工', 'source.material': '合成付款凭据',
    }
    for (const settlement of ['100.00', '500.00', '600.00']) {
      expect(recordEntry(store, pack, { ...repayment, facts, amounts: { settlement } }, now)).toMatchObject({
        accepted: false, code: 'NOT_SUPPORTED',
      })
    }
    expect(store.vouchers({ periodKey: '2026-01' }).map(v => v.voucherNo)).toEqual(['PZ-202601-001'])
  })
})
