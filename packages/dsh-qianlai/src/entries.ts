import { randomUUID } from 'node:crypto'

import {
  formatCents,
  isSkipRule,
  VOID_REASON_MAX_LENGTH,
  VOID_REASON_MIN_LENGTH,
  LedgerPostingError,
  matchRule,
  parseAmountToCents,
  postParsedEvent,
  type AccountingPackPayload,
  type LedgerPosting,
} from '@moneycome/fintax-core'

import type { LoadedPack } from './pack.js'
import { isCalendarDate, refuse, todayInChina, type Refusal } from './period.js'
import type { BookStore, InvoiceRecord, StatementLine } from './store.js'

const EVENT_KIND = 'event.kind'

/** 包里参数表的一项；没声明时为 undefined。 */
export function packParameter(pack: AccountingPackPayload, parameterId: string): string | undefined {
  return pack.parameters.find((p) => p.parameterId === parameterId)?.value
}

function kindName(pack: AccountingPackPayload, eventKind: string): string | undefined {
  return (
    pack.evidenceRequirements.find((e) => e.eventKind === eventKind)?.eventKindName ??
    pack.closingItems.find((c) => c.itemId === eventKind)?.itemName
  )
}

/**
 * 记账说明：不带 `eventKind` 时列出会计包认得的全部业务种类；带上时列出这类业务要说清哪几件事、
 * 每件事可选哪些值、要给哪些金额、要哪些凭据。全部从会计包的规则表推出来，不另写一份。
 */
export function postingGuide(pack: AccountingPackPayload, eventKind?: string) {
  const rules = pack.decisionTables.flatMap((t) => t.rules)
  const kindOf = (rule: (typeof rules)[number]) => rule.when.find((w) => w.factKey === EVENT_KIND)?.equals
  if (!eventKind) {
    const kinds = [...new Set(rules.map(kindOf).filter((k): k is string => k !== undefined))]
    return {
      accepted: true as const,
      eventKinds: kinds.map((k) => ({ eventKind: k, name: kindName(pack, k) ?? null })),
    }
  }
  const matched = rules.filter((r) => kindOf(r) === eventKind)
  if (matched.length === 0)
    return refuse('UNKNOWN_EVENT_KIND', `会计包里没有 ${eventKind} 这类业务。不带 eventKind 再查一次看全部种类。`)
  const facts: Record<string, string[]> = {}
  const amounts = new Set<string>()
  const variants = matched.map((rule) => {
    const when = Object.fromEntries(rule.when.filter((w) => w.factKey !== EVENT_KIND).map((w) => [w.factKey, w.equals]))
    for (const [key, value] of Object.entries(when)) facts[key] = [...new Set([...(facts[key] ?? []), value])]
    const legs = isSkipRule(rule) ? [] : rule.legs
    for (const leg of legs) amounts.add(leg.amountSource)
    const recognition = isSkipRule(rule) ? undefined : rule.recognitionPeriodFactKey
    return {
      when,
      amountSources: [...new Set(legs.map((l) => l.amountSource))],
      ...(recognition ? { periodFactKey: recognition } : {}),
      ...('treatment' in rule && rule.treatment ? { treatment: rule.treatment } : {}),
      ...(!isSkipRule(rule) && rule.referencedBalance ? { supported: false } : {}),
    }
  })
  return {
    accepted: true as const,
    eventKind,
    name: kindName(pack, eventKind) ?? null,
    facts,
    amountSources: [...amounts],
    evidenceRoles: pack.evidenceRequirements.find((e) => e.eventKind === eventKind)?.requiredRoles ?? [],
    variants,
  }
}

export interface RecordEntryInput {
  readonly date: string
  readonly summary: string
  readonly eventKind: string
  readonly facts: Readonly<Record<string, string>>
  readonly amounts: Readonly<Record<string, string>>
  /** 老板说手上有的凭据种类，如 contract、payroll_sheet。发票和流水由下面两项自动算进来。 */
  readonly evidenceRoles?: readonly string[]
  readonly invoiceNumber?: string
  readonly statementLineIds?: readonly number[]
  /** 只推分录给老板看，不落账。 */
  readonly preview?: boolean
  /** 这一笔是哪张已结账凭证的更正：那张要先用冲销凭证冲掉。 */
  readonly correctsVoucherNo?: string
}

/** 冲销凭证的业务种类。它不来自会计包：分录是原凭证逐行反向，不经记账规则。 */
export const REVERSAL_KIND = 'correction.reversal'

const POSTING_MESSAGES: Record<string, string> = {
  LEDGER_NO_RULE_MATCHED: '会计包里没有和这几件事对得上的记法。先用 moneycome_posting_guide 查这类业务要说清哪几件事、可选哪些值。',
  LEDGER_AMBIGUOUS_RULE: '这几件事没说全，能对上不止一种记法。先用 moneycome_posting_guide 查还差哪件事。',
  LEDGER_RULE_SKIPS_EVENT: '会计包对这种情况的处理是这一笔不记账。',
  LEDGER_AMOUNT_SOURCE_MISSING: '缺一个金额，见 details.amountSource。',
  LEDGER_AMOUNT_INVALID: '金额要写成不带逗号、最多两位小数的非负数，如 1280.00。',
  LEDGER_RECOGNITION_PERIOD_MISMATCH: '这类业务要在 facts 里写明所属月份（YYYY-MM），并且要和记账日期所在的月份一致。',
  LEDGER_REFERENCED_BALANCE_REQUIRED: '这类业务要引用以前某一笔账的余额，体验版还不支持。',
  LEDGER_UNKNOWN_SUBJECT: '会计包的记账规则引用了目录里没有的科目，这是会计包的问题，这一笔先不记。',
  LEDGER_UNBALANCED: '按会计包推出来的分录借贷不平，这是会计包的问题，这一笔先不记。',
}

const legView = (legs: readonly { direction: 'debit' | 'credit'; subjectCode: string; subjectName: string; amount: string }[]) =>
  legs
    .filter((l) => l.amount !== '0.00')
    .map((l) => ({ side: l.direction === 'debit' ? '借' : '贷', subjectCode: l.subjectCode, subjectName: l.subjectName, amount: l.amount }))

/**
 * 记一笔账。业务事实交给会计包的规则推分录，插件不自己判科目。
 *
 * 落账前依次挡：样本账、日期、已结账的月份、包里没有的记法、发票没核过或已记过或金额和票面不符、
 * 流水已记过或不在这个月或金额对不上。
 */
export function recordEntry(store: BookStore, pack: LoadedPack, input: RecordEntryInput, now: Date) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  if (company.isSample)
    return refuse('SAMPLE_BOOK', '现在是样本账，不能往里记。老板要记自己公司的账，先用 moneycome_open_book 开账。')
  if (!isCalendarDate(input.date)) return refuse('DATE_INVALID', `日期要写成 YYYY-MM-DD，收到的是 ${input.date}。`)
  if (input.date > todayInChina(now)) return refuse('DATE_IN_FUTURE', `${input.date} 还没到，不能先记。`)
  const periodKey = input.date.slice(0, 7)
  if (periodKey < company.accountingStartMonth)
    return refuse('PERIOD_BEFORE_BOOK', `这本账从 ${company.accountingStartMonth} 开始记，${input.date} 在建账之前。`)
  if (store.lockedPeriods().includes(periodKey))
    return refuse('PERIOD_LOCKED', `${periodKey} 已经结账，不能再往里记。`)

  const automatic = [...new Set(input.evidenceRoles ?? [])].filter((role) => AUTOMATIC_ROLES.has(role))
  if (automatic.length)
    return refuse(
      'ROLE_AUTOMATIC',
      '发票和流水不能手填为凭据：发票要先核对并带 invoiceNumber，流水要带 statementLineIds 或用 moneycome_link_statement 关联。',
      { roles: automatic },
    )
  const reserved = Object.keys(input.facts).filter(key => key.startsWith('correction.'))
  if (reserved.length)
    return refuse('FACT_RESERVED', 'correction.* 是系统更正关系，不能作为普通业务事实填写。请使用冲销工具或 correctsVoucherNo。', { facts: reserved })

  const facts = { ...input.facts, [EVENT_KIND]: input.eventKind }
  const event = { eventId: `entry-${randomUUID()}`, facts, amounts: input.amounts, periodKey }
  let rule: ReturnType<typeof matchRule>
  let posting: LedgerPosting
  try {
    rule = matchRule(pack.payload, event)
    if (!isSkipRule(rule) && rule.referencedBalance)
      return refuse('NOT_SUPPORTED', POSTING_MESSAGES.LEDGER_REFERENCED_BALANCE_REQUIRED!, { ruleId: rule.ruleId })
    posting = postParsedEvent(pack.payload, pack.packRef, event)
  } catch (error) {
    if (!(error instanceof LedgerPostingError)) throw error
    return refuse(error.code, POSTING_MESSAGES[error.code] ?? error.message, error.details)
  }

  const evidence = new Set(input.evidenceRoles ?? [])
  let corrected: string | undefined
  if (input.correctsVoucherNo !== undefined) {
    const [original] = store.vouchers({ voucherNo: input.correctsVoucherNo })
    if (!original) return refuse('VOUCHER_NOT_FOUND', `没有凭证 ${input.correctsVoucherNo}。`)
    const reversalNo = store.voucherLinkedTo('correction.reverses', original.voucherNo)
    const reversal = reversalNo ? store.vouchers({ voucherNo: reversalNo })[0] : undefined
    if (!reversal || reversal.voided || reversal.eventKind !== REVERSAL_KIND)
      return refuse('NOT_REVERSED', `${original.voucherNo} 还没冲销。先用 moneycome_reverse_voucher 冲掉它，再记更正后的这一笔。`)
    const reversalPeriod = reversal.voucherDate.slice(0, 7)
    if (periodKey < reversalPeriod)
      return refuse('CORRECTION_BEFORE_REVERSAL', `更正凭证不能记到冲销之前的月份。${reversal.voucherNo} 在 ${reversalPeriod}，更正要记在该月或以后尚未结账的月份。`, {
        reversalVoucherNo: reversal.voucherNo, reversalPeriod, correctionPeriod: periodKey,
      })
    const existing = store.voucherLinkedTo('correction.of', original.voucherNo)
    if (existing) return refuse('ALREADY_CORRECTED', `${original.voucherNo} 已经有更正凭证 ${existing} 了。`)
    // 原凭证上的凭据（发票、合同、回单）仍然有效，更正后的这一笔照样算有。
    for (const role of original.evidenceRoles) evidence.add(role)
    corrected = original.voucherNo
  }
  if (input.invoiceNumber !== undefined) {
    const invoice = store.invoice(input.invoiceNumber)
    if (!invoice)
      return refuse('INVOICE_NOT_CHECKED', `发票 ${input.invoiceNumber} 还没核对过，先用 moneycome_check_invoice 核一遍。`)
    if (invoice.voucherNo && invoice.voucherNo !== corrected)
      return refuse('INVOICE_ALREADY_RECORDED', `发票 ${input.invoiceNumber} 已经记在 ${invoice.voucherNo} 里了，同一张票不能记两次。`)
    const differs = invoiceAmountMismatch(invoice, input.amounts)
    if (differs) return differs
    evidence.add('invoice')
  }

  const lineIds = [...new Set(input.statementLineIds ?? [])]
  if (lineIds.length > 0) {
    const lines = store.statementLines({ ids: lineIds })
    const missing = lineIds.filter((id) => !lines.some((l) => l.id === id))
    if (missing.length) return refuse('STATEMENT_LINE_NOT_FOUND', `没有这些流水行：${missing.join('、')}。`)
    const taken = lines.filter((l) => l.voucherNo)
    if (taken.length)
      return refuse(
        'STATEMENT_LINE_ALREADY_RECORDED',
        `这些流水已经记过了：${taken.map((l) => `${l.id}（${l.voucherNo}）`).join('、')}。`,
      )
    const elsewhere = otherPeriodLines(lines, periodKey)
    if (elsewhere) return elsewhere
    const mismatch = statementMismatch(pack.payload, posting, lines)
    if (mismatch) return mismatch
    evidence.add('settlement')
  }

  const ruleRoles = 'evidenceRoles' in rule ? (rule.evidenceRoles as readonly string[] | undefined) : undefined
  const requiredRoles =
    ruleRoles ?? pack.payload.evidenceRequirements.find((e) => e.eventKind === input.eventKind)?.requiredRoles ?? []
  const view = {
    periodKey,
    legs: legView(posting.legs),
    ...('treatment' in rule && rule.treatment ? { treatment: rule.treatment } : {}),
    ...('requiresTask' in rule && rule.requiresTask ? { followUp: rule.requiresTask.title } : {}),
    missingEvidence: requiredRoles.filter((r) => !evidence.has(r)),
  }
  if (input.preview) return { accepted: true as const, preview: true, ...view }

  const voucher = store.transaction(() => {
    const saved = store.postVoucher({
      periodKey,
      voucherDate: input.date,
      summary: input.summary,
      eventKind: input.eventKind,
      facts: corrected ? { ...facts, 'correction.of': corrected } : facts,
      posting,
      requiredRoles,
      evidenceRoles: [...evidence],
      now,
    })
    // 更正时发票仍挂在原凭证上：那张票在结账的月份里记过，记录不改。
    if (input.invoiceNumber !== undefined && !corrected) store.attachInvoice(input.invoiceNumber, saved.id)
    for (const id of lineIds) store.attachStatementLine(id, saved.id)
    return saved
  })
  return { accepted: true as const, voucherNo: voucher.voucherNo, ...(corrected ? { correctsVoucherNo: corrected } : {}), ...view }
}

/**
 * 冲销一张已结账月份的凭证：在还没结账的月份里记一张逐行反向的凭证，金额相同、借贷对调。
 * 结了账的月份不动；冲销以后，再用 moneycome_record_entry 带 correctsVoucherNo 记对的那一笔。
 * 结账生成的结转凭证不能冲，同一张凭证不能冲两次。
 */
export function reverseVoucher(
  store: BookStore,
  pack: LoadedPack,
  transferKinds: readonly string[],
  input: { voucherNo: string; date: string; reason: string },
  now: Date,
) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  if (company.isSample) return refuse('SAMPLE_BOOK', '样本账不改。')
  const [original] = store.vouchers({ voucherNo: input.voucherNo })
  if (!original) return refuse('VOUCHER_NOT_FOUND', `没有凭证 ${input.voucherNo}。`)
  if (original.voided) return refuse('VOUCHER_VOIDED', `凭证 ${input.voucherNo} 已经作废了。`)
  const originalPeriod = original.voucherDate.slice(0, 7)
  const locked = store.lockedPeriods()
  if (!locked.includes(originalPeriod))
    return refuse('PERIOD_OPEN', `${originalPeriod} 还没结账，记错了直接用 moneycome_void_voucher 作废重记，不用冲销。`)
  if (transferKinds.includes(original.eventKind) || original.eventKind === REVERSAL_KIND)
    return refuse('NOT_REVERSIBLE', '结账生成的结转凭证和冲销凭证本身不能再冲销。')
  const existing = store.voucherLinkedTo('correction.reverses', original.voucherNo)
  if (existing) return refuse('ALREADY_REVERSED', `${original.voucherNo} 已经冲销过了，冲销凭证是 ${existing}。`)
  if (!isCalendarDate(input.date)) return refuse('DATE_INVALID', `日期要写成 YYYY-MM-DD，收到的是 ${input.date}。`)
  if (input.date > todayInChina(now)) return refuse('DATE_IN_FUTURE', `${input.date} 还没到。`)
  const periodKey = input.date.slice(0, 7)
  if (locked.includes(periodKey)) return refuse('PERIOD_LOCKED', `${periodKey} 已经结账，冲销凭证要记在还没结账的月份。`)
  if (periodKey < originalPeriod) return refuse('DATE_BEFORE_ORIGINAL', '冲销凭证的日期不能早于原凭证。')
  const reason = input.reason.trim()
  if (reason.length < VOID_REASON_MIN_LENGTH || reason.length > VOID_REASON_MAX_LENGTH)
    return refuse('REASON_REQUIRED', `冲销要写清原因，${VOID_REASON_MIN_LENGTH} 到 ${VOID_REASON_MAX_LENGTH} 个字。`)

  const posting: LedgerPosting = {
    eventId: `reverse-${original.voucherNo}-${randomUUID()}`,
    packRef: pack.packRef,
    ruleId: REVERSAL_KIND,
    legs: original.legs.map((l) => ({
      direction: l.direction === 'debit' ? 'credit' : 'debit',
      subjectCode: l.subjectCode,
      subjectName: l.subjectName,
      amount: formatCents(l.amountCents),
      amountSource: 'reversal',
    })),
  }
  const saved = store.transaction(() =>
    store.postVoucher({
      periodKey,
      voucherDate: input.date,
      summary: `冲销 ${original.voucherNo}：${reason}`,
      eventKind: REVERSAL_KIND,
      facts: { 'correction.reverses': original.voucherNo },
      posting,
      requiredRoles: [],
      evidenceRoles: [],
      now,
    }),
  )
  return {
    accepted: true as const,
    voucherNo: saved.voucherNo,
    reverses: original.voucherNo,
    legs: legView(posting.legs),
    next: `再用 moneycome_record_entry 带 correctsVoucherNo: "${original.voucherNo}" 记对的那一笔，日期也在 ${periodKey} 或以后没结账的月份。`,
  }
}

/** 记账时报的发票金额，要和核票时读到的票面金额一致。只比本次用到的那几项。 */
function invoiceAmountMismatch(invoice: InvoiceRecord, amounts: Readonly<Record<string, string>>): Refusal | undefined {
  const onInvoice: Record<string, unknown> = {
    invoice_total: invoice.facts.totalInclTax,
    invoice_net: invoice.facts.amountExclTax,
    invoice_tax: invoice.facts.taxAmount,
  }
  const differs = Object.entries(onInvoice).filter(([source, printed]) => {
    if (amounts[source] === undefined) return false
    if (typeof printed !== 'string') return true
    const a = parseAmountToCents(printed.replace(/[¥￥,\s]/g, ''))
    const b = parseAmountToCents(amounts[source].replace(/[¥￥,\s]/g, ''))
    return a === undefined || b === undefined || a !== b
  })
  if (differs.length === 0) return undefined
  return refuse(
    'INVOICE_AMOUNT_MISMATCH',
    `这笔账的金额和发票 ${invoice.invoiceNumber} 票面上的对不上。按票面金额记，或者先问清老板。`,
    Object.fromEntries(differs.map(([source, printed]) => [source, { invoice: printed, entry: amounts[source] }])),
  )
}

/** 流水上钱动的那天在哪个月，凭证就记在哪个月；不在同一个月的流水不能挂。 */
function otherPeriodLines(lines: readonly StatementLine[], periodKey: string): Refusal | undefined {
  const other = lines.filter((l) => l.occurredOn.slice(0, 7) !== periodKey)
  if (other.length === 0) return undefined
  return refuse(
    'STATEMENT_LINE_OTHER_PERIOD',
    `这些流水不在 ${periodKey}：${other.map((l) => `${l.id}（${l.occurredOn}）`).join('、')}。银行收付记在钱动的那个月，这笔要按流水日期另记。`,
  )
}

/**
 * 挂上流水的凭证，银行科目上的净额要等于这几行流水的合计。
 * 银行科目号来自会计包参数 `transaction.account.bank.subject`；包没声明就不比。
 */
function statementMismatch(
  pack: AccountingPackPayload,
  posting: LedgerPosting,
  lines: readonly { signedCents: bigint }[],
): Refusal | undefined {
  const bankSubject = packParameter(pack, 'transaction.account.bank.subject')
  if (!bankSubject) return undefined
  const bankNet = posting.legs
    .filter((l) => l.subjectCode === bankSubject)
    .reduce((sum, l) => {
      const [whole = '0', fraction = '00'] = l.amount.split('.')
      const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
      return sum + (l.direction === 'debit' ? cents : -cents)
    }, 0n)
  const statementNet = lines.reduce((sum, l) => sum + l.signedCents, 0n)
  if (bankNet === statementNet) return undefined
  return refuse('STATEMENT_AMOUNT_MISMATCH', '这笔账记到银行存款上的金额，和挂上的流水合计对不上。', {
    bankAmount: formatCents(bankNet),
    statementAmount: formatCents(statementNet),
  })
}

/** 把流水挂到一张已有的凭证上，用于先按发票记了账、后来流水才到的情况。 */
export function linkStatementLines(store: BookStore, pack: LoadedPack, input: { voucherNo: string; statementLineIds: readonly number[] }) {
  if (store.company()?.isSample) return refuse('SAMPLE_BOOK', '样本账不改。')
  const [voucher] = store.vouchers({ voucherNo: input.voucherNo })
  if (!voucher) return refuse('VOUCHER_NOT_FOUND', `没有凭证 ${input.voucherNo}。`)
  if (voucher.voided) return refuse('VOUCHER_VOIDED', `凭证 ${input.voucherNo} 已经作废了。`)
  const periodKey = voucher.voucherDate.slice(0, 7)
  if (store.lockedPeriods().includes(periodKey)) return refuse('PERIOD_LOCKED', `${periodKey} 已经结账，凭证不能再改。`)
  const lineIds = [...new Set(input.statementLineIds)]
  if (lineIds.length === 0) return refuse('STATEMENT_LINES_REQUIRED', '至少提供一行真实流水，不能用空列表补结算凭据。')
  const lines = store.statementLines({ ids: lineIds })
  const missing = lineIds.filter((id) => !lines.some((l) => l.id === id))
  if (missing.length) return refuse('STATEMENT_LINE_NOT_FOUND', `没有这些流水行：${missing.join('、')}。`)
  const taken = lines.filter((l) => l.voucherNo && l.voucherNo !== input.voucherNo)
  if (taken.length)
    return refuse('STATEMENT_LINE_ALREADY_RECORDED', `这些流水已经记过了：${taken.map((l) => `${l.id}（${l.voucherNo}）`).join('、')}。`)
  const elsewhere = otherPeriodLines(lines, periodKey)
  if (elsewhere) return elsewhere
  const posting: LedgerPosting = {
    eventId: '',
    packRef: pack.packRef,
    ruleId: voucher.ruleId,
    legs: voucher.legs.map((l) => ({ ...l, amount: formatCents(l.amountCents), amountSource: '' })),
  }
  const allLines = [...new Map(
    [...store.statementLines({ voucherNo: input.voucherNo }), ...lines].map(line => [line.id, line]),
  ).values()]
  const mismatch = statementMismatch(pack.payload, posting, allLines)
  if (mismatch) return mismatch
  store.transaction(() => {
    for (const id of lineIds) store.attachStatementLine(id, voucher.id)
    store.addEvidence(voucher.id, 'settlement')
  })
  return { accepted: true as const, voucherNo: input.voucherNo, statementLineIds: lineIds }
}

/** 发票和流水由核票、挂流水那两步自动算作凭据，这里不收。 */
const AUTOMATIC_ROLES = new Set(['invoice', 'settlement'])

/**
 * 给一张已记的凭证补挂凭据（合同、收据、出资协议之类），用于记账时手上没有、后来拿到了的情况。
 * 只收这张凭证还缺的那几种；已结账的月份、作废的凭证不改。
 */
export function addEvidence(store: BookStore, input: { voucherNo: string; roles: readonly string[] }) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  if (company.isSample) return refuse('SAMPLE_BOOK', '样本账不改。')
  const [voucher] = store.vouchers({ voucherNo: input.voucherNo })
  if (!voucher) return refuse('VOUCHER_NOT_FOUND', `没有凭证 ${input.voucherNo}。`)
  if (voucher.voided) return refuse('VOUCHER_VOIDED', `凭证 ${input.voucherNo} 已经作废了。`)
  const periodKey = voucher.voucherDate.slice(0, 7)
  if (store.lockedPeriods().includes(periodKey)) return refuse('PERIOD_LOCKED', `${periodKey} 已经结账，凭证不能再改。`)
  const roles = [...new Set(input.roles)]
  if (roles.length === 0) return refuse('ROLES_REQUIRED', '要说明补的是哪种凭据。')
  const automatic = roles.filter((r) => AUTOMATIC_ROLES.has(r))
  if (automatic.length)
    return refuse(
      'ROLE_AUTOMATIC',
      '发票要先用 moneycome_check_invoice 核过、记账时带上发票号；流水要用 moneycome_link_statement 挂上。这两种不在这里补。',
      { roles: automatic },
    )
  const missing = voucher.requiredRoles.filter((r) => !voucher.evidenceRoles.includes(r))
  const notNeeded = roles.filter((r) => !missing.includes(r))
  if (notNeeded.length)
    return refuse('ROLE_NOT_MISSING', `${input.voucherNo} 不缺这些凭据：${notNeeded.join('、')}。`, { missingEvidence: missing })
  store.transaction(() => {
    for (const role of roles) store.addEvidence(voucher.id, role)
  })
  return { accepted: true as const, voucherNo: input.voucherNo, added: roles, missingEvidence: missing.filter((r) => !roles.includes(r)) }
}

/** 某月记了哪些凭证。 */
export function listVouchers(store: BookStore, periodKey: string) {
  return store.vouchers({ periodKey }).map((v) => ({
    voucherNo: v.voucherNo,
    date: v.voucherDate,
    summary: v.summary,
    legs: legView(v.legs.map((l) => ({ ...l, amount: formatCents(l.amountCents) }))),
    missingEvidence: v.requiredRoles.filter((r) => !v.evidenceRoles.includes(r)),
  }))
}

/**
 * 作废一张记错的凭证。只能作废还没结账的月份里、按业务记的凭证；结账时生成的结转凭证不能单独作废。
 * 作废不删记录，挂在上面的发票和流水解开，可以重新记。
 */
export function voidVoucher(
  store: BookStore,
  transferKinds: readonly string[],
  input: { voucherNo: string; reason: string },
  now: Date,
) {
  const [voucher] = store.vouchers({ voucherNo: input.voucherNo })
  if (!voucher) return refuse('VOUCHER_NOT_FOUND', `没有凭证 ${input.voucherNo}。`)
  if (voucher.voided) return refuse('VOUCHER_VOIDED', `凭证 ${input.voucherNo} 已经作废了。`)
  if (store.company()?.isSample) return refuse('SAMPLE_BOOK', '样本账不改。')
  const periodKey = voucher.voucherDate.slice(0, 7)
  if (store.lockedPeriods().includes(periodKey)) return refuse('PERIOD_LOCKED', `${periodKey} 已经结账，凭证不能再作废。`)
  if (transferKinds.includes(voucher.eventKind)) return refuse('TRANSFER_VOUCHER', '结账生成的结转凭证不能单独作废。')
  const reason = input.reason.trim()
  if (reason.length < VOID_REASON_MIN_LENGTH || reason.length > VOID_REASON_MAX_LENGTH)
    return refuse('REASON_REQUIRED', `作废要写清原因，${VOID_REASON_MIN_LENGTH} 到 ${VOID_REASON_MAX_LENGTH} 个字。`)
  store.transaction(() => store.voidVoucher(voucher.id, reason, now))
  return { accepted: true as const, voucherNo: voucher.voucherNo, voided: true }
}
