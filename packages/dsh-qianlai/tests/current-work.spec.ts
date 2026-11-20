import { describe, expect, it } from 'vitest'

import { currentWork } from '../src/current-work.js'
import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'

const now = new Date('2026-11-07T04:00:00Z')
const pack = loadPack()

describe('current business action', () => {
  it('scopes two ledgers independently and leaves a later start alone', () => {
    const first = new BookStore(':memory:')
    const second = new BookStore(':memory:')
    try {
      first.createCompany({ name: '合成甲公司', accountingStartMonth: '2026-10', isSample: false })
      second.createCompany({ name: '合成乙公司', accountingStartMonth: '2026-12', isSample: false })
      first.setOpeningBalances([], now)
      first.createWorkMatter('待补文件甲', '2026-11', ['合成合同', '合成回单'])
      expect(currentWork(first, pack, now)).toMatchObject({ identity: {
        company: '合成甲公司', version: expect.any(String), scope: 'current-local-book',
      }, nextAction: { kind: 'deadline', message: expect.stringContaining('已逾期') } })
      expect(currentWork(second, pack, now)).toMatchObject({ identity: { company: '合成乙公司' },
        nextAction: { kind: 'scheduled-start' }, reminders: [] })
      first.lockPeriod('2026-10', now)
      expect(currentWork(first, pack, now)).toMatchObject({ nextAction: {
        kind: 'material', message: expect.stringContaining('合成合同'),
      } })
      expect(currentWork(first, pack, now).reminders).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ period: '2026-10', title: '月末结账' }),
      ]))
    } finally {
      first.close()
      second.close()
    }
  })
  it('offers a generic payroll action until payment is matched', () => {
    const store = new BookStore(':memory:')
    try {
      store.createCompany({ name: '合成公司', accountingStartMonth: '2026-11', isSample: false })
      store.setOpeningBalances([], now)
      store.recordWork('local-work:payroll-draft', { periodKey: '2026-11' },
        { rows: [{ employeeId: 'private-id', name: '合成员工', net: '3200.00' }] }, now)
      const current = currentWork(store, pack, now)
      expect(current.nextAction.kind).toBe('payroll')
      expect(JSON.stringify(current)).not.toMatch(/合成员工|3200|private-id/)
      store.recordWork('local-work:payroll-payment', { periodKey: '2026-11' },
        { employeeId: 'private-id', amount: '3200.00' }, now)
      expect(currentWork(store, pack, now).nextAction.kind).toBe('ready')
    } finally {
      store.close()
    }
  })
})
