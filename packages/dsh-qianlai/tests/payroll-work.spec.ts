import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openBook } from '../src/book.js'
import { reviewPayroll, savePayroll } from '../src/payroll-work.js'
import { BookStore } from '../src/store.js'

const now = new Date('2026-04-10T01:00:00Z')
const periodKey = '2026-02'
const employee = { employeeId: '01', name: '合成员工甲', gross: '3000', personalSocial: '300',
  personalHousing: '100', individualTax: '20', otherDeduction: '30', net: '2550' }
let store: BookStore
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qianlai-payroll-'))
  store = new BookStore(join(dir, 'book.sqlite'))
  openBook(store, { companyName: '合成工资公司', accountingStartMonth: '2026-01' })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const inspect = (args: Record<string, unknown>) => reviewPayroll(store, { periodKey, ...args }, now, dir)
const approve = (args: Record<string, unknown>) => {
  const same = { periodKey, ...args }
  const proposal = inspect(args)
  if (!('operation' in proposal) || proposal.operation === undefined) throw Error(JSON.stringify(proposal))
  return savePayroll(store, proposal, same, now)
}
const status = (period = periodKey) => inspect({ action: 'status', periodKey: period })
const material = (name: string) => store.saveWorkMaterial(name, name, 'read', null).id

describe('工资安排、准备稿和实际发放', () => {
  it('只预览不改安排，支持短月、仅本月和以后暂停', () => {
    const schedule = { action: 'schedule', mode: 'recurring', payday: 31 }
    expect(inspect(schedule)).toHaveProperty('summary')
    expect(status()).toMatchObject({ schedule: null })
    expect(approve(schedule)).toMatchObject({ accepted: true })
    expect(status()).toMatchObject({ schedule: { plannedDate: '2026-02-28' } })
    approve({ action: 'schedule', periodKey: '2026-03', mode: 'once', payday: 7 })
    expect(status('2026-03')).toMatchObject({ schedule: { mode: 'once', plannedDate: '2026-03-07' } })
    expect(status('2026-04')).toMatchObject({ schedule: { mode: 'recurring', plannedDate: '2026-04-30' } })
    approve({ action: 'schedule', periodKey: '2026-05', mode: 'paused' })
    expect(status('2026-05')).toMatchObject({ schedule: { mode: 'paused' }, nextAction: { kind: 'paused' } })
    expect(status()).toMatchObject({ schedule: { plannedDate: '2026-02-28' } })
    expect(store.workEvents()).toEqual([])
  })

  it('将空金额与零区分，草稿无需账户，保留版本并可导出', () => {
    expect(inspect({ action: 'draft', revision: 0, rows: [{ ...employee, personalSocial: '' }] }))
      .toMatchObject({ code: 'PAYROLL_ROW_INVALID', details: { row: 1 } })
    const source = material('合成工资表.csv')
    const saved = approve({ action: 'draft', revision: 0, materialId: source, rows: [employee] })
    if (!('revision' in saved)) throw Error(JSON.stringify(saved))
    expect(status()).toMatchObject({ revision: saved.revision, sourceMaterialId: source, rows: [{ paymentStatus: 'unconfirmed' }] })
    expect(inspect({ action: 'download' })).toMatchObject({ accepted: true, revision: saved.revision })
    const file = inspect({ action: 'download' })
    if (!('path' in file)) throw Error(JSON.stringify(file))
    expect(readFileSync(file.path, 'utf8')).toContain('"2026-02","01","合成员工甲","3000.00"')
    const savedChange = approve({ action: 'draft', revision: saved.revision, rows: [{ ...employee, name: '合成员工甲更正' }] })
    expect(savedChange).toMatchObject({ accepted: true })
    expect(inspect({ action: 'revisions' })).toMatchObject({ revisions: [
      { rows: [{ name: '合成员工甲更正' }] }, { materialId: source, rows: [{ name: '合成员工甲' }] },
    ] })
    expect(store.vouchers({ periodKey })).toEqual([])
  })

  it('按原件分次确认跨月实付，重传不会重复，其他人员可保留未付', () => {
    const other = { ...employee, employeeId: '02', name: '合成员工乙' }
    const draft = approve({ action: 'draft', revision: 0, rows: [employee, other] })
    if (!('revision' in draft)) throw Error(JSON.stringify(draft))
    expect(approve({ action: 'payment-state', revision: draft.revision, paymentStatus: 'unpaid' })).toMatchObject({ accepted: true })
    expect(status()).toMatchObject({ nextAction: { kind: 'unpaid' } })
    const first = { action: 'payment', employeeId: '01', revision: draft.revision, paidOn: '2026-03-08',
      amount: '1000', materialId: material('合成回单甲.pdf'), reference: '回单 A' }
    expect(approve(first)).toMatchObject({ accepted: true })
    expect(inspect(first)).toMatchObject({ accepted: true, duplicate: true })
    expect(inspect({ ...first, employeeId: '02' })).toMatchObject({ accepted: false, code: 'PAYROLL_PAYMENT_ALREADY_USED' })
    expect(status()).toMatchObject({ rows: [
      { employeeId: '01', paid: '1000.00', remaining: '1550.00', paymentStatus: 'partial', receipts: [{ paidOn: '2026-03-08' }] },
      { employeeId: '02', paid: '0.00', paymentStatus: 'unpaid' },
    ] })
    const second = { ...first, paidOn: '2026-03-10', reference: '回单 B', amount: '1550' }
    expect(inspect({ ...second, amount: '1550.01' })).toMatchObject({ code: 'PAYROLL_OVERPAYMENT' })
    expect(approve(second)).toMatchObject({ accepted: true })
    store.close()
    store = new BookStore(join(dir, 'book.sqlite'))
    expect(status()).toMatchObject({ rows: [
      { employeeId: '01', paid: '2550.00', remaining: '0.00', paymentStatus: 'complete' }, { employeeId: '02', paymentStatus: 'unpaid' },
    ] })
    expect(store.workEvents()).toEqual([])
    expect(store.vouchers({ periodKey })).toEqual([])
  })
})
