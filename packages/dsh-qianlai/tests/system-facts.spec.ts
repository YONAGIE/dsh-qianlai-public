import { afterEach, describe, expect, it } from 'vitest'

import { openBook } from '../src/book.js'
import { recordEntry } from '../src/entries.js'
import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const now = new Date('2026-02-02T00:00:00Z')
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function fixture() {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成系统事实企业', accountingStartMonth: '2026-01' })
  return store
}
const entry = {
  date: '2026-01-10', summary: '合成手续费', eventKind: 'bank_fee',
  facts: { 'settlement.method': 'bank' }, amounts: { settlement: '10.00' },
}

describe('系统更正事实只能由专门流程生成', () => {
  for (const key of ['correction.of', 'correction.reverses']) {
    it.each([true, false])(`拒绝普通事实中的 ${key}（preview=%s）`, preview => {
      const store = fixture()
      expect(recordEntry(store, pack, { ...entry, facts: { ...entry.facts, [key]: 'PZ-202601-999' }, preview }, now))
        .toMatchObject({ accepted: false, code: 'FACT_RESERVED' })
      expect(store.vouchers({ periodKey: '2026-01' })).toEqual([])
      expect(store.voucherLinkedTo(key as 'correction.of' | 'correction.reverses', 'PZ-202601-999')).toBeUndefined()
    })
  }

  it('保留普通业务事实，不把未知业务补充说明误当系统关系', () => {
    const store = fixture()
    expect(recordEntry(store, pack, { ...entry, facts: { ...entry.facts, 'business.note': '合成说明' } }, now)).toMatchObject({ accepted: true })
    expect(store.vouchers({ periodKey: '2026-01' })).toHaveLength(1)
  })
})
