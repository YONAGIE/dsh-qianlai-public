import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatCents, parseAmountToCents } from '@moneycome/fintax-core'

import { onboardingBookStatus } from './company-onboarding.js'
import { isCalendarDate, monthRange, PERIOD_KEY, refuse, todayInChina } from './period.js'
import type { BookStore, WorkEvent } from './store.js'

const SCHEDULE = 'local-work:payroll-schedule'
const DRAFT = 'local-work:payroll-draft'
const PAYMENT = 'local-work:payroll-payment'
const PAYMENT_STATUS = 'local-work:payroll-payment-status'

const amounts = ['gross', 'personalSocial', 'personalHousing', 'individualTax', 'otherDeduction', 'net'] as const
type AmountKey = typeof amounts[number]
type PayrollRow = Readonly<Record<AmountKey, string>> & { employeeId: string; name: string }
interface Draft { materialId?: number; rows: PayrollRow[] }
interface Schedule { mode: 'recurring' | 'once' | 'paused'; payday?: number }
interface Payment { employeeId: string; paidOn: string; amount: string; statementLineId?: number; materialId?: number; reference?: string }
interface PaymentStatus { employeeId: string; status: 'unpaid' | 'unknown' }

export type PayrollProposal =
  | { operation: typeof SCHEDULE; periodKey: string; revision: number; value: Schedule; summary: string[] }
  | { operation: typeof DRAFT; periodKey: string; revision: number; value: Draft; summary: string[] }
  | { operation: typeof PAYMENT; periodKey: string; revision: number; value: Payment; summary: string[] }
  | { operation: typeof PAYMENT_STATUS; periodKey: string; revision: number; value: PaymentStatus; summary: string[] }

const clean = (value: unknown, limit: number): string => typeof value === 'string' && !/[\p{C}]/u.test(value)
  ? value.trim().normalize('NFC').slice(0, limit + 1) : ''
const keyText = (value: unknown, limit: number): string => {
  const result = clean(value, limit)
  return result.length <= limit ? result : ''
}
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const money = (value: unknown): bigint | undefined => {
  if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(value.trim())) return undefined
  return parseAmountToCents(value)
}

const events = (store: BookStore, operation: string, periodKey?: string) =>
  store.workEventsByOperation(operation).filter(item => periodKey === undefined || item.request.periodKey === periodKey)
const eventValue = <T>(event: WorkEvent): T => event.result as unknown as T

function scheduleAt(store: BookStore, periodKey: string) {
  const current = events(store, SCHEDULE)
    .filter(e => e.request.periodKey === periodKey || (String(e.request.periodKey) < periodKey && e.result.mode !== 'once'))
    .sort((left, right) => String(right.request.periodKey).localeCompare(String(left.request.periodKey)))[0]
  const onboarding = current ? undefined : onboardingBookStatus(store)
  const saved = onboarding && 'payroll' in onboarding ? onboarding.payroll : undefined
  const schedule: Schedule | undefined = current ? eventValue<Schedule>(current) : saved?.payroll === 'scheduled' && saved.payday !== undefined
    ? { mode: 'recurring', payday: saved.payday } : saved?.payroll === 'none' ? { mode: 'paused' } : undefined
  if (!schedule) return null
  const effectiveMonth = String(current?.request.periodKey ?? store.company()!.accountingStartMonth)
  const day = schedule.payday
  const lastDay = Number(monthRange(periodKey).to.slice(-2))
  return {
    ...schedule, effectiveMonth, revision: current?.id ?? 0,
    plannedDate: day === undefined ? undefined : periodKey + '-' + String(Math.min(day, lastDay)).padStart(2, '0'),
  }
}

function readPayroll(store: BookStore, periodKey: string, now: Date) {
  const draft = events(store, DRAFT, periodKey)[0]
  const payments = events(store, PAYMENT, periodKey)
  const knownStates = events(store, PAYMENT_STATUS, periodKey).map(eventValue<PaymentStatus>)
  const rows = (draft ? eventValue<Draft>(draft).rows : []).map(row => {
    const receiptRows = payments.map(e => ({ id: e.id, ...eventValue<Payment>(e) })).filter(e => e.employeeId === row.employeeId)
    const paid = receiptRows.reduce((sum, receipt) => sum + parseAmountToCents(receipt.amount)!, 0n)
    const remainder = parseAmountToCents(row.net)! - paid
    const stated = knownStates.find(o => o.employeeId === row.employeeId || o.employeeId === '')
    const paymentStatus = remainder === 0n ? paid > 0n ? 'complete' : 'not-due'
      : paid > 0n ? 'partial' : stated?.status === 'unpaid' ? 'unpaid' : 'unconfirmed'
    return { ...row, paid: formatCents(paid), remaining: formatCents(remainder), receipts: receiptRows, paymentStatus }
  })
  const schedule = scheduleAt(store, periodKey)
  const nextAction = !draft ? {
    kind: schedule?.mode === 'paused' ? 'paused' : 'collect-sheet',
    message: schedule?.mode === 'paused' ? '这个月已暂停发薪安排。' : '请发这个月的工资表，我先按员工核对应发、实发和扣款。',
  } : periodKey > todayInChina(now).slice(0, 7) ? {
    kind: 'future', message: '工资准备稿已保存。实际发放后再核对付款凭据。',
  } : rows.every(row => row.paymentStatus === 'unpaid' || row.paymentStatus === 'not-due') ? {
    kind: 'unpaid', message: '付款仍未开始。先保留工资准备稿，实际支付后再核对。',
  } : rows.some(row => row.paymentStatus === 'partial' || row.paymentStatus === 'unconfirmed' || row.paymentStatus === 'unpaid') ? {
    kind: 'collect-payment-proof', message: '请发已支付部分的银行回单。我会按员工逐笔核对并保留待确认的金额。',
  } : {
    kind: 'complete', message: '本期实发金额已逐笔核对。凭证和个税状态仍以相关账本和申报记录为准。',
  }
  return { accepted: true as const, periodKey, schedule, revision: draft?.id ?? 0,
    sourceMaterialId: draft?.result.materialId, rows, nextAction }
}

function readRow(input: unknown): PayrollRow | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const data = input as Record<string, unknown>
  const employeeId = keyText(data.employeeId, 64)
  const name = keyText(data.name, 80)
  if (!employeeId || !name) return undefined
  const cents = Object.fromEntries(amounts.map(key => [key, money(data[key])])) as Record<AmountKey, bigint | undefined>
  const { gross, personalSocial, personalHousing, individualTax, otherDeduction, net } = cents
  if (gross === undefined || personalSocial === undefined || personalHousing === undefined ||
    individualTax === undefined || otherDeduction === undefined || net === undefined ||
    gross !== net + personalSocial + personalHousing + individualTax + otherDeduction) return undefined
  return { employeeId, name, gross: formatCents(gross), personalSocial: formatCents(personalSocial),
    personalHousing: formatCents(personalHousing), individualTax: formatCents(individualTax),
    otherDeduction: formatCents(otherDeduction), net: formatCents(net) }
}

function proposeSchedule(store: BookStore, periodKey: string, input: Record<string, unknown>) {
  const mode = input.mode
  if (mode !== 'recurring' && mode !== 'once' && mode !== 'paused')
    return refuse('PAYROLL_MODE_INVALID', '请选择长期发薪、仅本月发薪或从本月起暂停。')
  const payday = input.payday
  if (mode !== 'paused' && (!positiveId(payday) || payday > 31))
    return refuse('PAYROLL_PAYDAY_INVALID', '请选择 1–31 日作为发薪日。遇到没有该日期的月份，使用月末最后一天。')
  const value: Schedule = mode === 'paused' ? { mode } : { mode, payday: payday as number }
  const revision = events(store, SCHEDULE)[0]?.id ?? 0
  return { operation: SCHEDULE, periodKey, revision, value, summary: [
    '生效月份 ' + periodKey,
    mode === 'paused' ? '从这个月起暂停发薪安排。' :
      (mode === 'once' ? '只安排这个月' : '以后每个月安排') + '在 ' + value.payday + ' 日发薪。短月取月末。',
    '已经保存的工资和付款记录会保留。',
  ] } satisfies PayrollProposal
}

function proposeDraft(store: BookStore, periodKey: string, input: Record<string, unknown>) {
  const current = events(store, DRAFT, periodKey)[0]
  const revision = current?.id ?? 0
  if (input.revision !== revision) return refuse('PAYROLL_REVISION_CHANGED', '工资草稿已更新，请先打开这个月的最新版本。')
  if (input.materialId !== undefined && (!positiveId(input.materialId) || store.workMaterial(input.materialId)?.status !== 'read'))
    return refuse('PAYROLL_SOURCE_INVALID', '找不到这份已读取的工资表。请先上传并读取原件，或直接核对表单资料。')
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 100)
    return refuse('PAYROLL_ROWS_INVALID', '请填写 1 至 100 名员工的工资资料。')
  const supplied = new Map<string, PayrollRow>()
  for (const [index, item] of input.rows.entries()) {
    const row = readRow(item)
    if (!row) return refuse('PAYROLL_ROW_INVALID', '请核对这一行。应发工资须等于实发与所有已确认扣款之和，空金额不能按零处理。', { row: index + 1 })
    if (supplied.has(row.employeeId)) return refuse('PAYROLL_EMPLOYEE_DUPLICATE', '同一份工资表中员工编号重复。', { row: index + 1 })
    supplied.set(row.employeeId, row)
  }
  const rows = new Map((current ? eventValue<Draft>(current).rows : []).map(row => [row.employeeId, row]))
  for (const [id, row] of supplied) rows.set(id, row)
  if (rows.size > 100) return refuse('PAYROLL_ROWS_INVALID', '此账期最多保存 100 名员工的工资资料。')
  const receipts = events(store, PAYMENT, periodKey).map(eventValue<Payment>)
  for (const [id, row] of supplied) {
    const total = receipts.filter(payment => payment.employeeId === id).reduce((sum, payment) => sum + parseAmountToCents(payment.amount)!, 0n)
    if (total > parseAmountToCents(row.net)!)
      return refuse('PAYROLL_PAID_EXCEEDS_NET', '本次更正后的实发金额小于已核对付款。先核对付款差额再更正工资。', { employeeId: id, paid: formatCents(total) })
  }
  const sourceId = input.materialId as number | undefined
  const value: Draft = { rows: [...rows.values()], ...(sourceId === undefined ? {} : { materialId: sourceId }) }
  const gross = value.rows.reduce((sum, row) => sum + parseAmountToCents(row.gross)!, 0n)
  const net = value.rows.reduce((sum, row) => sum + parseAmountToCents(row.net)!, 0n)
  return { operation: DRAFT, periodKey, revision, value, summary: [
    '工资所属月 ' + periodKey,
    '本次更新 ' + supplied.size + ' 人，汇总 ' + rows.size + ' 人。',
    '合计应发 ' + formatCents(gross) + ' 元，实发计划 ' + formatCents(net) + ' 元。',
    '保存工资准备稿。已核对的付款保留。',
  ] } satisfies PayrollProposal
}

function proposePayment(store: BookStore, periodKey: string, input: Record<string, unknown>, now: Date) {
  const employeeId = keyText(input.employeeId, 64)
  const paidOn = typeof input.paidOn === 'string' ? input.paidOn : ''
  const amount = money(input.amount)
  const company = store.company()!
  if (!isCalendarDate(paidOn) || paidOn < monthRange(company.accountingStartMonth).from || paidOn > todayInChina(now))
    return refuse('PAYROLL_PAYMENT_DATE_INVALID', '请填写账本期间内已经发生的实际付款日期。')
  if (!employeeId || amount === undefined || amount <= 0n)
    return refuse('PAYROLL_PAYMENT_INVALID', '请选择已核对的员工，并填写这次实际支付的金额。')
  const draft = events(store, DRAFT, periodKey)[0]
  const row = draft && eventValue<Draft>(draft).rows.find(employee => employee.employeeId === employeeId)
  if (!draft || !row) return refuse('PAYROLL_EMPLOYEE_UNKNOWN', '请先核对这个月该员工的工资资料。')
  if (input.revision !== draft.id) return refuse('PAYROLL_REVISION_CHANGED', '工资草稿已更新，请先核对最新版本。')
  let value: Payment
  if (positiveId(input.statementLineId) && input.materialId === undefined && input.reference === undefined) {
    const line = store.statementLines({ ids: [input.statementLineId] })[0]
    if (!line || line.occurredOn !== paidOn || line.signedCents !== -amount)
      return refuse('PAYROLL_PAYMENT_SOURCE_INVALID', '流水日期、支出方向或金额与这一笔付款不符。请核对回单。')
    value = { employeeId, paidOn, amount: formatCents(amount), statementLineId: input.statementLineId }
  } else if (positiveId(input.materialId) && input.statementLineId === undefined && store.workMaterial(input.materialId)?.status === 'read') {
    const reference = keyText(input.reference, 100)
    if (!reference) return refuse('PAYROLL_RECEIPT_REFERENCE_NEEDED', '请先核对回单的交易号或原件中唯一的付款行号。')
    value = { employeeId, paidOn, amount: formatCents(amount), materialId: input.materialId, reference }
  } else {
    return refuse('PAYROLL_PAYMENT_SOURCE_NEEDED', '需要已导入的银行流水，或已读取的付款回单。')
  }
  const receipts = events(store, PAYMENT)
  const duplicate = receipts.find(e => value.statementLineId !== undefined ? e.result.statementLineId === value.statementLineId
    : e.result.materialId === value.materialId && e.result.reference === value.reference)
  if (duplicate) {
    if (JSON.stringify(duplicate.result) === JSON.stringify(value) && duplicate.request.periodKey === periodKey)
      return { accepted: true as const, duplicate: true, paymentId: duplicate.id, message: '这笔付款已经核对。' }
    return refuse('PAYROLL_PAYMENT_ALREADY_USED', '这笔付款凭据已用于工资核对，请先查看原记录。', { paymentId: duplicate.id })
  }
  const paid = receipts.filter(e => e.request.periodKey === periodKey && e.result.employeeId === employeeId)
    .reduce((sum, receipt) => sum + parseAmountToCents(String(receipt.result.amount))!, 0n)
  if (paid + amount > parseAmountToCents(row.net)!)
    return refuse('PAYROLL_OVERPAYMENT', '这笔付款加上已核对付款，会超过这名员工本月实发金额。请先核对差额。')
  return { operation: PAYMENT, periodKey, revision: receipts[0]?.id ?? 0, value, summary: [
    row.name, '工资所属月 ' + periodKey, '实付日 ' + paidOn, '核对付款 ' + value.amount + ' 元。',
    '本次只保存付款核对结果。',
  ] } satisfies PayrollProposal
}

function proposePaymentStatus(store: BookStore, periodKey: string, input: Record<string, unknown>) {
  const employeeId = input.employeeId === undefined ? '' : keyText(input.employeeId, 64)
  const draft = events(store, DRAFT, periodKey)[0]
  if (!draft || input.revision !== draft.id)
    return refuse('PAYROLL_REVISION_CHANGED', '请先打开该月最新的工资准备稿。')
  const row = eventValue<Draft>(draft).rows.find(employee => employee.employeeId === employeeId)
  if (input.employeeId !== undefined && !row) return refuse('PAYROLL_EMPLOYEE_UNKNOWN', '请选择已核对的员工。')
  const status = input.paymentStatus
  if (status !== 'unpaid' && status !== 'unknown')
    return refuse('PAYROLL_STATE_INVALID', '请选择确实未付或暂不确定。已付的金额请核对实际回单。')
  const paid = events(store, PAYMENT, periodKey)
  if (status === 'unpaid' && paid.some(e => !employeeId || e.result.employeeId === employeeId))
    return refuse('PAYROLL_PAYMENT_ALREADY_CONFIRMED', '已有付款已核对，不能整项改成未付。可以逐人补充实际状态。')
  const revision = events(store, PAYMENT_STATUS, periodKey)[0]?.id ?? 0
  return { operation: PAYMENT_STATUS, periodKey, revision, value: { employeeId, status }, summary: [
    '工资所属月 ' + periodKey,
    row?.name ?? '本期全部员工',
    status === 'unpaid' ? '已核对为未发放。' : '暂不确定发放情况，保留为待核对。',
  ] } satisfies PayrollProposal
}

export function reviewPayroll(store: BookStore, input: Record<string, unknown>, now: Date, exportRoot: string) {
  const company = store.company()
  if (!company || company.isSample) return refuse('PAYROLL_BOOK_NEEDED', '请先为公司建档，再核对工资。')
  const selected = todayInChina(now).slice(0, 7)
  const periodKey = typeof input.periodKey === 'string' ? input.periodKey : selected
  if (!PERIOD_KEY.test(periodKey) || periodKey < company.accountingStartMonth)
    return refuse('PAYROLL_PERIOD_INVALID', '请选择本账本的工资所属月。')
  if (input.action === 'status') return readPayroll(store, periodKey, now)
  if (input.action === 'revisions') return { accepted: true as const, periodKey, revisions: events(store, DRAFT, periodKey).slice(0, 20)
    .map(e => ({ revision: e.id, time: e.createdAt, ...eventValue<Draft>(e) })) }
  if (input.action === 'download') return downloadPayroll(store, periodKey, now, exportRoot)
  if (input.periodKey === undefined) return refuse('PAYROLL_PERIOD_INVALID', '请先确定要办理的工资所属月。')
  if (input.action === 'schedule') return proposeSchedule(store, periodKey, input)
  if (input.action === 'draft') return proposeDraft(store, periodKey, input)
  if (input.action === 'payment') return proposePayment(store, periodKey, input, now)
  if (input.action === 'payment-state') return proposePaymentStatus(store, periodKey, input)
  return refuse('PAYROLL_ACTION_INVALID', '请选择当前需要办理的工资事项。')
}

export function savePayroll(store: BookStore, old: PayrollProposal, input: Record<string, unknown>, now: Date) {
  return store.transaction(() => {
    const next = reviewPayroll(store, input, now, '')
    if (!('operation' in next) || JSON.stringify(next) !== JSON.stringify(old))
      return refuse('PAYROLL_CHANGED', '确认期间工资资料有变动，请重新核对。')
    const current = events(store, old.operation, old.periodKey)[0]
    if (old.operation !== PAYMENT && current && JSON.stringify(current.result) === JSON.stringify(old.value))
      return { accepted: true as const, duplicate: true, periodKey: old.periodKey, revision: current.id }
    const id = store.recordWork(old.operation, { periodKey: old.periodKey }, old.value, now)
    return { accepted: true as const, periodKey: old.periodKey, revision: id,
      message: '已保存本次工资核对结果。', nextAction: readPayroll(store, old.periodKey, now).nextAction }
  })
}

function csv(value: string) {
  const text = /^[=+\-@\t\r]/.test(value) ? "'" + value : value
  return '"' + text.replaceAll('"', '""') + '"'
}

function downloadPayroll(store: BookStore, periodKey: string, now: Date, exportRoot: string) {
  const result = readPayroll(store, periodKey, now)
  if (!result.revision) return refuse('PAYROLL_DRAFT_MISSING', '请先确认这期的工资准备稿。')
  const columns = ['工资所属月', '员工号', '姓名', '应发', '个人社保', '个人公积金', '个税', '其他扣款', '计划实发', '已核对实发', '未核对实发']
  const records = result.rows.map(row => [periodKey, row.employeeId, row.name, ...amounts.map(key => row[key]), row.paid, row.remaining])
  mkdirSync(exportRoot, { recursive: true })
  const dir = mkdtempSync(join(exportRoot, 'payroll-' + periodKey + '-'))
  const path = join(dir, '工资准备稿.csv')
  try {
    writeFileSync(path, '\uFEFF' + [columns, ...records].map(row => row.map(csv).join(',')).join('\r\n') + '\r\n', { flag: 'wx' })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return { accepted: true as const, periodKey, revision: result.revision, path,
    message: '工资准备稿已导出，可供核对。' }
}
