import { createHash } from 'node:crypto'

import { formatCents, parseAmountToCents } from '@moneycome/fintax-core'

import { isCalendarDate, refuse, todayInChina } from './period.js'
import type { BookStore } from './store.js'

const operation = 'local-work:receipt-match'

export function receiptMatch(store: BookStore, args: Record<string, unknown>, now: Date, confirmed = false) {
  const company = store.company()
  if (!company || company.isSample) return refuse('RECEIPT_BOOK_REQUIRED', '请先核对当前企业账本。')
  const matter = typeof args.matterId === 'number' ? store.workMatter(args.matterId) : undefined
  if (!matter) return refuse('WORK_MATTER_NOT_FOUND', '请在同一企业的待办里打开这笔业务。')
  const events = store.workEventsByOperation(operation)
  const group = events.filter(event => event.request.matterId === matter.id)
  const invoiceNumber = typeof args.invoiceNumber === 'string' ? args.invoiceNumber : group[0]?.result.invoiceNumber
  const invoice = typeof invoiceNumber === 'string' ? store.invoice(invoiceNumber) : undefined
  if (!invoice || invoice.direction !== 'output' || !invoice.totalCents || invoice.totalCents < 0n)
    return refuse('RECEIPT_INVOICE_REQUIRED', '请先核对属于本企业、含总金额的销售发票。')
  if (group.some(event => event.result.invoiceNumber !== invoiceNumber)
      || events.some(event => event.request.matterId !== matter.id && event.result.invoiceNumber === invoiceNumber))
    return refuse('RECEIPT_MATTER_MISMATCH', '这张发票已有对应业务，请在原事项继续。')
  const lines = group.map(event => event.result)
  const totalBefore = lines.reduce((sum, line) => sum + (parseAmountToCents(String(line.amount)) ?? 0n), 0n)
  const view = (total: bigint) => ({
    accepted: true as const, company: company.name, matterId: matter.id, title: matter.title, invoiceNumber,
    contractTotal: formatCents(invoice.totalCents!), recordedReceipts: lines, amountMatched: formatCents(total),
    remaining: formatCents(invoice.totalCents! - total),
    voucherNo: matter.voucherNo ?? invoice.voucherNo ?? null,
    nextAction: matter.voucherNo || invoice.voucherNo ? '查看原凭证并核对关联到账记录'
      : total < invoice.totalCents! ? '核对尚未匹配的收款资料' : '核对收款去向和实际记账方式',
  })
  if (args.action === 'status') return view(totalBefore)

  const materialId = typeof args.materialId === 'number' ? args.materialId : undefined
  const material = materialId === undefined ? undefined : store.workMaterial(materialId)
  if (material?.status !== 'read')
    return refuse('RECEIPT_MATERIAL_REQUIRED', '请添加能看出日期、金额和收款方的原件。')
  const paidOn = typeof args.paidOn === 'string' ? args.paidOn : ''
  if (!isCalendarDate(paidOn) || paidOn > todayInChina(now)) return refuse('RECEIPT_DATE_INVALID', '请核对实际到账日期。')
  const amount = typeof args.amount === 'string' ? parseAmountToCents(args.amount) : undefined
  if (amount === undefined || amount <= 0n) return refuse('RECEIPT_AMOUNT_INVALID', '请核对这笔实际收款金额。')
  const reference = typeof args.reference === 'string' ? args.reference.normalize('NFKC').trim() : ''
  const receiver = typeof args.receiver === 'string' ? args.receiver.trim() : ''
  const destination = args.destination
  if (!reference || reference.length > 100 || !receiver || receiver.length > 80
      || !['personal-held', 'company-bank', 'unknown'].includes(String(destination)))
    return refuse('RECEIPT_FACT_REQUIRED', '请先核对收款凭据号和收款去向。')
  const lineId = typeof args.statementLineId === 'number' ? args.statementLineId : undefined
  if (destination === 'company-bank') {
    const line = lineId === undefined ? undefined : store.statementLines({ ids: [lineId] })[0]
    if (!line || line.signedCents !== amount || line.occurredOn !== paidOn)
      return refuse('RECEIPT_BANK_EVIDENCE_REQUIRED', '资金已进公司账户时，请匹配同日同金额的公司流水。')
  }
  const duplicate = events.find(event => event.result.reference === reference || (lineId !== undefined && event.result.statementLineId === lineId))
  const candidate = { invoiceNumber, paidOn, amount: formatCents(amount), receiver, destination, reference,
    materialId: material.id, ...(lineId !== undefined ? { statementLineId: lineId } : {}) }
  if (duplicate) {
    if (duplicate.request.matterId === matter.id && JSON.stringify(duplicate.result) === JSON.stringify(candidate))
      return { ...view(totalBefore), alreadyMatched: true }
    return refuse('RECEIPT_SOURCE_ALREADY_MATCHED', '此收款记录已关联，请先核对原事项。')
  }
  if (totalBefore + amount > invoice.totalCents) return refuse('RECEIPT_AMOUNT_EXCEEDS', '累计收款超过该业务总金额，请核对付款记录。')
  const token = createHash('sha256').update(JSON.stringify([company, matter.id, matter.revision, group[0]?.id, candidate])).digest('hex')
  if (args.action === 'preview') return { ...view(totalBefore + amount), candidate, token }
  if (args.action !== 'save' || args.token !== token || !confirmed)
    return refuse('RECEIPT_CONFIRMATION_REQUIRED', '收款资料待核对，请先打开当前确认。')
  store.recordWork(operation, { matterId: matter.id }, candidate, now)
  return { ...view(totalBefore + amount), recordedReceipts: [candidate, ...lines], matched: true, affectsLedger: false }
}
