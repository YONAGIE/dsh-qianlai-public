import { formatCents, parseAmountToCents } from '@moneycome/fintax-core'

import { isCalendarDate, refuse, todayInChina } from './period.js'
import type { BookStore } from './store.js'

const fundsOperation = 'local-work:funds-arrangement'

interface FundsArrangement {
  readonly summary: string
  readonly direction: 'receipt' | 'payment'
  readonly scheduledOn: string
  readonly amount: string
  readonly status: 'scheduled'
  readonly affectsLedger: false
}

export function currentFundsArrangements(store: BookStore) {
  const events = store.workEventsByOperation(fundsOperation)
  const cancelled = new Set(events.filter(event => event.request.action === 'cancel').map(event => event.request.arrangementId))
  return events.filter(event => event.request.action === 'schedule' && !cancelled.has(event.id))
    .map(event => ({ ...(event.result as unknown as FundsArrangement), arrangementId: event.id }))
}

export function saveFundsArrangement(store: BookStore, args: Record<string, unknown>, now: Date) {
  const company = store.company()
  if (!company || company.isSample) return refuse('NO_BOOK', '请先完成本公司的建档。')
  return store.transaction(() => {
    const active = currentFundsArrangements(store)
    if (args.action === 'cancel-funds') {
      const arrangementId = args.arrangementId
      const item = active.find(plan => plan.arrangementId === arrangementId)
      if (!item) return refuse('FUNDS_PLAN_NOT_FOUND', '没找到这项尚在安排中的收付款。请先查看当前安排。')
      store.recordWork(fundsOperation, { action: 'cancel', arrangementId }, { status: 'cancelled' }, now)
      return { accepted: true as const, arrangementId, status: 'cancelled' as const, affectsLedger: false }
    }

    const summary = typeof args.title === 'string' ? args.title.trim() : ''
    const direction = args.fundsDirection
    const scheduledOn = args.scheduledOn
    const amount = typeof args.fundsAmount === 'string' ? parseAmountToCents(args.fundsAmount.trim()) : undefined
    if (!summary || summary.length > 120 || /\p{C}/u.test(summary) || (direction !== 'receipt' && direction !== 'payment') ||
      typeof scheduledOn !== 'string' || !isCalendarDate(scheduledOn) || scheduledOn <= todayInChina(now) ||
      amount === undefined || amount <= 0n)
      return refuse('FUNDS_PLAN_INVALID', '请核对计划名称、收款或付款、具体日期和金额。这里保存尚未发生的收付款安排。')
    const result = { summary, direction, scheduledOn, amount: formatCents(amount), status: 'scheduled' as const, affectsLedger: false }
    const previous = active.find(plan => plan.summary === result.summary && plan.direction === result.direction &&
      plan.scheduledOn === result.scheduledOn && plan.amount === result.amount)
    if (previous) return { accepted: true as const, ...previous, reused: true }
    const arrangementId = store.recordWork(fundsOperation, { action: 'schedule' }, result, now)
    return { accepted: true as const, arrangementId, ...result }
  })
}
