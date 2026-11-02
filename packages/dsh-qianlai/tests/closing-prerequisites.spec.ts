import { afterEach, describe, expect, it } from 'vitest'

import { openBook, setCompanyFacts, setOpeningBalances } from '../src/book.js'
import { closePeriod, closingCheck } from '../src/closing.js'
import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function fixture(opening: boolean) {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成结账企业', accountingStartMonth: '2026-01' })
  setCompanyFacts(store, pack, Object.fromEntries(pack.payload.closingItems.flatMap(item => item.requiredWhen.map(condition => [condition.factKey, 'no']))))
  if (opening) setOpeningBalances(store, pack, [], new Date('2026-01-01T00:00:00Z'))
  return store
}

describe('结账必须完成期初与业务期间', () => {
  it('不能跳过期初确认，失败后仍可录入零期初再结账', () => {
    const store = fixture(false)
    const now = new Date('2026-02-02T00:00:00Z')
    expect(closingCheck(store, pack, '2026-01', now)).toMatchObject({
      canClose: false, checks: expect.arrayContaining([expect.objectContaining({ passed: false, blockers: [{ kind: 'opening_balances_unconfirmed' }] })]),
    })
    expect(closePeriod(store, pack, '2026-01', now)).toMatchObject({ accepted: false, code: 'CLOSING_BLOCKED' })
    expect(store.lockedPeriods()).toEqual([])
    expect(setOpeningBalances(store, pack, [], now)).toMatchObject({ accepted: true })
    expect(closePeriod(store, pack, '2026-01', now)).toMatchObject({ accepted: true, locked: true })
  })

  it.each(['2026-01-15T00:00:00Z', '2026-01-31T15:59:59Z'])('%s 北京时间期间结束前不能锁月', timestamp => {
    const store = fixture(true)
    const now = new Date(timestamp)
    expect(closingCheck(store, pack, '2026-01', now)).toMatchObject({ canClose: false })
    expect(closePeriod(store, pack, '2026-01', now)).toMatchObject({ accepted: false, code: 'CLOSING_BLOCKED' })
    expect(store.lockedPeriods()).toEqual([])
    expect(store.vouchers({ periodKey: '2026-01' })).toEqual([])
  })

  it('北京时间次月零点即可结账，不等待UTC换月', () => {
    const store = fixture(true)
    expect(closePeriod(store, pack, '2026-01', new Date('2026-01-31T16:00:00Z'))).toMatchObject({ accepted: true, locked: true })
  })

  it('未来月份继续拒绝，当前月份可列出其他预检问题', () => {
    const store = fixture(true)
    const now = new Date('2026-01-15T00:00:00Z')
    expect(closingCheck(store, pack, '2026-02', now)).toMatchObject({ code: 'PERIOD_FUTURE' })
    expect(closingCheck(store, pack, '2026-01', now)).toMatchObject({ accepted: true, locked: false, canClose: false })
  })
})
