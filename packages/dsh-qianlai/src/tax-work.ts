import { createHash } from 'node:crypto'

import { formatCents, parseAmountToCents } from '@moneycome/fintax-core'

import { quarterFilingPrep } from './deadlines.js'
import type { LoadedPack } from './pack.js'
import { isCalendarDate, monthRange, PERIOD_KEY, refuse, todayInChina, type Refusal } from './period.js'
import { readStatements } from './reports.js'
import type { BookStore } from './store.js'

export const taxKinds = ['vat', 'income-prepayment', 'income-annual', 'payroll-withholding'] as const
type TaxKind = typeof taxKinds[number]
type Cadence = 'monthly' | 'quarterly' | 'yearly'
export const taxWorkEvent = 'local-work:tax'
const labels: Record<TaxKind, string> = {
  vat: '增值税', 'income-prepayment': '企业所得税预缴',
  'income-annual': '年度企业所得税', 'payroll-withholding': '工资个人所得税',
}
const cycleWords: Record<Cadence, RegExp> = { monthly: /月/, quarterly: /季/, yearly: /年/ }
const categoryWords: Record<TaxKind, RegExp> = {
  vat: /增值税/, 'income-prepayment': /企业所得税/,
  'income-annual': /企业所得税/, 'payroll-withholding': /个人所得税/,
}

function scopeFor(periodKey: string) {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(periodKey)
  if (quarter) {
    const start = (Number(quarter[2]) - 1) * 3 + 1
    return { cadence: 'quarterly' as const, months: Array.from({ length: 3 }, (_, index) =>
      quarter[1] + '-' + String(start + index).padStart(2, '0')) }
  }
  if (PERIOD_KEY.test(periodKey)) return { cadence: 'monthly' as const, months: [periodKey] }
  if (/^\d{4}$/.test(periodKey)) return { cadence: 'yearly' as const, months: Array.from({ length: 12 }, (_, index) =>
    periodKey + '-' + String(index + 1).padStart(2, '0')) }
  return undefined
}

function registeredCadences(store: BookStore, kind: TaxKind, from: string, to: string) {
  const company = store.company()
  const record = store.companyOnboarding()
  const profile = record?.completedAt && record.enterprise?.taxId === company?.taxId ? record.enterprise?.officialTax : undefined
  if (!profile) return []
  return Object.entries(cycleWords).flatMap(([cadence, pattern]) => profile.obligations.some(item =>
    (kind === 'income-annual' ? cadence === 'yearly' : cadence !== 'yearly')
      && categoryWords[kind].test(item.taxItem) && !!item.filingCycle && pattern.test(item.filingCycle)
      && (!item.effectiveFrom || item.effectiveFrom <= to) && (!item.effectiveTo || item.effectiveTo >= from),
  ) ? [cadence as Cadence] : [])
}

type EvidenceKind = 'tax-form' | 'filing-receipt' | 'payment-receipt'
const evidenceKinds = ['tax-form', 'filing-receipt', 'payment-receipt'] as const

type TaxWorkResult = { accepted: true; [field: string]: unknown } | Refusal

export function taxWork(store: BookStore, pack: LoadedPack, args: Record<string, unknown>, now: Date, confirm = false): TaxWorkResult {
  const company = store.company()
  if (!company || company.isSample) return refuse('TAX_BOOK_REQUIRED', '请先确认要办理的企业账本。')
  const { action, kind, periodKey } = args
  if (!taxKinds.includes(kind as TaxKind) || typeof periodKey !== 'string')
    return refuse('TAX_SCOPE_REQUIRED', '请先在卡片里核对税种和期间。')
  const taxKind = kind as TaxKind
  const scope = scopeFor(periodKey)
  if (!scope || (taxKind === 'income-annual' ? scope.cadence !== 'yearly' : scope.cadence === 'yearly')
      || (taxKind === 'payroll-withholding' && scope.cadence !== 'monthly'))
    return refuse('TAX_PERIOD_MISMATCH', '请重新选择此税种对应的月、季度或完整年度。')

  const first = scope.months[0]!
  const last = scope.months.at(-1)!
  const from = monthRange(first).from
  const to = monthRange(last).to
  const today = todayInChina(now)
  const cadences = registeredCadences(store, taxKind, from, to)
  if (cadences.length === 1 && cadences[0] !== scope.cadence)
    return refuse('TAX_CADENCE_MISMATCH', '这个期间和已登记的申报周期不符，请按登记周期办理。', { cadences })

  const events = store.workEventsByOperation(taxWorkEvent).filter(event =>
    event.request.kind === taxKind && event.request.periodKey === periodKey)
  const evidence = events.filter(event => event.request.action === 'attach').map(event => event.result.evidence)
  const hasReceipt = (category: EvidenceKind) => evidence.some(item => (item as { category?: unknown })?.category === category)
  const reviewed = events.filter(event => event.request.action === 'review')
  const closed = new Set(store.lockedPeriods())
  const payrollPayments = taxKind === 'payroll-withholding'
    ? store.workEventsByOperation('local-work:payroll-payment').filter(event =>
      typeof event.result.paidOn === 'string' && event.result.paidOn.slice(0, 7) === periodKey) : []
  const coverage = scope.months.map(month => {
    if (month < company.accountingStartMonth) return { month, status: 'before-book' as const }
    if (monthRange(month).to >= today) return { month, status: 'not-ended' as const }
    return { month, status: closed.has(month) ? 'closed' as const : 'unclosed' as const }
  })
  const monthly = coverage.flatMap(({ month, status }) => {
    if (status !== 'closed' && status !== 'unclosed') return []
    const report = readStatements(store, pack, month)
    return report.accepted ? [{ month, totals: report.profit?.month.totals ?? null,
      // Retain a version comparison of all visible lines without collecting private raw documents.
      fingerprint: createHash('sha256').update(JSON.stringify(report)).digest('hex') }] : []
  })
  const quarter = taxKind === 'vat' && scope.cadence === 'quarterly' && !coverage.some(c => c.status === 'not-ended')
    ? quarterFilingPrep(store, pack, periodKey, now) : undefined
  const missing: string[] = []
  if (cadences.length !== 1 && taxKind !== 'payroll-withholding') missing.push('核对税务登记上的申报周期')
  const missingMonths = coverage.filter(month => month.status !== 'closed').map(month => month.month)
  if (missingMonths.length) missing.push('核对 ' + missingMonths.join('、') + ' 的账务资料')
  if (taxKind === 'payroll-withholding' && !hasReceipt('tax-form'))
    missing.push('提供实际发放月的工资代扣资料或待申报税表')
  if (!hasReceipt('tax-form') && taxKind !== 'payroll-withholding') missing.push('上传待核对税表')
  const fingerprint = createHash('sha256').update(JSON.stringify({ company, taxKind, periodKey, coverage, monthly, quarter, evidence, payrollPayments })).digest('hex')
  const current = reviewed[0]?.result
  const filingStatus = hasReceipt('filing-receipt') ? 'verification-required' as const : 'unverified' as const
  const paymentStatus = hasReceipt('payment-receipt') ? 'verification-required' as const : 'unverified' as const
  const nextAction = filingStatus === 'verification-required' ? '核对同一企业、税种和期间的原申报结果'
    : paymentStatus === 'verification-required' ? '核对同一企业、税种和期间的原缴款结果'
    : missing[0] ?? (current?.fingerprint === fingerprint ? '可查看已核对的本地资料' : '核对本期税务准备资料')
  const view = { accepted: true as const, company: company.name, taxKind, title: labels[taxKind], periodKey,
    cadence: scope.cadence, from, to, coverage, monthly, ...(quarter?.accepted ? { quarter } : {}),
    filingStatus, paymentStatus, evidence, missing, fingerprint, nextAction, payrollPaymentRecordCount: payrollPayments.length,
    reviewStatus: current === undefined ? 'pending' as const : current.fingerprint === fingerprint ? 'reviewed' as const : 'needs-review' as const,
    versions: reviewed.map(event => ({ id: event.id, ...event.result })),
    guidance: '这些是本地准备资料。申报与缴款分开核对，上传材料不能确认为官方成功。',
  }

  if (action === 'status' || action === 'prepare') return view
  if (action === 'attach') {
    if (typeof args.sourceCompany !== 'string' || args.sourceCompany.normalize('NFKC').replace(/\s/g, '') !== company.name.normalize('NFKC').replace(/\s/g, ''))
      return refuse('TAX_COMPANY_MISMATCH', '材料抬头与当前公司不符，请核对原件。')
    if (!evidenceKinds.includes(args.evidenceKind as EvidenceKind) || typeof args.materialId !== 'number')
      return refuse('TAX_SOURCE_INVALID', '请添加当前税种和期间的原始资料。')
    if (args.sourcePeriod !== periodKey || args.sourceTaxKind !== taxKind)
      return refuse('TAX_SOURCE_PERIOD_MISMATCH', '材料的实际税种或期间与当前事项不一致，请按原件归类。')
    const material = store.workMaterial(args.materialId)
    if (!material || material.status !== 'read') return refuse('TAX_SOURCE_UNREADABLE', '原件还未成功读取，请重新上传。')
    if (args.evidenceDate !== undefined && (typeof args.evidenceDate !== 'string' || !isCalendarDate(args.evidenceDate) || args.evidenceDate > today))
      return refuse('TAX_EVIDENCE_DATE_INVALID', '请核对资料上的实际日期。')
    if (args.evidenceAmount !== undefined && typeof args.evidenceAmount !== 'string')
      return refuse('TAX_EVIDENCE_AMOUNT_INVALID', '请核对资料上的金额。')
    const amount = typeof args.evidenceAmount === 'string' ? parseAmountToCents(args.evidenceAmount) : undefined
    if (typeof args.evidenceAmount === 'string' && (amount === undefined || amount < 0n))
      return refuse('TAX_EVIDENCE_AMOUNT_INVALID', '请核对资料上的金额。')
    const used = store.workEventsByOperation(taxWorkEvent).find(event => event.request.materialId === material.id)
    if (used && (used.request.periodKey !== periodKey || used.request.kind !== taxKind || used.request.evidenceKind !== args.evidenceKind))
      return refuse('TAX_SOURCE_ALREADY_ASSOCIATED', '该原件已关联到另一项税务资料，请先核对归属。')
    if (!used) store.recordWork(taxWorkEvent, { action, kind, periodKey, evidenceKind: args.evidenceKind, materialId: material.id }, {
      evidence: { id: material.id, name: material.name, category: args.evidenceKind, date: args.evidenceDate,
        ...(amount !== undefined ? { amount: formatCents(amount) } : {}) },
    }, now)
    return { ...taxWorkStatus(store, pack, args, now), alreadyAttached: !!used }
  }
  if (action !== 'review') return refuse('TAX_ACTION_INVALID', '请先查看当前税务准备资料。')
  if (filingStatus === 'verification-required' || paymentStatus === 'verification-required')
    return refuse('TAX_ORIGINAL_QUERY_REQUIRED', nextAction)
  if (missing.length) return refuse('TAX_DETAILS_MISSING', nextAction, { missing })
  if (typeof args.fingerprint !== 'string' || args.fingerprint !== fingerprint)
    return refuse('TAX_DRAFT_CHANGED', '准备资料已有更新，请按最新版本核对。')
  if (current?.fingerprint === fingerprint) return { ...view, alreadyReviewed: true }
  if (!confirm) return view
  store.recordWork(taxWorkEvent, { action, kind, periodKey }, { fingerprint, coverage, monthly, evidence, version: reviewed.length + 1 }, now)
  return taxWorkStatus(store, pack, args, now)
}

function taxWorkStatus(store: BookStore, pack: LoadedPack, args: Record<string, unknown>, now: Date) {
  return taxWork(store, pack, { ...args, action: 'status' }, now)
}
