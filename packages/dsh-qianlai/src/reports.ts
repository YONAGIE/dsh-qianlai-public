import { formatCents, type AccountingPackPayload } from '@moneycome/fintax-core'

import { checkPeriod } from './balances.js'
import { packParameter } from './entries.js'
import type { LoadedPack } from './pack.js'
import { previousPeriod } from './period.js'
import type { BookStore } from './store.js'

const PROFIT_REPORT = 'report.profit'

/** 包里声明为「按余额结转某张报表」的期末项，如损益结转。查利润时不算这些凭证。 */
export function balanceTransferItems(pack: AccountingPackPayload, reportId = PROFIT_REPORT) {
  return pack.closingItems.filter((item) => item.balanceTransfer?.fromReportId === reportId)
}

function profitOf(store: BookStore, pack: AccountingPackPayload, fromPeriod: string, toPeriod: string) {
  const exclude = balanceTransferItems(pack).map((i) => i.itemId)
  const net = new Map(store.movements(toPeriod, fromPeriod, exclude).map((m) => [m.subjectCode, m.netDebitCents]))
  const normal = new Map(pack.catalogs[0]!.subjects.map((s) => [s.subjectCode, s.normalBalance]))
  const lines = pack.reportLines
    .filter((line) => line.reportId === PROFIT_REPORT)
    .map((line) => {
      const cents = line.subjectCodes.reduce((sum, code) => {
        const value = net.get(code) ?? 0n
        return sum + (normal.get(code) === 'debit' ? value : -value)
      }, 0n)
      return { lineId: line.lineId, lineName: line.lineName, cents: line.sign === 'negative' ? -cents : cents }
    })
  // 利润 = 收入类行 − 费用类行；哪些行算收入、哪些算费用由包参数说，包没声明就不给合计。
  const revenueIds = packParameter(pack, 'headline.revenue.lines')?.split('|')
  const expenseIds = packParameter(pack, 'headline.expense.lines')?.split('|')
  const sum = (ids: readonly string[]) => lines.filter((l) => ids.includes(l.lineId)).reduce((s, l) => s + l.cents, 0n)
  const totals =
    revenueIds && expenseIds
      ? {
          revenue: formatCents(sum(revenueIds)),
          expense: formatCents(sum(expenseIds)),
          profit: formatCents(sum(revenueIds) - sum(expenseIds)),
        }
      : null
  return {
    lines: lines.filter((l) => l.cents !== 0n).map((l) => ({ lineName: l.lineName, amount: formatCents(l.cents) })),
    totals,
  }
}

/** 某月利润，以及当年 1 月（或建账月）到该月的累计。都只看损益类科目的发生额，不看现金。 */
export function readProfit(store: BookStore, pack: LoadedPack, periodKey: string) {
  const period = checkPeriod(store, periodKey)
  if ('accepted' in period) return period
  const startOfYear = `${periodKey.slice(0, 4)}-01`
  const takeover = store.company()!.accountingStartMonth
  const covered = new Set(store.historicalPeriods())
  let ytdFrom = periodKey < takeover ? periodKey : startOfYear > takeover ? startOfYear : takeover
  while (ytdFrom > startOfYear && covered.has(previousPeriod(ytdFrom))) ytdFrom = previousPeriod(ytdFrom)
  return {
    accepted: true as const,
    company: period.company,
    isSampleBook: period.isSample,
    periodKey,
    month: profitOf(store, pack.payload, periodKey, periodKey),
    yearToDate: { from: ytdFrom, to: periodKey, ...profitOf(store, pack.payload, ytdFrom, periodKey) },
  }
}

const BALANCE_REPORT = 'report.balance'

/**
 * 某月末的资产负债表（简表）和利润表。行和科目的对应全从会计包的报表行读。
 *
 * 一行归资产方还是负债和所有者权益方，看它科目的正常余额方向和行的正负号：借方科目正号、贷方科目负号
 * （如累计折旧冲减资产）归资产方，其余归另一方。还没结账的月份，利润还留在损益科目里，
 * 这部分并进损益结转的目标科目所在的那一行（未分配利润），两边才对得上。
 */
export function readStatements(store: BookStore, pack: LoadedPack, periodKey: string) {
  const period = checkPeriod(store, periodKey)
  if ('accepted' in period) return period
  const payload = pack.payload
  const normal = new Map(payload.catalogs[0]!.subjects.map((s) => [s.subjectCode, s.normalBalance]))
  const names = new Map(payload.catalogs[0]!.subjects.map((s) => [s.subjectCode, s.subjectName]))
  const net = new Map(store.movements(periodKey).map((m) => [m.subjectCode, m.netDebitCents]))
  const balanceOf = (code: string) => {
    const value = net.get(code) ?? 0n
    return normal.get(code) === 'credit' ? -value : value
  }
  const profitCodes = new Set(payload.reportLines.filter((l) => l.reportId === PROFIT_REPORT).flatMap((l) => l.subjectCodes))
  // 损益科目上还没结转的净额，贷方为正，就是还没并进权益的利润。
  const unclosedProfit = -[...profitCodes].reduce((sum, code) => sum + (net.get(code) ?? 0n), 0n)
  const retainedTarget = balanceTransferItems(payload)[0]?.balanceTransfer?.toSubjectCode

  const assets: { lineName: string; amount: string }[] = []
  const claims: { lineName: string; amount: string }[] = []
  let assetsTotal = 0n
  let claimsTotal = 0n
  const mapped = new Set<string>(profitCodes)
  for (const line of payload.reportLines.filter((l) => l.reportId === BALANCE_REPORT)) {
    for (const code of line.subjectCodes) mapped.add(code)
    let cents = line.subjectCodes.reduce((sum, code) => sum + balanceOf(code), 0n)
    if (retainedTarget && line.subjectCodes.includes(retainedTarget)) cents += unclosedProfit
    const signed = line.sign === 'negative' ? -cents : cents
    const debitSide = (normal.get(line.subjectCodes[0]!) === 'debit') === (line.sign !== 'negative')
    if (debitSide) assetsTotal += signed
    else claimsTotal += signed
    if (signed !== 0n) (debitSide ? assets : claims).push({ lineName: line.lineName, amount: formatCents(signed) })
  }
  const unmapped = [...net]
    .filter(([code, value]) => value !== 0n && !mapped.has(code))
    .map(([code]) => ({ subjectCode: code, subjectName: names.get(code) ?? code, balance: formatCents(balanceOf(code)) }))
  const profit = readProfit(store, pack, periodKey)
  return {
    accepted: true as const,
    company: period.company,
    isSampleBook: period.isSample,
    periodKey,
    balanceSheet: {
      asOf: `${periodKey} 月末`,
      assets,
      assetsTotal: formatCents(assetsTotal),
      liabilitiesAndEquity: claims,
      liabilitiesAndEquityTotal: formatCents(claimsTotal),
      balanced: assetsTotal === claimsTotal,
      ...(unclosedProfit !== 0n ? { unclosedProfitInRetained: formatCents(unclosedProfit) } : {}),
      ...(unmapped.length ? { subjectsNotInReport: unmapped } : {}),
    },
    profit: profit.accepted ? { month: profit.month, yearToDate: profit.yearToDate } : null,
  }
}
