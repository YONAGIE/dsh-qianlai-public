import {
  formatCents,
  parseAmountToCents,
  resolveInvoiceReadability,
  resolveInvoiceSubjectDirection,
  runInvoiceSelfChecks,
  type InvoiceExtractedFacts,
  type InvoiceField,
} from '@moneycome/fintax-core'

import { refuse } from './period.js'
import type { BookStore } from './store.js'

/** 模型从票面读出来的要素。读不出的写进 `unreadable`，票上本来没有的不写。金额用元，如 `1287.13`。 */
export interface InvoiceReading {
  readonly invoiceNumber?: string
  readonly issueDate?: string
  readonly sellerName?: string
  readonly sellerTaxId?: string
  readonly buyerName?: string
  readonly buyerTaxId?: string
  readonly amountExclTax?: string
  readonly taxAmount?: string
  readonly totalInclTax?: string
  readonly totalInWords?: string
  /** 税率，如 `1%` 或 `0.01`。 */
  readonly taxRate?: string
  readonly lineItems?: readonly string[]
  readonly unreadable?: readonly string[]
}

type Key = keyof InvoiceExtractedFacts

const READING_KEYS: Partial<Record<Key, keyof InvoiceReading>> = {
  amountExclTaxCents: 'amountExclTax', taxAmountCents: 'taxAmount', totalInclTaxCents: 'totalInclTax',
}

function field<T>(reading: InvoiceReading, key: Key, value: T | undefined): InvoiceField<T> {
  if (reading.unreadable?.some(name => name === key || name === (READING_KEYS[key] ?? key))) return { state: 'unreadable' }
  return value === undefined ? { state: 'absent' } : { state: 'present', value }
}

/** 要换算的字段：填了字但换算不出来的算读不清，不当票上没有。 */
function parsedField(reading: InvoiceReading, key: Key, text: string | undefined, parse: (t: string) => number | undefined) {
  if (text === undefined || text.trim() === '') return field<number>(reading, key, undefined)
  const value = parse(text)
  return value === undefined ? ({ state: 'unreadable' } as const) : field(reading, key, value)
}

const MAX_EXACT_CENTS = BigInt(Number.MAX_SAFE_INTEGER)
const parsedCents = (text: string) => parseAmountToCents(text.replace(/[¥￥,\s]/g, ''))
const exactCents = (value: bigint) => value >= -MAX_EXACT_CENTS && value <= MAX_EXACT_CENTS
function cents(text: string): number | undefined {
  const value = parsedCents(text)
  return value === undefined || !exactCents(value) ? undefined : Number(value)
}

export function parseInvoiceTaxRate(text: string): number | undefined {
  const trimmed = text.trim()
  if (!trimmed.replace(/%$/, '').trim()) return undefined
  const value = trimmed.endsWith('%') ? Number(trimmed.slice(0, -1)) / 100 : Number(trimmed)
  // 税率在 0 到 1 之间；写成 13 这种没带百分号的，不替它猜。
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}

function toFacts(reading: InvoiceReading): InvoiceExtractedFacts {
  return {
    invoiceNumber: field(reading, 'invoiceNumber', reading.invoiceNumber),
    issueDate: field(reading, 'issueDate', reading.issueDate),
    sellerName: field(reading, 'sellerName', reading.sellerName),
    sellerTaxId: field(reading, 'sellerTaxId', reading.sellerTaxId),
    buyerName: field(reading, 'buyerName', reading.buyerName),
    buyerTaxId: field(reading, 'buyerTaxId', reading.buyerTaxId),
    amountExclTaxCents: parsedField(reading, 'amountExclTaxCents', reading.amountExclTax, cents),
    taxAmountCents: parsedField(reading, 'taxAmountCents', reading.taxAmount, cents),
    totalInclTaxCents: parsedField(reading, 'totalInclTaxCents', reading.totalInclTax, cents),
    totalInWords: field(reading, 'totalInWords', reading.totalInWords),
    taxRate: parsedField(reading, 'taxRate', reading.taxRate, parseInvoiceTaxRate),
    lineItems: field(reading, 'lineItems', reading.lineItems),
  }
}

/** 核票只看票面自洽，查不到税务局有没有这张票；验真要老板自己去查验平台。 */
export const AUTHENTICITY_NOTE =
  '票面自洽不等于真票：这里没有去税务局查这张票有没有开过、作没作废。重要的票请到国家税务总局全国增值税发票查验平台 https://inv-veri.chinatax.gov.cn 核一下。'

const DIRECTION_HINT: Record<string, string> = {
  input: '咱们是买方：这是一笔花出去的钱（买东西或服务）。',
  output: '咱们是卖方：这是一笔收入。',
}

/**
 * 核一张票：票面自洽（价税合计、大小写、税率、号码位数），认清咱们是买方还是卖方，查有没有记过。
 * 核过的票记进账本，记账时用发票号码挂上去。
 */
export function checkInvoice(store: BookStore, reading: InvoiceReading, now: Date) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  if (company.isSample)
    return refuse('SAMPLE_BOOK', '现在是样本账。老板要记自己公司的票，先用 moneycome_open_book 开账。')
  const outOfRange = Object.entries(READING_KEYS).flatMap(([internal, external]) => {
    if (reading.unreadable?.some(key => key === internal || key === external)) return []
    const text = reading[external]
    const value = typeof text === 'string' ? parsedCents(text) : undefined
    return value !== undefined && !exactCents(value) ? [external] : []
  })
  if (outOfRange.length)
    return refuse('INVOICE_AMOUNT_OUT_OF_RANGE', '票面金额超过当前核票引擎可精确处理的范围，本次没有保存发票或记账。请交会计人工核对，不要修改或舍入原金额。', { fields: outOfRange })
  const facts = toFacts(reading)
  const readability = resolveInvoiceReadability(facts)
  const checks = runInvoiceSelfChecks(facts, 'invoice')
  const direction = resolveInvoiceSubjectDirection(facts, {
    subjectName: company.name,
    ...(company.taxId ? { subjectTaxId: company.taxId } : {}),
  })
  const failed = checks.filter((c) => c.status === 'failed')
  const existing = reading.invoiceNumber ? store.invoice(reading.invoiceNumber) : undefined
  const recordable =
    readability !== 'unreadable' && failed.length === 0 && (direction.direction === 'input' || direction.direction === 'output')
  if (recordable && reading.invoiceNumber && !existing?.voucherNo) {
    const total = facts.totalInclTaxCents.state === 'present' ? BigInt(facts.totalInclTaxCents.value!) : null
    store.saveInvoice({
      invoiceNumber: reading.invoiceNumber,
      issueDate: reading.issueDate ?? null,
      direction: direction.direction,
      counterparty: (direction.direction === 'input' ? reading.sellerName : reading.buyerName) ?? null,
      totalCents: total,
      // Keep uncertain candidates out of the verified invoice facts used later
      // by posting. A readable total does not make unreadable net/tax certain.
      facts: {
        ...reading,
        amountExclTax: facts.amountExclTaxCents.state === 'present' ? reading.amountExclTax : undefined,
        taxAmount: facts.taxAmountCents.state === 'present' ? reading.taxAmount : undefined,
        totalInclTax: facts.totalInclTaxCents.state === 'present' ? reading.totalInclTax : undefined,
      },
      now,
    })
  }
  const amount = (f: InvoiceField<number>) => (f.state === 'present' ? formatCents(BigInt(f.value!)) : undefined)
  return {
    accepted: true as const,
    recordable,
    readability,
    direction: direction.direction,
    directionText: DIRECTION_HINT[direction.direction] ?? direction.plainText ?? null,
    problems: [...failed, ...checks.filter((c) => c.status === 'insufficient')].map((c) => ({
      check: c.check,
      status: c.status,
      text: c.plainText ?? null,
    })),
    ...(existing?.voucherNo ? { alreadyRecorded: existing.voucherNo } : {}),
    authenticity: AUTHENTICITY_NOTE,
    amounts: {
      invoice_total: amount(facts.totalInclTaxCents) ?? null,
      invoice_net: amount(facts.amountExclTaxCents) ?? null,
      invoice_tax: amount(facts.taxAmountCents) ?? null,
    },
  }
}
