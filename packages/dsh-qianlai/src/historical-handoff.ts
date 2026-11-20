import { formatCents, parseAmountToCents } from '@moneycome/fintax-core'

import { nextPeriod, PERIOD_KEY, refuse, todayInChina } from './period.js'
import type { BookStore } from './store.js'

const scopeOp = 'local-work:history-scope'
const decisionOp = 'local-work:history-decision'
const balanceOp = 'local-work:history-balance'

interface HistoricalScope {
  readonly history: 'previous' | 'unrecorded'
  readonly accountingStartMonth: string
  readonly originalLastMonth: string
  readonly missingMonths: string[]
  readonly coveredMonths: string[]
  readonly overlapMonths: string[]
  readonly materialId: number
}

interface HistoricalBalance {
  readonly id: number
  readonly kind: 'bank_difference' | 'owner_advance'
  readonly amount: string | null
  readonly note: string | null
  readonly materialId: number | null
  readonly state: 'waiting' | 'reconciled'
  readonly voucherNo: string | null
}

function activeHandoff(store: BookStore) {
  const record = store.companyOnboarding()
  const company = store.company()
  if (!company || company.isSample || !record?.completedAt || !record.accounting || !record.enterprise ||
    record.enterprise.taxId !== company.taxId || record.accounting.startMonth !== company.accountingStartMonth) return undefined
  return { company, accounting: record.accounting, establishedOn: record.enterprise.establishedOn }
}

function monthsBetween(from: string, before: string) {
  const result: string[] = []
  for (let month = from; month < before; month = nextPeriod(month)) result.push(month)
  return result
}

function materialValid(store: BookStore, input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && store.workMaterial(input)?.status === 'read'
}

export function historicalHandoffProgress(store: BookStore) {
  const reconstructed = new Set(store.historicalPeriods())
  const decisions = new Map<number, 'confirmed' | 'deferred'>()
  for (const event of store.workEventsByOperation(decisionOp)) {
    const { handoffId } = event.request
    if (typeof handoffId === 'number' && !decisions.has(handoffId))
      decisions.set(handoffId, event.result.state === 'confirmed' ? 'confirmed' : 'deferred')
  }
  const plans = store.workEventsByOperation(scopeOp).map(event => ({
    ...(event.result as unknown as HistoricalScope), handoffId: event.id,
    state: decisions.get(event.id) ?? 'awaiting_confirmation',
  })).map(plan => ({
    ...plan,
    missingMonths: plan.missingMonths.filter(month => !reconstructed.has(month)),
    bookedMonths: plan.missingMonths.filter(month => reconstructed.has(month)),
  }))
  const balances = new Map<number, HistoricalBalance>()
  for (const event of store.workEventsByOperation(balanceOp)) {
    const prior = typeof event.request.adjustmentId === 'number' ? event.request.adjustmentId : event.id
    if (!balances.has(prior)) balances.set(prior, { ...(event.result as unknown as Omit<HistoricalBalance, 'id'>), id: prior })
  }
  return { plans, balances: [...balances.values()] }
}

export function planHistoricalHandoff(store: BookStore, args: Record<string, unknown>, now: Date) {
  const active = activeHandoff(store)
  if (!active) return refuse('HISTORICAL_HANDOFF_UNAVAILABLE', '请先完成本企业建档，再核对历史资料。')
  const { accounting } = active
  if (accounting.history === 'new')
    return { accepted: true as const, accountingStartMonth: accounting.startMonth,
      state: accounting.startMonth > todayInChina(now).slice(0, 7) ? 'starts_later' : 'no_historical_scope',
      affectsLedger: false }
  if (accounting.history !== 'previous' && accounting.history !== 'unrecorded')
    return refuse('HISTORICAL_HANDOFF_UNAVAILABLE', '请先核对以前是否已经做过账。')
  if (!materialValid(store, args.materialId))
    return refuse('HISTORICAL_HANDOFF_MATERIAL_REQUIRED', '先发已经有的合同、收支记录或旧账表，我会按原件核对月份。')
  const pastStart = accounting.history === 'previous' ? nextPeriod(accounting.lastMonth) : args.firstOperatingMonth
  if (typeof pastStart !== 'string' || !PERIOD_KEY.test(pastStart) ||
    (accounting.history === 'unrecorded' && (pastStart < active.establishedOn.slice(0, 7) || pastStart >= accounting.startMonth)))
    return refuse('HISTORICAL_FIRST_OPERATING_MONTH_REQUIRED', '请核对实际开始经营的月份。旧账未知时不会按零处理。')
  const fromSource = args.coveredMonths ?? []
  if (!Array.isArray(fromSource) || fromSource.some(month => typeof month !== 'string' || !PERIOD_KEY.test(month) ||
    month < active.establishedOn.slice(0, 7) || month > todayInChina(now).slice(0, 7)))
    return refuse('HISTORICAL_COVERAGE_INVALID', '请只选原件可以确认已记账的实际月份。')
  const reported = (fromSource as string[]).filter(month => month < accounting.startMonth)
  const coveredMonths = [...new Set(reported)].sort()
  const overlapMonths = [...new Set((fromSource as string[]).filter(month => month >= accounting.startMonth))].sort()
  const coverage = new Set([...coveredMonths, ...store.postedPeriods(), ...store.historicalPeriods()])
  const missingMonths = monthsBetween(pastStart, accounting.startMonth).filter(month => !coverage.has(month))
  const plan = { history: accounting.history, accountingStartMonth: accounting.startMonth,
    originalLastMonth: accounting.lastMonth, missingMonths, coveredMonths, overlapMonths, materialId: args.materialId }
  const progress = historicalHandoffProgress(store)
  const previous = progress.plans.find(item => item.materialId === plan.materialId && item.history === plan.history &&
    item.accountingStartMonth === plan.accountingStartMonth && item.originalLastMonth === plan.originalLastMonth &&
    JSON.stringify(item.coveredMonths) === JSON.stringify(plan.coveredMonths) &&
    JSON.stringify(item.missingMonths) === JSON.stringify(plan.missingMonths) &&
    JSON.stringify(item.overlapMonths) === JSON.stringify(plan.overlapMonths))
  if (previous) return { accepted: true as const, ...previous, affectsLedger: false }
  const handoffId = store.recordWork(scopeOp, { materialId: args.materialId }, plan, now)
  return { accepted: true as const, ...plan, handoffId, state: 'awaiting_confirmation' as const, affectsLedger: false }
}

export function readHistoricalHandoff(store: BookStore, handoffId: number) {
  const active = activeHandoff(store)
  const plan = historicalHandoffProgress(store).plans.find(item => item.handoffId === handoffId)
  if (!plan) return refuse('HISTORICAL_HANDOFF_NOT_FOUND', '未找到这件历史交接事项。')
  if (!active || plan.accountingStartMonth !== active.accounting.startMonth ||
    plan.history !== active.accounting.history || plan.originalLastMonth !== active.accounting.lastMonth)
    return refuse('HISTORICAL_HANDOFF_CHANGED', '交接条件已变化，请按最新档案重新查看范围。')
  return { accepted: true as const, plan }
}

export function confirmHistoricalHandoff(store: BookStore, handoffId: number, decision: 'confirmed' | 'deferred', now: Date) {
  const review = readHistoricalHandoff(store, handoffId)
  if (!review.accepted) return review
  if (review.plan.state !== 'confirmed' && review.plan.state !== decision)
    store.recordWork(decisionOp, { handoffId }, { state: decision }, now)
  return { accepted: true as const, state: review.plan.state === 'confirmed' ? 'confirmed' as const : decision, affectsLedger: false }
}

export function recordHandoffBalance(store: BookStore, args: Record<string, unknown>, now: Date) {
  if (!activeHandoff(store)) return refuse('HISTORICAL_HANDOFF_UNAVAILABLE', '请先完成本企业建档。')
  const kind = args.handoffBalanceKind
  if (kind !== 'bank_difference' && kind !== 'owner_advance')
    return refuse('HISTORICAL_BALANCE_KIND_REQUIRED', '请选择银行差额或老板垫款。')
  const source = args.materialId
  if (source !== undefined && !materialValid(store, source))
    return refuse('HISTORICAL_HANDOFF_MATERIAL_REQUIRED', '这份交接材料未读取成功，请重新发送。')
  const amount = typeof args.handoffAmount === 'string' ? parseAmountToCents(args.handoffAmount) : undefined
  if (args.handoffAmount !== undefined && (amount === undefined || amount <= 0n))
    return refuse('HISTORICAL_BALANCE_INVALID', '请填写已知的正数金额，待核对时可以先留空。')
  const note = typeof args.note === 'string' ? args.note.trim() : ''
  if (note.length > 500 || /\p{C}/u.test(note))
    return refuse('HISTORICAL_BALANCE_INVALID', '请简要填写待核实原因。')
  const { balances } = historicalHandoffProgress(store)
  const previous = balances.find(item => item.id === args.adjustmentId)
  if (args.adjustmentId !== undefined && (!previous || previous.kind !== kind))
    return refuse('HISTORICAL_BALANCE_NOT_FOUND', '未找到这个类型的原交接事项。')
  const value = {
    kind, amount: amount === undefined ? previous?.amount ?? null : formatCents(amount),
    note: note || previous?.note || null, materialId: source ?? previous?.materialId ?? null,
  }
  const original = previous ?? balances.find(item =>
    item.kind === kind && item.amount === value.amount && item.note === value.note && item.materialId === value.materialId)
  if (original?.state === 'reconciled') return { accepted: true as const, adjustment: original, affectsLedger: false }
  const voucherNo = typeof args.handoffVoucherNo === 'string' ? args.handoffVoucherNo : null
  if (voucherNo) {
    const voucher = store.vouchers({ voucherNo })[0]
    const rule = kind === 'bank_difference' ? 'receivable_collection' : 'personal_advance_repayment'
    const lines = store.statementLines({ voucherNo })
    const expectedSign = kind === 'bank_difference' ? 1n : -1n
    const settled = lines.reduce((sum, line) => sum + expectedSign * line.signedCents, 0n)
    const planned = value.amount === null ? undefined : parseAmountToCents(value.amount)
    if (!original || !voucher || voucher.voided || voucher.eventKind !== rule || store.voucherLinkedTo('correction.reverses', voucherNo) ||
      planned === undefined || planned !== settled || lines.some(line => expectedSign * line.signedCents <= 0n) ||
      balances.some(item => item.id !== original.id && item.voucherNo === voucherNo))
      return refuse('HISTORICAL_SETTLEMENT_UNVERIFIED', '这张凭证和流水还不能证明原差额或垫款结清。已保存的交接记录继续待核对。')
  }
  if (original && !voucherNo && original.amount === value.amount &&
    original.note === value.note && original.materialId === value.materialId)
    return { accepted: true as const, adjustment: original, affectsLedger: false }
  const result = { ...value, state: voucherNo ? 'reconciled' as const : 'waiting' as const, voucherNo }
  const id = store.recordWork(balanceOp, original ? { adjustmentId: original.id } : {}, result, now)
  return { accepted: true as const, adjustment: { ...result, id: original?.id ?? id }, affectsLedger: false }
}
