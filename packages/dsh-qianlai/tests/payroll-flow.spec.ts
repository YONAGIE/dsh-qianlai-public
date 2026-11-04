import { expect, it } from 'vitest'

import { readBalances } from '../src/balances.js'
import { openBook, setOpeningBalances } from '../src/book.js'
import { recordEntry } from '../src/entries.js'
import { loadPack } from '../src/pack.js'
import { readProfit } from '../src/reports.js'
import { BookStore } from '../src/store.js'

it('上月计提工资、本月按净额发薪并代扣，资金、欠款和两个月的费用分别可对账', () => {
  const store = new BookStore(':memory:')
  const pack = loadPack()
  const now = new Date('2026-02-28T04:00:00Z')
  try {
    expect(openBook(store, { companyName: '合成工资测试企业', accountingStartMonth: '2026-01' })).toMatchObject({ accepted: true })
    expect(setOpeningBalances(store, pack, [], now)).toMatchObject({ accepted: true })
    const bank = { 'settlement.method': 'bank' }
    expect(recordEntry(store, pack, {
      eventKind: 'capital_contribution', date: '2026-01-01', summary: '合成股东实缴',
      facts: { ...bank, 'capital.nature': 'registeredCapital' }, amounts: { contract: '10000.00' },
    }, now)).toMatchObject({ accepted: true })
    expect(recordEntry(store, pack, {
      eventKind: 'closing.payroll_accrual', date: '2026-01-31', summary: '计提一月工资',
      facts: { 'recognition.period': '2026-01' },
      amounts: { payroll_gross_delivery: '0.00', payroll_gross_admin: '2000.00', payroll_gross_selling: '0.00', payroll_gross: '2000.00' },
    }, now)).toMatchObject({ accepted: true })
    expect(readBalances(store, '2026-01')).toMatchObject({ rows: expect.arrayContaining([
      expect.objectContaining({ subjectCode: '1002', balance: '10000.00', side: '借' }),
      expect.objectContaining({ subjectCode: '2211', balance: '2000.00', side: '贷' }),
    ]) })
    expect(recordEntry(store, pack, {
      eventKind: 'payroll', date: '2026-02-10', summary: '合成二月发放一月工资', facts: bank,
      amounts: { payroll_gross: '2000.00', payroll_net: '1750.00', payroll_personal_social: '150.00', payroll_personal_tax: '20.00', housing_fund_personal: '80.00' },
    }, now)).toMatchObject({ accepted: true })
    const balances = readBalances(store, '2026-02')
    if (!balances.accepted) throw new Error(balances.message)
    expect(balances.rows.map(row => row.subjectCode)).not.toContain('2211')
    expect(balances.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectCode: '1002', balance: '8250.00', side: '借' }),
      expect.objectContaining({ subjectCode: '224101', balance: '150.00', side: '贷' }),
      expect.objectContaining({ subjectCode: '222102', balance: '20.00', side: '贷' }),
      expect.objectContaining({ subjectCode: '224104', balance: '80.00', side: '贷' }),
    ]))
    expect(readProfit(store, pack, '2026-02')).toMatchObject({
      month: { totals: { expense: '0.00' } }, yearToDate: { totals: { expense: '2000.00' } },
    })
  } finally {
    store.close()
  }
})
