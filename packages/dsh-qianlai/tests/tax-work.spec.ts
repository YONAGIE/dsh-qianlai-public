import { describe, expect, it } from 'vitest'

import { loadPack } from '../src/pack.js'
import { BookStore } from '../src/store.js'
import { taxWork, taxWorkEvent } from '../src/tax-work.js'

const now = new Date('2026-11-20T06:00:00Z')

describe('local tax preparation', () => {
  it('keeps month, quarter, full-year and official receipt states separate', () => {
    const store = new BookStore(':memory:')
    const pack = loadPack()
    try {
      store.createCompany({ name: '合成企业', accountingStartMonth: '2026-01', isSample: false })
      const prepare = { action: 'prepare', kind: 'vat', periodKey: '2026-Q3' }
      expect(taxWork(store, pack, prepare, now)).toMatchObject({ accepted: true, cadence: 'quarterly',
        from: '2026-07-01', to: '2026-09-30', filingStatus: 'unverified', paymentStatus: 'unverified' })
      expect(taxWork(store, pack, { ...prepare, kind: 'income-annual', periodKey: '2026' }, now))
        .toMatchObject({ accepted: true, from: '2026-01-01', to: '2026-12-31',
          coverage: expect.arrayContaining([{ month: '2026-12', status: 'not-ended' }]) })
      expect(taxWork(store, pack, { ...prepare, kind: 'payroll-withholding' }, now))
        .toMatchObject({ accepted: false, code: 'TAX_PERIOD_MISMATCH' })
      const material = store.saveWorkMaterial('synthetic-tax', '合成申报材料.pdf', 'read', null)
      const evidence = { ...prepare, action: 'attach', sourceCompany: '合成企业', sourcePeriod: '2026-Q3',
        sourceTaxKind: 'vat', materialId: material.id, evidenceKind: 'filing-receipt' }
      expect(taxWork(store, pack, { ...evidence, sourcePeriod: '2026-10' }, now))
        .toMatchObject({ accepted: false, code: 'TAX_SOURCE_PERIOD_MISMATCH' })
      expect(taxWork(store, pack, evidence, now))
        .toMatchObject({ accepted: true, filingStatus: 'verification-required', paymentStatus: 'unverified' })
      expect(taxWork(store, pack, evidence, now)).toMatchObject({ accepted: true, alreadyAttached: true })
      expect(taxWork(store, pack, { ...prepare, action: 'review' }, now, true))
        .toMatchObject({ accepted: false, code: 'TAX_ORIGINAL_QUERY_REQUIRED' })
      expect(store.workEventsByOperation(taxWorkEvent)).toHaveLength(1)
      expect(store.workEvents()).toEqual([])
    } finally {
      store.close()
    }
  })
})
