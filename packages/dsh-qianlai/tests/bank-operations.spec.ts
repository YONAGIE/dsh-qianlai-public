import { afterEach, describe, expect, it } from 'vitest'

import { openBook } from '../src/book.js'
import { currentFundsArrangements, saveFundsArrangement } from '../src/funds-arrangements.js'
import { importStatement } from '../src/statements.js'
import { BookStore } from '../src/store.js'

const stores: BookStore[] = []
const now = new Date('2026-02-02T00:00:00Z')
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function book() {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成资金企业', accountingStartMonth: '2026-01' })
  return store
}

describe('银行流水来源与未来安排', () => {
  it('拒绝原件尾号不符，重试只导入实际账户和月份，同一原件用同一回执', () => {
    const store = book()
    const material = store.saveWorkMaterial('synthetic-hash', '合成月度流水.pdf', 'read', null)
    const input = {
      accountRef: '示例银行 尾号 0001', materialId: material.id, sourceBank: '示例银行', sourceAccountTail: '8890',
      periodStart: '2026-01-01', periodEnd: '2026-01-31', printedOpeningBalance: '10000.00',
      rows: [{ rowNumber: 1, occurredAt: '2026-01-16', amount: '3000.00', direction: '收入', balanceAfter: '13000.00' }],
    }
    expect(importStatement(store, input, now)).toMatchObject({ accepted: false, code: 'STATEMENT_ACCOUNT_MISMATCH' })
    expect(store.statementCoverage()).toEqual([])
    const corrected = { ...input, accountRef: '示例银行 尾号 8890' }
    const imported = importStatement(store, corrected, now)
    expect(imported).toMatchObject({
      accepted: true, accountRef: corrected.accountRef,
      receipt: { materialId: material.id, months: ['2026-01'], openingBalance: '10000.00', closingBalance: '13000.00' },
    })
    if (!imported.accepted) throw Error('sample expected to import')
    expect(importStatement(store, corrected, now)).toMatchObject({ accepted: true, reused: true, receipt: imported.receipt })
    expect(store.statementCoverage().map(line => line.accountRef)).toEqual([corrected.accountRef])
    expect(store.statementLines({})).toHaveLength(1)
    expect(store.postedPeriods()).toEqual([])
  })

  it('保存未来收款安排只影响安排，重复保存与取消不写账或流水', () => {
    const store = book()
    const args = {
      action: 'schedule-funds', title: '合成合同款', fundsDirection: 'receipt', scheduledOn: '2026-02-23', fundsAmount: '5000.00',
    }
    const scheduled = saveFundsArrangement(store, args, now)
    expect(scheduled).toMatchObject({ accepted: true, status: 'scheduled', amount: '5000.00', affectsLedger: false })
    if (!scheduled.accepted) throw Error('sample expected to schedule')
    expect(saveFundsArrangement(store, args, now)).toMatchObject({ accepted: true, arrangementId: scheduled.arrangementId, reused: true })
    expect(currentFundsArrangements(store)).toHaveLength(1)
    expect(saveFundsArrangement(store, { action: 'cancel-funds', arrangementId: scheduled.arrangementId }, now))
      .toMatchObject({ accepted: true, status: 'cancelled', affectsLedger: false })
    expect(currentFundsArrangements(store)).toEqual([])
    expect(store.statementCoverage()).toEqual([])
    expect(store.postedPeriods()).toEqual([])
  })
})
