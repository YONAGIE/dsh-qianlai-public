import { formatCents, parseAmountToCents } from '@moneycome/fintax-core'

import { isCalendarDate, PERIOD_KEY, refuse, todayInChina } from './period.js'
import type { BookStore, WorkEvent } from './store.js'

type Benefit = 'insurance' | 'housing'
type EnrollmentStatus = 'pending' | 'verified' | 'failed'
interface Enrollment { employeeId: string; name: string; status: EnrollmentStatus; materialId?: number; reason?: string }
interface Row { employeeId: string; name: string; companyAmount: string; personalAmount: string }
interface Paid { paidOn: string; materialId: number; reference: string; paidTotal: string }
interface Contribution { originId?: number; rows: Row[]; materialId?: number; paid?: Paid }
const ENROLLMENT = 'local-work:benefit-enrollment'
const CONTRIBUTION = 'local-work:benefit-contribution'
const label: Record<Benefit, string> = { insurance: '社保', housing: '公积金' }
export type BenefitProposal =
  | { operation: typeof ENROLLMENT; benefit: Benefit; periodKey: string; revision: number; value: Enrollment; summary: string[] }
  | { operation: typeof CONTRIBUTION; benefit: Benefit; periodKey: string; revision: number; value: Contribution; summary: string[] }

const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const text = (value: unknown, limit: number): string => typeof value === 'string' && value.trim().length <= limit && !/[\p{C}]/u.test(value)
  ? value.trim().normalize('NFC') : ''
const amount = (value: unknown): bigint | undefined => typeof value === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(value.trim())
  ? parseAmountToCents(value) : undefined
const stored = <T>(event: WorkEvent) => event.result as unknown as T
const hasEvidence = (store: BookStore, value: unknown): value is number => id(value) && store.workMaterial(value)?.status === 'read'
const belongsTo = (event: WorkEvent, benefit: Benefit, periodKey: string) =>
  event.request.benefit === benefit && event.request.periodKey === periodKey

function activeContributions(store: BookStore) {
  const active = new Map<number, WorkEvent>()
  for (const event of store.workEventsByOperation(CONTRIBUTION)) {
    const origin = stored<Contribution>(event).originId ?? event.id
    if (!active.has(origin)) active.set(origin, event)
  }
  return [...active.values()]
}

function totals(rows: Row[]) {
  const company = rows.reduce((sum, row) => sum + parseAmountToCents(row.companyAmount)!, 0n)
  const personal = rows.reduce((sum, row) => sum + parseAmountToCents(row.personalAmount)!, 0n)
  return { companyTotal: formatCents(company), personalTotal: formatCents(personal), total: formatCents(company + personal) }
}

function benefitStatus(store: BookStore, benefit: Benefit, periodKey: string) {
  const enrollment = new Map<string, Enrollment>()
  for (const event of store.workEventsByOperation(ENROLLMENT).filter(e => belongsTo(e, benefit, periodKey))) {
    const person = stored<Enrollment>(event)
    if (!enrollment.has(person.employeeId)) enrollment.set(person.employeeId, person)
  }
  const people = [...enrollment.values()]
  const latest = activeContributions(store).find(e => belongsTo(e, benefit, periodKey))
  const contribution = latest && stored<Contribution>(latest)
  const failed = people.find(person => person.status === 'failed')
  const pending = people.find(person => person.status === 'pending')
  const nextAction = failed ? {
    kind: 'retry-result', employeeId: failed.employeeId, message: '这一位的办理结果未核对成功。核对原因后可以单独登记复办。',
  } : pending ? {
    kind: 'upload-result', employeeId: pending.employeeId, message: '这位员工的办理结果待核对。请发对应回执。',
  } : !contribution ? {
    kind: 'collect-contribution', message: '请发这期缴费明细。我会分开核对单位和个人金额。',
  } : !contribution.paid ? {
    kind: 'collect-payment', message: '这期缴费明细已保存。实际缴费后请发缴费凭据。',
  } : {
    kind: 'complete', message: '本期费用及缴费凭据已核对。留意实际账本的入账状态。',
  }
  return { accepted: true as const, benefit, periodKey, people,
    contribution: latest && contribution && { ...contribution, revision: latest.id, ...totals(contribution.rows) }, nextAction }
}

function proposeEnrollment(store: BookStore, benefit: Benefit, periodKey: string, input: Record<string, unknown>) {
  const employeeId = text(input.employeeId, 64)
  const name = text(input.name, 80)
  const status = input.status
  if (!employeeId || !name || (status !== 'pending' && status !== 'verified' && status !== 'failed'))
    return refuse('BENEFIT_EMPLOYEE_INVALID', '请选择一个员工和本地登记结果。')
  const revision = store.workEventsByOperation(ENROLLMENT)
    .find(e => belongsTo(e, benefit, periodKey) && e.result.employeeId === employeeId)?.id ?? 0
  const materialId = input.materialId
  if ((status === 'verified' || materialId !== undefined) && !hasEvidence(store, materialId))
    return refuse('BENEFIT_EVIDENCE_NEEDED', '请先读取该员工的办理回执，再核对结果。')
  const reason = text(input.reason, 240)
  if (status === 'failed' && !reason) return refuse('BENEFIT_REASON_NEEDED', '请先核对这位员工的失败原因。')
  const value: Enrollment = { employeeId, name, status,
    ...(id(materialId) ? { materialId } : {}), ...(reason ? { reason } : {}) }
  return { operation: ENROLLMENT, benefit, periodKey, revision, value, summary: [
    label[benefit] + ' · ' + periodKey, name,
    status === 'verified' ? '保存已核对的办理回执。' : status === 'failed' ? '保存需复办结果。' : '登记为待核对。',
    ...(reason ? ['原因 ' + reason] : []),
  ] } satisfies BenefitProposal
}

function contributionRow(value: unknown): Row | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const employeeId = text(input.employeeId, 64)
  const name = text(input.name, 80)
  const company = amount(input.companyAmount)
  const personal = amount(input.personalAmount)
  if (!employeeId || !name || company === undefined || personal === undefined) return undefined
  return { employeeId, name, companyAmount: formatCents(company), personalAmount: formatCents(personal) }
}

function proposeContribution(store: BookStore, benefit: Benefit, periodKey: string, input: Record<string, unknown>) {
  const latest = activeContributions(store).find(e => belongsTo(e, benefit, periodKey))
  const current = latest && stored<Contribution>(latest)
  const revision = latest?.id ?? 0
  if (input.revision !== revision) return refuse('BENEFIT_REVISION_CHANGED', '这期缴费资料已更新，请核对最新版本。')
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 100)
    return refuse('BENEFIT_ROWS_NEEDED', '请填写 1 至 100 人的缴费明细。')
  if (input.materialId !== undefined && !hasEvidence(store, input.materialId))
    return refuse('BENEFIT_EVIDENCE_NEEDED', '找不到这份已读取的缴费明细，请先读取文件。')
  const updates = new Map<string, Row>()
  for (const [i, value] of input.rows.entries()) {
    const row = contributionRow(value)
    if (!row || updates.has(row.employeeId))
      return refuse('BENEFIT_ROW_INVALID', '请核对缴费金额和员工编号。单位与个人金额都须提供，重复员工请合并。', { row: i + 1 })
    updates.set(row.employeeId, row)
  }
  const combined = new Map((current?.rows ?? []).map(row => [row.employeeId, row]))
  for (const [key, row] of updates) combined.set(key, row)
  if (combined.size > 100) return refuse('BENEFIT_ROWS_NEEDED', '本期最多可保存 100 人的缴费明细。')
  const rows = [...combined.values()]
  if (current?.paid && JSON.stringify(rows) !== JSON.stringify(current.rows))
    return refuse('BENEFIT_ALREADY_PAID', '这份费用已有实缴记录，请先核对缴费凭据差额。')
  const value: Contribution = { ...current, rows, ...(latest ? { originId: current?.originId ?? latest.id } : {}),
    ...(id(input.materialId) ? { materialId: input.materialId } : {}) }
  const sums = totals(rows)
  return { operation: CONTRIBUTION, benefit, periodKey, revision, value, summary: [
    label[benefit] + '所属月 ' + periodKey, '个人 ' + sums.personalTotal + ' 元，单位 ' + sums.companyTotal + ' 元。',
    '保存缴费核对资料。',
  ] } satisfies BenefitProposal
}

function proposePaid(store: BookStore, benefit: Benefit, periodKey: string, input: Record<string, unknown>, now: Date) {
  const active = activeContributions(store)
  const latest = active.find(e => belongsTo(e, benefit, periodKey))
  if (!latest || input.revision !== latest.id) return refuse('BENEFIT_REVISION_CHANGED', '请先核对这期最新的缴费资料。')
  const current = stored<Contribution>(latest)
  const paidOn = text(input.paidOn, 10)
  const reference = text(input.reference, 100)
  const paidTotal = amount(input.paidTotal)
  if (!isCalendarDate(paidOn) || paidOn > todayInChina(now) || paidOn.slice(0, 7) < store.company()!.accountingStartMonth ||
      !hasEvidence(store, input.materialId) || !reference || paidTotal === undefined || paidTotal <= 0n)
    return refuse('BENEFIT_PAYMENT_PROOF_INVALID', '请核对本账本期间内的实际缴费日期、金额及已读取的缴费凭据。')
  if (formatCents(paidTotal) !== totals(current.rows).total)
    return refuse('BENEFIT_PAYMENT_MISMATCH', '本次实缴金额与单位和个人明细的合计不符，请核对回执和明细。')
  const prior = active.find(e => {
    const match = stored<Contribution>(e).paid
    return match?.materialId === input.materialId && match?.reference === reference
  })
  if (prior?.id === latest.id && current.paid?.paidOn === paidOn && current.paid.paidTotal === formatCents(paidTotal))
    return { accepted: true as const, duplicate: true, revision: latest.id, message: '已核对过这份缴费凭据。' }
  if (prior || current.paid) return refuse('BENEFIT_PAYMENT_ALREADY_USED', '缴费记录已经存在，请核对原记录。')
  const value: Contribution = { ...current, originId: current.originId ?? latest.id,
    paid: { paidOn, materialId: input.materialId, reference, paidTotal: formatCents(paidTotal) } }
  return { operation: CONTRIBUTION, benefit, periodKey, revision: latest.id, value, summary: [
    label[benefit] + '所属月 ' + periodKey, '实缴日 ' + paidOn, '实缴 ' + formatCents(paidTotal) + ' 元。',
    '保存缴费凭据。',
  ] } satisfies BenefitProposal
}

function proposeMove(store: BookStore, benefit: Benefit, periodKey: string, input: Record<string, unknown>) {
  const active = activeContributions(store)
  const latest = active.find(e => belongsTo(e, benefit, periodKey))
  if (!latest || input.revision !== latest.id)
    return refuse('BENEFIT_REVISION_CHANGED', '请先核对要更正所属月的最新缴费记录。')
  const target = text(input.targetPeriodKey, 7)
  if (!PERIOD_KEY.test(target) || target === periodKey || target < store.company()!.accountingStartMonth)
    return refuse('BENEFIT_TARGET_PERIOD_INVALID', '请选择正确的缴费所属月。')
  if (active.some(e => belongsTo(e, benefit, target)))
    return refuse('BENEFIT_TARGET_OCCUPIED', '目标月份已有同类缴费资料，请先核对是否为同一笔。')
  const current = stored<Contribution>(latest)
  return { operation: CONTRIBUTION, benefit, periodKey: target, revision: latest.id,
    value: { ...current, originId: current.originId ?? latest.id }, summary: [
      label[benefit] + '所属月从 ' + periodKey + ' 更正为 ' + target + '。',
      '已保存的原件、实缴日和金额继续保留。',
    ] } satisfies BenefitProposal
}

export function reviewBenefit(store: BookStore, input: Record<string, unknown>, now: Date) {
  const company = store.company()
  if (!company || company.isSample) return refuse('BENEFIT_BOOK_NEEDED', '请先为公司建档。')
  const benefit = input.benefit
  if (benefit !== 'insurance' && benefit !== 'housing') return refuse('BENEFIT_TYPE_NEEDED', '请选择社保或公积金。')
  const periodKey = text(input.periodKey, 7)
  if (!PERIOD_KEY.test(periodKey) || periodKey < company.accountingStartMonth)
    return refuse('BENEFIT_PERIOD_NEEDED', '请选择本账本的实际所属月。')
  if (input.action === 'status') return benefitStatus(store, benefit, periodKey)
  if (input.action === 'history') {
    const contributions = store.workEventsByOperation(CONTRIBUTION)
    const origins = new Set(contributions.filter(e => belongsTo(e, benefit, periodKey)).map(e => stored<Contribution>(e).originId ?? e.id))
    const versions = contributions.filter(e => origins.has(stored<Contribution>(e).originId ?? e.id))
    const selected = store.workEventsByOperation(ENROLLMENT).filter(e => belongsTo(e, benefit, periodKey))
    return { accepted: true as const, benefit, periodKey, enrollmentHistory: selected.slice(0, 30),
      contributionHistory: versions.slice(0, 15).map(e => ({ periodKey: e.request.periodKey, revision: e.id, ...stored<Contribution>(e) })) }
  }
  if (input.action === 'enrollment') return proposeEnrollment(store, benefit, periodKey, input)
  if (input.action === 'contribution') return proposeContribution(store, benefit, periodKey, input)
  if (input.action === 'paid') return proposePaid(store, benefit, periodKey, input, now)
  if (input.action === 'move') return proposeMove(store, benefit, periodKey, input)
  return refuse('BENEFIT_ACTION_INVALID', '请选择要核对的社保或公积金事项。')
}

export function saveBenefit(store: BookStore, old: BenefitProposal, input: Record<string, unknown>, now: Date) {
  return store.transaction(() => {
    const latest = reviewBenefit(store, input, now)
    if (!('operation' in latest) || JSON.stringify(latest) !== JSON.stringify(old))
      return refuse('BENEFIT_CHANGED', '确认期间资料已更新，请重新核对。')
    const current = store.workEventsByOperation(old.operation).find(e => e.id === old.revision)
    const oldResult = current && current.result
    const compared = old.operation === CONTRIBUTION && current ? { ...current.result, originId: current.result.originId ?? current.id } : oldResult
    if (current && belongsTo(current, old.benefit, old.periodKey) && JSON.stringify(compared) === JSON.stringify(old.value))
      return { accepted: true as const, duplicate: true, periodKey: old.periodKey, revision: current.id }
    const revision = store.recordWork(old.operation, { benefit: old.benefit, periodKey: old.periodKey }, old.value, now)
    return { accepted: true as const, revision, periodKey: old.periodKey,
      nextAction: benefitStatus(store, old.benefit, old.periodKey).nextAction }
  })
}
