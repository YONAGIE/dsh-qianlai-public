import { formatCents, parseAmountToCents, type AccountingPackPayload } from '@moneycome/fintax-core'

import { checkPeriod } from './balances.js'
import { parseInvoiceTaxRate } from './invoices.js'
import type { LoadedPack } from './pack.js'
import { monthRange, refuse, todayInChina } from './period.js'
import { balanceTransferItems } from './reports.js'
import type { BookStore } from './store.js'

type Deadline = AccountingPackPayload['deadlines'][number]

/** 季度增值税申报在会计包期限表里的 id。 */
const VAT_QUARTERLY = 'vat.quarterly'
/** 利润表里的营业收入行；营业外收入不算增值税销售额。 */
const REVENUE_LINE = 'line.revenue'

const QUARTER_KEY = /^(\d{4})-Q([1-4])$/

const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumSignificantDigits: 15 })
type InvoiceTotal = bigint | null
const addReadAmounts = (a: InvoiceTotal, b: InvoiceTotal): InvoiceTotal => a === null || b === null ? null : a + b
const displayAmount = (v: InvoiceTotal) => v === null ? null : formatCents(v)

function invoiceFigure(facts: Readonly<Record<string, unknown>>, key: 'amountExclTax' | 'taxAmount' | 'taxRate') {
  // Older stored invoices may retain candidate text alongside an unreadable marker.
  const unreadable = facts.unreadable
  if (Array.isArray(unreadable) && (unreadable.includes(key) || unreadable.includes(key + 'Cents'))) return undefined
  const value = facts[key]
  return typeof value === 'string' ? value : undefined
}

const invoiceCents = (value: string | undefined) => value === undefined ? null : parseAmountToCents(value.replace(/[¥￥,\s]/g, '')) ?? null

/** 期间最后一个月，`YYYY-MM`。期间写法：月 `YYYY-MM`、季 `YYYY-Qn`、年 `YYYY`。 */
function periodEndMonth(periodKey: string): string {
  const quarter = QUARTER_KEY.exec(periodKey)
  if (quarter) return `${quarter[1]}-${String(Number(quarter[2]) * 3).padStart(2, '0')}`
  if (/^\d{4}$/.test(periodKey)) return `${periodKey}-12`
  return periodKey
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** 按常规推算的截止日：期间结束后第 monthOffset 个月的 dayOfMonth 日，月底不够就取月末。 */
function ruleDueDate(deadline: Deadline, periodKey: string): string {
  const month = addMonths(periodEndMonth(periodKey), deadline.monthOffset)
  const last = monthRange(month).to
  const day = `${month}-${String(deadline.dayOfMonth).padStart(2, '0')}`
  return day > last ? last : day
}

/** 今天前后三年里这一项的全部期间，从早到晚。 */
function periodsAround(deadline: Deadline, today: string): string[] {
  const year = Number(today.slice(0, 4))
  const keys: string[] = []
  for (let y = year - 1; y <= year + 1; y++) {
    if (deadline.cadence === 'yearly') keys.push(String(y))
    else if (deadline.cadence === 'quarterly') for (let q = 1; q <= 4; q++) keys.push(`${y}-Q${q}`)
    else for (let m = 1; m <= 12; m++) keys.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return keys
}

/** 这一项下一个还没到的截止日。期限表里有这一期的日期就用表里的（带出处），没有就按常规推算。 */
function nextDue(deadline: Deadline, today: string) {
  const dated = new Map((deadline.calendar ?? []).map((c) => [c.periodKey, c]))
  for (const periodKey of periodsAround(deadline, today)) {
    const entry = dated.get(periodKey)
    const dueDate = entry?.dueDate ?? ruleDueDate(deadline, periodKey)
    if (dueDate >= today) return { periodKey, dueDate, basisSourceId: entry?.basisSourceId }
  }
  return undefined
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/**
 * 接下来要办的事：会计包期限表里每一项的下一个截止日，按日期排。
 * 结账这一类看账本就知道办没办；报税这一类插件不知道老板报没报，只提醒日期。
 */
export function upcomingDeadlines(store: BookStore, pack: LoadedPack, now: Date) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  const today = todayInChina(now)
  const locked = new Set(store.lockedPeriods())
  const sources = new Map(pack.payload.sources.map((s) => [s.sourceId, s]))
  // 结账类：建账以来最早一个过了期限还没结的月份，报成逾期。
  const overdueClose = (deadline: Deadline) => {
    if (company.isSample) return undefined
    for (let month = company.accountingStartMonth; month < today.slice(0, 7); month = addMonths(month, 1)) {
      if (locked.has(month)) continue
      const dueDate = ruleDueDate(deadline, month)
      return dueDate < today ? { periodKey: month, dueDate, basisSourceId: undefined } : undefined
    }
    return undefined
  }
  const items = pack.payload.deadlines.flatMap((deadline) => {
    const due = (deadline.kind === 'period_close' ? overdueClose(deadline) : undefined) ?? nextDue(deadline, today)
    if (!due) return []
    const basis = due.basisSourceId ? sources.get(due.basisSourceId) : undefined
    return [
      {
        deadlineId: deadline.deadlineId,
        title: deadline.title,
        period: due.periodKey,
        dueDate: due.dueDate,
        daysLeft: daysBetween(today, due.dueDate),
        ...(deadline.consequence ? { consequence: deadline.consequence } : {}),
        ...(basis ? { basis: { document: basis.documentNumber ?? basis.citation, ...(basis.url ? { url: basis.url } : {}) } } : {}),
        ...(!basis && deadline.kind === 'tax_filing'
          ? { estimated: '按常规日期推算，遇节假日可能顺延，以当地税务局公布的为准。' }
          : {}),
        ...(deadline.kind === 'period_close'
          ? { done: locked.has(due.periodKey) }
          : { done: null, note: '报没报税插件不知道，要问老板或会计。' }),
      },
    ]
  })
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  return { accepted: true as const, today, isSampleBook: company.isSample, companyFacts: store.companyFacts(), items }
}

/** 账本现状里带上的近期提醒：没办的、10 天内到期的。 */
export function dueSoon(store: BookStore, pack: LoadedPack, now: Date) {
  const all = upcomingDeadlines(store, pack, now)
  if (!all.accepted) return []
  return all.items
    .filter((i) => i.done !== true && i.daysLeft <= 10)
    .map((i) => ({ title: i.title, period: i.period, dueDate: i.dueDate, daysLeft: i.daysLeft }))
}

/**
 * 季度申报准备单：把账上这个季度的销项发票和收入汇总出来，给老板和会计核对。
 *
 * 只给账上的数：销项发票按税率分组的不含税金额与税额、每个月账上的营业收入、两者的差。
 * 免不免征、按什么征收率、附加税费多少、最后交多少，要结合纳税人身份和当期政策判断，交给会计按申报表算。
 */
export function quarterFilingPrep(store: BookStore, pack: LoadedPack, quarter: string, now: Date) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  const match = QUARTER_KEY.exec(quarter)
  if (!match) return refuse('QUARTER_INVALID', `季度要写成 YYYY-Qn，如 2026-Q3，收到的是 ${quarter}。`)
  const firstMonth = `${match[1]}-${String((Number(match[2]) - 1) * 3 + 1).padStart(2, '0')}`
  const today = todayInChina(now)
  if (firstMonth > today.slice(0, 7)) return refuse('PERIOD_FUTURE', `${quarter} 还没开始。`)
  const lastMonth = addMonths(firstMonth, 2)
  const bookStart = company.accountingStartMonth
  if (lastMonth < bookStart) return refuse('PERIOD_BEFORE_BOOK', `这本账从 ${bookStart} 开始记，没有 ${quarter} 的账。`)
  const months = [0, 1, 2].map((n) => addMonths(firstMonth, n)).filter((month) => month >= bookStart)
  const from = `${months[0]}-01`
  const to = monthRange(lastMonth).to

  const revenueCodes = new Set(pack.payload.reportLines.filter((l) => l.lineId === REVENUE_LINE).flatMap((l) => l.subjectCodes))
  // 结账时的损益结转把收入转走了，不算进当月收入。
  const transfers = balanceTransferItems(pack.payload).map((i) => i.itemId)
  const monthly = months.map((month) => {
    const inBook = checkPeriod(store, month)
    const revenue =
      !('accepted' in inBook)
        ? -store.movements(month, month, transfers).filter((m) => revenueCodes.has(m.subjectCode)).reduce((s, m) => s + m.netDebitCents, 0n)
        : 0n
    return { month, closed: store.lockedPeriods().includes(month), revenueOnBooks: revenue }
  })

  const byRate = new Map<string, { count: number; net: InvoiceTotal; tax: InvoiceTotal }>()
  const notRecorded: string[] = []
  const incompleteInvoices: { invoiceNumber: string; fields: string[] }[] = []
  for (const invoice of store.invoices({ from, to, direction: 'output' })) {
    const net = invoiceCents(invoiceFigure(invoice.facts, 'amountExclTax'))
    const tax = invoiceCents(invoiceFigure(invoice.facts, 'taxAmount'))
    const parsedRate = parseInvoiceTaxRate(invoiceFigure(invoice.facts, 'taxRate') ?? '')
    const rate = parsedRate === undefined ? '未读到税率' : percent.format(parsedRate)
    const fields = []
    if (net === null) fields.push('amountExclTax')
    if (tax === null) fields.push('taxAmount')
    if (parsedRate === undefined) fields.push('taxRate')
    if (fields.length) incompleteInvoices.push({ invoiceNumber: invoice.invoiceNumber, fields })
    const group = byRate.get(rate) ?? { count: 0, net: 0n, tax: 0n }
    group.count += 1
    group.net = addReadAmounts(group.net, net)
    group.tax = addReadAmounts(group.tax, tax)
    byRate.set(rate, group)
    if (!invoice.voucherNo) notRecorded.push(invoice.invoiceNumber)
  }
  const invoicedNet = [...byRate.values()].reduce<InvoiceTotal>((sum, group) => addReadAmounts(sum, group.net), 0n)
  const revenueTotal = monthly.reduce((s, m) => s + m.revenueOnBooks, 0n)
  const deadline = pack.payload.deadlines.find((d) => d.deadlineId === VAT_QUARTERLY)
  const due = deadline ? (deadline.calendar?.find((c) => c.periodKey === quarter)?.dueDate ?? ruleDueDate(deadline, quarter)) : undefined

  return {
    accepted: true as const,
    quarter,
    isSampleBook: company.isSample,
    ...(firstMonth < bookStart ? { coverage: { from, to } } : {}),
    ...(due ? { dueDate: due } : {}),
    months: monthly.map((m) => ({ month: m.month, closed: m.closed, revenueOnBooks: formatCents(m.revenueOnBooks) })),
    revenueOnBooks: formatCents(revenueTotal),
    outputInvoices: [...byRate].map(([rate, g]) => ({ taxRate: rate, count: g.count, amountExclTax: displayAmount(g.net), tax: displayAmount(g.tax) })),
    invoicedAmountExclTax: displayAmount(invoicedNet),
    revenueMinusInvoiced: invoicedNet === null ? null : formatCents(revenueTotal - invoicedNet),
    ...(incompleteInvoices.length ? { incompleteInvoices } : {}),
    ...(notRecorded.length ? { outputInvoicesNotRecorded: notRecorded } : {}),
    warnings: [
      ...(firstMonth < bookStart ? [`本季度仅汇总 ${from} 至 ${to} 的账。建账前的收入和销项票需另行核对。`] : []),
      ...(monthly.some((m) => !m.closed) ? ['这个季度还有月份没结账，数字可能还会变。'] : []),
      ...(incompleteInvoices.length ? ['部分销项发票金额或税率待核对，请按票号补核。相应金额无法汇总时留空。'] : []),
      ...(invoicedNet !== null && revenueTotal !== invoicedNet ? ['账上收入和开出的发票金额不一致：可能有没开票的收入，或者有票还没记账，请会计核对。'] : []),
    ],
    reminder: '这张单子只汇总账上的数，不是申报表。免不免征、按什么征收率、附加税费多少、最后交多少，请会计按申报表算；张姐不代为申报。',
  }
}
