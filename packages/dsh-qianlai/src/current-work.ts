import { readFileSync } from 'node:fs'

import { parseAmountToCents } from '@moneycome/fintax-core'

import { onboardingBookStatus } from './company-onboarding.js'
import { dueSoon } from './deadlines.js'
import type { LoadedPack } from './pack.js'
import { todayInChina } from './period.js'
import type { BookStore } from './store.js'

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

function payrollReceiptPending(store: BookStore, month: string) {
  const draft = store.workEventsByOperation('local-work:payroll-draft').find(event => event.request.periodKey === month)
  if (!Array.isArray(draft?.result.rows)) return false
  const paidByEmployee = new Map<string, bigint>()
  for (const payment of store.workEventsByOperation('local-work:payroll-payment')) {
    const { employeeId, amount } = payment.result
    if (payment.request.periodKey !== month || typeof employeeId !== 'string' || typeof amount !== 'string') continue
    const cents = parseAmountToCents(amount)
    if (cents !== undefined) paidByEmployee.set(employeeId, (paidByEmployee.get(employeeId) ?? 0n) + cents)
  }
  return draft.result.rows.some(row => {
    if (!row || typeof row.employeeId !== 'string' || typeof row.net !== 'string') return false
    const expected = parseAmountToCents(row.net)
    return expected !== undefined && expected > (paidByEmployee.get(row.employeeId) ?? 0n)
  })
}

export function currentWork(store: BookStore, pack: LoadedPack, now: Date) {
  const company = store.company()
  const identity = { company: company?.name ?? null, version: metadata.version, scope: 'current-local-book' as const }
  const date = todayInChina(now)
  if (!company || company.isSample) return { date, identity, reminders: [],
    nextAction: { kind: 'onboarding' as const, message: '可以开始企业建档。' } }
  if (company.accountingStartMonth > date.slice(0, 7)) return { date, identity, reminders: [],
    nextAction: { kind: 'scheduled-start' as const, message: '已约定从 ' + company.accountingStartMonth + ' 开始记账。' } }

  const reminders = dueSoon(store, pack, now)
  const onboarding = onboardingBookStatus(store)
  if (onboarding?.completed === false) return { date, identity, reminders: [],
    nextAction: { kind: 'onboarding' as const, message: onboarding.guidance } }
  if (!store.openingBalancesSetAt()) return { date, identity, reminders: [],
    nextAction: { kind: 'opening' as const, message: onboarding?.completed ? onboarding.guidance : '请核对起账月初的余额。' } }
  const due = reminders[0]
  if (due) return { date, identity, reminders, nextAction: {
    kind: 'deadline' as const, message: due.label, period: due.period, source: due.source,
  } }
  const unresolved = store.pendingWorkMatters().find(matter => matter.missing.length > 0 && (!matter.period || matter.period <= date.slice(0, 7)))
  if (unresolved) return { date, identity, reminders, nextAction: {
    kind: 'material' as const, matterId: unresolved.id, message: '请补「' + unresolved.title + '」的' + unresolved.missing[0] + '。',
  } }
  const month = date.slice(0, 7)
  if (payrollReceiptPending(store, month)) return { date, identity, reminders, nextAction: {
    kind: 'payroll' as const, period: month, message: '这期工资还有付款情况待核对。已付款的部分可以直接发回单。',
  } }
  return { date, identity, reminders, nextAction: {
    kind: 'ready' as const, message: '当前没有要您处理的待补事项。收到新的发票、流水或工资资料后，我会接着办。',
  } }
}
