import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { reviewBenefit, saveBenefit } from '../src/benefit-work.js'
import { openBook } from '../src/book.js'
import { BookStore } from '../src/store.js'

let store: BookStore
const now = new Date('2026-04-12T01:00:00Z')
const benefit = 'insurance'
const periodKey = '2026-02'
const person = { employeeId: '01', name: '合成员工甲' }
const other = { employeeId: '02', name: '合成员工乙' }

beforeEach(() => {
  store = new BookStore(':memory:')
  openBook(store, { companyName: '合成缴费企业', accountingStartMonth: '2026-01' })
})
afterEach(() => store.close())

function inspect(input: Record<string, unknown>) {
  return reviewBenefit(store, { benefit, periodKey, ...input }, now)
}

function persist(input: Record<string, unknown>) {
  const proposal = inspect(input)
  if (!('operation' in proposal)) throw Error(JSON.stringify(proposal))
  return saveBenefit(store, proposal, { benefit, periodKey, ...input }, now)
}

const source = (file: string) => store.saveWorkMaterial(file, file, 'read', null).id

describe('本地社保、公积金核对', () => {
  it('逐人分开保留成功和失败，只复办这一位，不误改另一个项目', () => {
    const a = { ...person, action: 'enrollment', status: 'pending' }
    const b = { ...other, action: 'enrollment', status: 'pending' }
    expect(inspect(a)).toHaveProperty('summary')
    expect(inspect({ action: 'status' })).toMatchObject({ people: [] })
    persist(a)
    persist(b)
    expect(inspect({ ...a, status: 'verified' })).toMatchObject({ code: 'BENEFIT_EVIDENCE_NEEDED' })
    persist({ ...a, status: 'verified', materialId: source('合成甲复核回执.pdf') })
    persist({ ...b, status: 'failed', reason: '合成示例证件资料缺项' })
    expect(inspect({ action: 'status' })).toMatchObject({
      people: [{ ...other, status: 'failed' }, { ...person, status: 'verified' }],
      nextAction: { kind: 'retry-result', employeeId: '02' },
    })
    persist({ ...b, status: 'pending' })
    expect(inspect({ action: 'status', benefit: 'housing' })).toMatchObject({ people: [] })
    expect(inspect({ action: 'history' })).toMatchObject({ enrollmentHistory: expect.arrayContaining([
      expect.objectContaining({ result: expect.objectContaining({ employeeId: '02', status: 'failed' }) }),
    ]) })
    expect(store.workEvents()).toEqual([])
  })

  it('合计核对缴费凭据，实缴日独立，月更正保留原件及旧版', () => {
    const materialId = source('合成缴费明细.csv')
    const fees = persist({ action: 'contribution', revision: 0, materialId, rows: [{ ...person, companyAmount: '600', personalAmount: '300' }] })
    if (!('revision' in fees)) throw Error(JSON.stringify(fees))
    expect(inspect({ action: 'status' })).toMatchObject({ contribution: { companyTotal: '600.00', personalTotal: '300.00', total: '900.00' } })
    const payment = { action: 'paid', revision: fees.revision, paidOn: '2026-03-10', reference: '合成缴费 001',
      materialId: source('合成缴费凭据.pdf'), paidTotal: '900' }
    expect(inspect({ ...payment, paidTotal: '0' })).toMatchObject({ code: 'BENEFIT_PAYMENT_PROOF_INVALID' })
    expect(inspect({ ...payment, paidTotal: '100' })).toMatchObject({ code: 'BENEFIT_PAYMENT_MISMATCH' })
    const paid = persist(payment)
    if (!('revision' in paid)) throw Error(JSON.stringify(paid))
    expect(inspect({ ...payment, revision: paid.revision })).toMatchObject({ accepted: true, duplicate: true })
    persist({ action: 'move', revision: paid.revision, targetPeriodKey: '2026-03' })
    expect(inspect({ action: 'status' })).toMatchObject({ nextAction: { kind: 'collect-contribution' } })
    expect(inspect({ action: 'status', periodKey: '2026-03' })).toMatchObject({
      contribution: { materialId, paid: { paidOn: '2026-03-10', materialId: payment.materialId, paidTotal: '900.00' } },
    })
    expect(inspect({ action: 'history' })).toMatchObject({
      contributionHistory: [{ periodKey: '2026-03' }, { periodKey: '2026-02' }, { periodKey: '2026-02' }],
    })
    expect(store.vouchers({ periodKey: '2026-03' })).toEqual([])
  })
})
