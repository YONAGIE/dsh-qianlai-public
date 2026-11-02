import { afterEach, describe, expect, it } from 'vitest'

import { openBook } from '../src/book.js'
import { linkStatementLines, recordEntry } from '../src/entries.js'
import { loadPack } from '../src/pack.js'
import { importStatement } from '../src/statements.js'
import { BookStore } from '../src/store.js'

const pack = loadPack()
const now = new Date('2026-02-02T00:00:00Z')
const stores: BookStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function fixture() {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成流水关联企业', accountingStartMonth: '2026-01' })
  const voucher = recordEntry(store, pack, {
    date: '2026-01-10', summary: '合成手续费', eventKind: 'bank_fee',
    facts: { 'settlement.method': 'bank' }, amounts: { settlement: '10.00' },
  }, now)
  if (!voucher.accepted || !('voucherNo' in voucher)) throw Error('voucher fixture failed')
  const imported = importStatement(store, {
    accountRef: '合成银行 尾号 1234', periodStart: '2026-01-01', periodEnd: '2026-01-31', printedOpeningBalance: '20.00',
    rows: [
      { rowNumber: 1, occurredAt: '2026-01-10', amount: '10.00', direction: '支出', balanceAfter: '10.00' },
      { rowNumber: 2, occurredAt: '2026-01-11', amount: '10.00', direction: '支出', balanceAfter: '0.00' },
    ],
  }, now)
  if (!imported.accepted) throw Error('statement fixture failed')
  return { store, voucherNo: voucher.voucherNo, ids: imported.lines.map(line => line.lineId) }
}

describe('流水关联总额与幂等', () => {
  it('拒绝第二次挂入完整金额，保留原关联及未解释行', () => {
    const { store, voucherNo, ids } = fixture()
    expect(linkStatementLines(store, pack, { voucherNo, statementLineIds: [ids[0]!] })).toMatchObject({ accepted: true })
    expect(linkStatementLines(store, pack, { voucherNo, statementLineIds: [ids[1]!] }))
      .toMatchObject({ accepted: false, code: 'STATEMENT_AMOUNT_MISMATCH', details: { bankAmount: '-10.00', statementAmount: '-20.00' } })
    expect(store.statementLines({ ids }).map(line => line.voucherNo)).toEqual([voucherNo, null])
  })

  it('相同关联重试成功且不重复计算金额；不能借重试混入新增行', () => {
    const { store, voucherNo, ids } = fixture()
    const request = { voucherNo, statementLineIds: [ids[0]!, ids[0]!] }
    expect(linkStatementLines(store, pack, request)).toMatchObject({ accepted: true })
    expect(linkStatementLines(store, pack, request)).toMatchObject({ accepted: true })
    expect(linkStatementLines(store, pack, { voucherNo, statementLineIds: ids })).toMatchObject({ code: 'STATEMENT_AMOUNT_MISMATCH' })
    expect(store.statementLines({ ids }).filter(line => line.voucherNo)).toHaveLength(1)
  })

  it('空列表不产生结算凭据，非银行凭证也不能用空列表补角色', () => {
    const { store, voucherNo } = fixture()
    expect(linkStatementLines(store, pack, { voucherNo, statementLineIds: [] })).toMatchObject({ code: 'STATEMENT_LINES_REQUIRED' })
    expect(store.vouchers({ voucherNo })[0]!.evidenceRoles).not.toContain('settlement')
    const cash = recordEntry(store, pack, {
      date: '2026-01-10', summary: '合成办公用品', eventKind: 'office_supply',
      facts: { 'settlement.method': 'cash' }, amounts: { invoice_total: '10.00' },
    }, now)
    if (!cash.accepted || !('voucherNo' in cash)) throw Error('cash fixture failed')
    expect(linkStatementLines(store, pack, { voucherNo: cash.voucherNo, statementLineIds: [] })).toMatchObject({ code: 'STATEMENT_LINES_REQUIRED' })
    expect(store.vouchers({ voucherNo: cash.voucherNo })[0]!.evidenceRoles).not.toContain('settlement')
  })
})
