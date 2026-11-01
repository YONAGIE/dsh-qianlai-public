import { afterEach, describe, expect, it } from 'vitest'

import { openBook } from '../src/book.js'
import { recordEntry, reverseVoucher, voidVoucher } from '../src/entries.js'
import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const now = new Date('2026-04-02T00:00:00Z')
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function fixture() {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成撤销更正企业', accountingStartMonth: '2026-01' })
  const entry = { date: '2026-01-10', summary: '合成手续费', eventKind: 'bank_fee',
    facts: { 'settlement.method': 'bank' }, amounts: { settlement: '10.00' } }
  expect(recordEntry(store, pack, entry, now)).toMatchObject({ accepted: true })
  // This fixture represents a previously closed original; normal closing is
  // independently covered by correction-period.spec.ts.
  store.lockPeriod('2026-01', now)
  expect(reverseVoucher(store, pack, [], { voucherNo: 'PZ-202601-001', date: '2026-03-05', reason: '合成冲销更正' }, now)).toMatchObject({ voucherNo: 'PZ-202603-001' })
  expect(recordEntry(store, pack, { ...entry, date: '2026-03-06', correctsVoucherNo: 'PZ-202601-001' }, now)).toMatchObject({ voucherNo: 'PZ-202603-002' })
  return store
}

describe('冲销与更正撤销顺序', () => {
  it('存在有效更正时不能先作废冲销，金额与关系均保持不变', () => {
    const store = fixture()
    const before = store.movements('2026-03')
    expect(voidVoucher(store, [], { voucherNo: 'PZ-202603-001', reason: '合成撤销冲销' }, now))
      .toMatchObject({ accepted: false, code: 'CORRECTION_ACTIVE' })
    expect(store.movements('2026-03')).toEqual(before)
    expect(store.voucherLinkedTo('correction.reverses', 'PZ-202601-001')).toBe('PZ-202603-001')
    expect(store.voucherLinkedTo('correction.of', 'PZ-202601-001')).toBe('PZ-202603-002')
  })

  it('先作废开放月份的更正后可作废冲销，且原锁月不变', () => {
    const store = fixture()
    expect(voidVoucher(store, [], { voucherNo: 'PZ-202603-002', reason: '合成撤回更正' }, now)).toMatchObject({ accepted: true })
    expect(voidVoucher(store, [], { voucherNo: 'PZ-202603-001', reason: '合成撤回冲销' }, now)).toMatchObject({ accepted: true })
    expect(store.voucherLinkedTo('correction.reverses', 'PZ-202601-001')).toBeUndefined()
    expect(store.voucherLinkedTo('correction.of', 'PZ-202601-001')).toBeUndefined()
    expect(store.lockedPeriods()).toEqual(['2026-01'])
    expect(store.vouchers({ periodKey: '2026-03' })).toEqual([])
  })
})
