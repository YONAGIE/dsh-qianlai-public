import { formatCents } from '@moneycome/fintax-core'

import { PERIOD_KEY, type Refusal } from './period.js'
import type { BookStore } from './store.js'

export interface BalanceRow {
  readonly subjectCode: string
  readonly subjectName: string
  /** 余额在借方还是贷方。资产类通常在借方，负债与权益通常在贷方。 */
  readonly side: '借' | '贷'
  readonly balance: string
}

export interface BalancesResult {
  readonly accepted: true
  readonly company: string
  readonly isSampleBook: boolean
  readonly periodKey: string
  /** 账上最晚记到哪个月。 */
  readonly bookedThrough: string
  readonly rows: readonly BalanceRow[]
}

/**
 * 读期间账：确认企业存在、月份写法对；已确认期初、凭证和锁月共同决定有效范围。
 * 范围外的月份照实拒绝，不拿最近一个月顶替。
 */
export function checkPeriod(store: BookStore, periodKey: string): Refusal | { company: string; isSample: boolean; bookedThrough: string } {
  const company = store.company()
  if (!company) return { accepted: false, code: 'NO_BOOK', message: '本机还没有账本。' }
  if (!PERIOD_KEY.test(periodKey))
    return { accepted: false, code: 'PERIOD_INVALID', message: `月份要写成 YYYY-MM，收到的是 ${periodKey}。` }
  const periods = [...store.postedPeriods(), ...store.lockedPeriods()]
  if (store.openingBalancesSetAt() !== undefined) periods.push(company.accountingStartMonth)
  const last = periods.sort().at(-1)
  if (periodKey < company.accountingStartMonth)
    return {
      accepted: false,
      code: 'PERIOD_BEFORE_BOOK',
      message: `这本账从 ${company.accountingStartMonth} 开始记，没有 ${periodKey} 的账。`,
    }
  if (!last || periodKey > last)
    return {
      accepted: false,
      code: 'PERIOD_NOT_POSTED',
      message: last ? `账上可查询到 ${last}，${periodKey} 还没有已确认期初、凭证或结账记录。` : '账上还没有已确认期初、凭证或结账记录。',
    }
  return { company: company.name, isSample: company.isSample, bookedThrough: last }
}

/** 某月末各科目余额：从建账起累计到该月的借贷净额，净额在借方列「借」、在贷方列「贷」，为零的不列。 */
export function readBalances(store: BookStore, periodKey: string): BalancesResult | Refusal {
  const period = checkPeriod(store, periodKey)
  if ('accepted' in period) return period
  const rows: BalanceRow[] = []
  for (const m of store.movements(periodKey)) {
    if (m.netDebitCents === 0n) continue
    const debitSide = m.netDebitCents > 0n
    rows.push({
      subjectCode: m.subjectCode,
      subjectName: m.subjectName,
      side: debitSide ? '借' : '贷',
      balance: formatCents(debitSide ? m.netDebitCents : -m.netDebitCents),
    })
  }
  return {
    accepted: true,
    company: period.company,
    isSampleBook: period.isSample,
    periodKey,
    bookedThrough: period.bookedThrough,
    rows,
  }
}
