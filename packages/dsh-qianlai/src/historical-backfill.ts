import { createHash } from 'node:crypto'

import { formatCents } from '@moneycome/fintax-core'

import { bankRegistrationView } from './bank-accounts.js'
import { firstBalanceDifference, validateOpeningRows, type OpeningBalanceInput } from './book.js'
import { bankBalanceCheck, postBalanceTransfers } from './closing.js'
import { packParameter, recordEntry, type RecordEntryInput } from './entries.js'
import { historicalHandoffProgress, readHistoricalHandoff } from './historical-handoff.js'
import type { LoadedPack } from './pack.js'
import { isCalendarDate, monthRange, nextPeriod, PERIOD_KEY, previousPeriod, refuse, todayInChina, type Refusal } from './period.js'
import { importStatement, type ImportStatementInput } from './statements.js'
import type { BookStore, SubjectMovement } from './store.js'

const draftOperation = 'local-work:history-backfill-draft'
const postingOperation = 'local-work:history-backfill-posting'

interface BalanceSource {
  readonly materialId: number
  readonly balances: readonly OpeningBalanceInput[]
}

interface StatementReference {
  readonly materialId: number
  readonly rowNumber: number
}

type BackfillEntry = Pick<RecordEntryInput, 'date' | 'summary' | 'eventKind' | 'facts' | 'amounts' | 'evidenceRoles' | 'invoiceNumber'> & {
  readonly materialId: number
  readonly sourceRef: string
  readonly statementRows?: readonly StatementReference[]
}

interface BackfillPeriod {
  readonly periodKey: string
  readonly opening?: BalanceSource
  readonly closing?: BalanceSource
  readonly noActivityMaterialId?: number
  readonly statements?: readonly (ImportStatementInput & { readonly materialId: number })[]
  readonly entries: readonly BackfillEntry[]
}

export interface HistoricalBackfillInput {
  readonly handoffId: number
  readonly periods: readonly BackfillPeriod[]
}

const balanceRows = (rows: readonly SubjectMovement[]) => rows.filter(row => row.netDebitCents !== 0n).map(row => ({
  subjectCode: row.subjectCode, subjectName: row.subjectName, side: row.netDebitCents < 0n ? '贷' : '借',
  balance: formatCents(row.netDebitCents < 0n ? -row.netDebitCents : row.netDebitCents),
}))

type DraftView = ReturnType<typeof previewView>
type PostedMonth = {
  readonly periodKey: string
  readonly vouchers: readonly { voucherNo: string; materialId: number; sourceRef: string }[]
  readonly transferVouchers: readonly string[]
  readonly statementSources: readonly { materialId: number; importId: number }[]
  readonly openingMaterialId?: number
  readonly closingMaterialId?: number
  readonly noActivityMaterialId?: number
}
type BackfillReceipt = {
  readonly accepted: true
  readonly phase: 'posted'
  readonly draftId: number
  readonly handoffId: number
  readonly months: readonly PostedMonth[]
}

interface SavedDraft {
  readonly input: HistoricalBackfillInput
  readonly fingerprint: string
  readonly view: DraftView
}

function sourceBalances(store: BookStore, pack: LoadedPack, source: BalanceSource | undefined, month: string, label: string) {
  if (!source || store.workMaterial(source.materialId)?.status !== 'read')
    return refuse('HISTORY_BALANCE_SOURCE_REQUIRED', `请发 ${month} 的${label}科目余额表，我会用它核对衔接金额。`, { month, label })
  const checked = validateOpeningRows(pack, source.balances)
  return checked.accepted ? checked : refuse(checked.code, `${month} 的${label}资料待核对。${checked.message}`, checked.details)
}

function compareBoundary(
  actual: readonly SubjectMovement[], expected: readonly SubjectMovement[], month: string, target: string,
): Refusal | undefined {
  const first = firstBalanceDifference(actual, expected)
  if (!first) return undefined
  return refuse('HISTORY_BALANCE_DIFFERENCE',
    `${month} 的${first.subjectName}算出 ${first.actual} 元，${target}为 ${first.expected} 元，相差 ${first.difference} 元。请先核对这一项的原件。`,
    { month, target, ...first })
}

function reconcileBankBalance(store: BookStore, bankSubject: string, month: string, now: Date) {
  const range = monthRange(month)
  const statements = store.statementCoverage().filter(item => item.from <= range.to && item.to >= range.from)
  const throughMonthEnd = new Set(statements.filter(item => item.to >= range.to).map(item => item.accountRef))
  const accounts = bankRegistrationView(store, todayInChina(now)).accounts.filter(account => !account.openedOn || account.openedOn <= range.to)
  if (statements.some(item => !throughMonthEnd.has(item.accountRef)) || accounts.some(account => !throughMonthEnd.has(account.accountRef)))
    return undefined
  const check = bankBalanceCheck(store, bankSubject, month, true)
  const first = check.blockers[0]
  if (!first) return undefined
  if (first.kind === 'bank_balance_mismatch')
    return refuse('HISTORY_BANK_BALANCE_DIFFERENCE',
      `${month} 账上银行存款是 ${String(first.bookBalance)} 元，月末流水是 ${String(first.statementBalance)} 元。请先核对银行存款的期初资料。`,
      { ...first, month })
  return refuse('HISTORY_BANK_BALANCE_UNKNOWN', `请补一份能核实 ${month} 月末余额的银行资料。`, { ...first, month })
}

function previewView(
  company: string,
  takeover: string,
  months: readonly { periodKey: string; opening: ReturnType<typeof balanceRows>; closing: ReturnType<typeof balanceRows>;
    business: readonly { date: string; summary: string; legs: { side: '借' | '贷'; subjectCode: string; subjectName: string; amount: string }[] }[];
    matchedAgainst: string; transferCount: number }[],
) {
  return { company, takeover, months,
    voucherCount: months.reduce((total, month) => total + month.business.length, 0),
    transferCount: months.reduce((total, month) => total + month.transferCount, 0) }
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)

class BackfillRejected extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message)
  }
}

/** Dry runs and commits execute the same validation and accounting path. The caller owns its savepoint or transaction. */
function applyHistoricalBatch(store: BookStore, pack: LoadedPack, input: HistoricalBackfillInput, now: Date) {
  const scope = readHistoricalHandoff(store, input.handoffId)
  if (!scope.accepted) return scope
  const plan = scope.plan
  if (plan.state !== 'confirmed' || historicalHandoffProgress(store).plans[0]?.handoffId !== input.handoffId)
    return refuse('HISTORY_SCOPE_CONFIRMATION_REQUIRED', '请先在当前交接卡核对并确认最新的缺月范围。')
  if (store.workMaterial(plan.materialId)?.status !== 'read')
    return refuse('HISTORY_SCOPE_MATERIAL_REQUIRED', '请先补交原交接范围所用的材料。')

  const periods = [...input.periods].sort((a, b) => a.periodKey.localeCompare(b.periodKey))
  if (!periods.length) return refuse('HISTORY_MONTH_REQUIRED', '请选择要补账的已确认缺月。')
  // The receipt and DSH approval are deliberately bounded per batch. More months can be submitted independently.
  if (periods.length > 12 || periods.reduce((total, month) => total + month.entries.length + (month.statements?.reduce((n, s) => n + s.rows.length, 0) ?? 0), 0) > 500)
    return refuse('HISTORY_BATCH_TOO_LARGE', '这批历史资料较多，请分批补记。每批最多 12 个月，业务和流水行合计最多 500 条。')

  const takeover = plan.accountingStartMonth
  const company = store.company()!
  const archived = new Set([...store.historicalPeriods(), ...store.postedPeriods(), ...store.lockedPeriods()])
  const selected = new Map<string, BackfillPeriod>()
  const lastHistorical = previousPeriod(takeover)
  const businessDate = todayInChina(now)
  for (const month of periods) {
    if (!PERIOD_KEY.test(month.periodKey) || selected.has(month.periodKey))
      return refuse('HISTORY_MONTH_INVALID', '请核对补账月份。同一批资料中的月份只能列一次。')
    if (archived.has(month.periodKey) || !plan.missingMonths.includes(month.periodKey))
      return refuse('HISTORY_MONTH_OUTSIDE_SCOPE', `${month.periodKey} 不在本次待补范围，或已有凭证。请从原交接记录核对。`, { month: month.periodKey })
    if (monthRange(month.periodKey).to >= businessDate)
      return refuse('HISTORY_MONTH_NOT_ENDED', `${month.periodKey} 尚未结束。请等当月资料齐全后再补记。`)
    selected.set(month.periodKey, month)
  }
  if (selected.has(lastHistorical) && !store.openingBalancesSetAt()) {
    return refuse('HISTORY_TAKEOVER_OPENING_REQUIRED',
      `请先核对并录入 ${takeover} 的现有期初余额，我会用它核对补账后的期末。`, { month: takeover })
  }
  const recordedSources = new Set(backfillReceipts(store).flatMap(receipt => receipt.months.flatMap(month =>
    month.vouchers.map(voucher => sourceKey(voucher.materialId, voucher.sourceRef)))))
  const monthViews: Parameters<typeof previewView>[2][number][] = []
  const posted: PostedMonth[] = []

  for (const [index, month] of periods.entries()) {
    const key = month.periodKey
    const previous = previousPeriod(key)
    const next = periods[index + 1]
    const followingPeriod = key === lastHistorical ? takeover : nextPeriod(key)
    if (!month.entries.length && (month.noActivityMaterialId === undefined || store.workMaterial(month.noActivityMaterialId)?.status !== 'read'))
      return refuse('HISTORY_ACTIVITY_SOURCE_REQUIRED', `请发能核实 ${key} 没有业务发生的资料。`, { month: key })
    const previousClosing = store.historicalOpening(previous) ? store.movements(previous) : undefined
    const explicit = month.opening ? sourceBalances(store, pack, month.opening, key, '期初') : undefined
    if (explicit && !explicit.accepted) return explicit
    const opening = explicit?.rows ?? previousClosing
    if (!opening)
      return refuse('HISTORY_OPENING_REQUIRED', `请发能证明 ${key} 月初余额的科目表。我会从它开始补记。`, { month: key })
    if (explicit && previousClosing) {
      const difference = compareBoundary(previousClosing, explicit.rows, previous, `${key} 的期初资料`)
      if (difference) return difference
    }
    store.saveHistoricalOpening(key, opening)

    const statementIds = new Map<number, number>()
    const statementLines = new Map<string, number>()
    for (const statement of month.statements ?? []) {
      if (statementIds.has(statement.materialId) || !statement.sourceBank || !statement.sourceAccountTail ||
          statement.periodStart.slice(0, 7) !== key || statement.periodEnd.slice(0, 7) !== key) {
        return refuse('HISTORY_STATEMENT_SCOPE', `请核对 ${key} 的流水原件、账户尾号和实际覆盖日期。`, { month: key, materialId: statement.materialId })
      }
      const imported = importStatement(store, statement, now, key)
      if (!imported.accepted) return imported
      statementIds.set(statement.materialId, imported.receipt.importId)
      for (const line of store.statementLines({ importId: imported.receipt.importId }))
        statementLines.set(sourceKey(statement.materialId, line.rowNumber), line.id)
    }

    const vouchers: PostedMonth['vouchers'][number][] = []
    const business: (typeof monthViews)[number]['business'][number][] = []
    const bankSubject = packParameter(pack.payload, 'transaction.account.bank.subject')
    for (const entry of month.entries) {
      if (!isCalendarDate(entry.date) || entry.date.slice(0, 7) !== key)
        return refuse('HISTORY_ENTRY_DATE', `有一笔凭证日期不在 ${key}，请按原件核对日期。`, { month: key, date: entry.date })
      const sourceRef = entry.sourceRef.trim()
      const source = sourceKey(entry.materialId, sourceRef)
      if (!entry.summary.trim() || entry.summary.length > 200 || !sourceRef || sourceRef.length > 120 ||
          /\p{C}/u.test(sourceRef) || store.workMaterial(entry.materialId)?.status !== 'read')
        return refuse('HISTORY_ENTRY_SOURCE_REQUIRED', '请先发这笔历史业务的原件，并核对原始单据号或行号。', { month: key, date: entry.date })
      if (recordedSources.has(source))
        return refuse('HISTORY_ENTRY_DUPLICATE', '这笔业务的原始单据号或行号已用于补账，请核对重复项。', { month: key, sourceRef })
      recordedSources.add(source)
      const ids = (entry.statementRows ?? []).map(row => statementLines.get(sourceKey(row.materialId, row.rowNumber)))
      if (ids.some(id => id === undefined))
        return refuse('HISTORY_STATEMENT_LINE_REQUIRED', '请匹配这笔历史凭证对应的流水原件和行号。', { month: key, sourceRef })

      const result = recordEntry(store, pack, {
        date: entry.date, summary: entry.summary, eventKind: entry.eventKind,
        facts: entry.facts, amounts: entry.amounts,
        ...(entry.evidenceRoles ? { evidenceRoles: entry.evidenceRoles } : {}),
        ...(entry.invoiceNumber ? { invoiceNumber: entry.invoiceNumber } : {}),
        statementLineIds: ids as number[],
      }, now, key)
      if (!result.accepted) return result
      if (!('voucherNo' in result) || typeof result.voucherNo !== 'string') throw Error('Historical posting did not return a voucher')
      if (result.missingEvidence.length)
        return refuse('HISTORY_ENTRY_EVIDENCE_REQUIRED', `「${entry.summary}」还有凭据需要核对。`, {
          month: key, sourceRef, missing: result.missingEvidence,
        })
      if (bankSubject && result.legs.some(leg => leg.subjectCode === bankSubject) && !ids.length)
        return refuse('HISTORY_BANK_PROOF_REQUIRED', `请发或匹配「${entry.summary}」对应的银行流水。`, { month: key, sourceRef })
      vouchers.push({ voucherNo: result.voucherNo, materialId: entry.materialId, sourceRef })
      business.push({ date: entry.date, summary: entry.summary, legs: result.legs })
    }

    const unmatched = store.statementLines(monthRange(key)).find(line => !line.voucherNo)
    if (unmatched)
      return refuse('HISTORY_STATEMENT_UNMATCHED', `${key} 有一笔流水仍待核对，请为这笔流水补齐对应业务。`, {
        month: key, date: unmatched.occurredOn, rowNumber: unmatched.rowNumber, account: unmatched.accountRef,
      })

    const transferVouchers = postBalanceTransfers(store, pack, key, now)
    const closing = store.movements(key)
    const closingSource = month.closing ? sourceBalances(store, pack, month.closing, key, '期末') : undefined
    if (closingSource && !closingSource.accepted) return closingSource
    if (closingSource) {
      const difference = compareBoundary(closing, closingSource.rows, key, '原件上的期末余额')
      if (difference) return difference
    }

    const existingNext = store.historicalOpening(followingPeriod)
    const reference = followingPeriod === takeover ? store.openingBalances() : existingNext
    const nextIsInBatch = next?.periodKey === followingPeriod
    if (reference) {
      const difference = compareBoundary(closing, reference, key, `${followingPeriod} 的账本期初`)
      if (difference) return difference
    } else if (!nextIsInBatch && !closingSource) {
      return refuse('HISTORY_CLOSING_REQUIRED',
        `请发能证明 ${key} 月末余额的科目表。我会用它核对补账后的期末。`, { month: key })
    }
    if (bankSubject && statementIds.size) {
      const difference = reconcileBankBalance(store, bankSubject, key, now)
      if (difference) return difference
    }

    store.lockPeriod(key, now)
    monthViews.push({ periodKey: key, opening: balanceRows(opening), closing: balanceRows(closing), business, transferCount: transferVouchers.length,
      matchedAgainst: reference || nextIsInBatch ? followingPeriod + ' 期初' : '原件上的本月期末' })
    posted.push({ periodKey: key, vouchers, transferVouchers,
      statementSources: [...statementIds].map(([materialId, importId]) => ({ materialId, importId })),
      ...(month.opening ? { openingMaterialId: month.opening.materialId } : {}),
      ...(month.closing ? { closingMaterialId: month.closing.materialId } : {}),
      ...(month.noActivityMaterialId ? { noActivityMaterialId: month.noActivityMaterialId } : {}) })
  }

  const view = previewView(company.name, takeover, monthViews)
  const fingerprint = createHash('sha256').update(canonical([input, { name: company.name, taxId: company.taxId }, pack.packRef, view])).digest('hex')
  return { accepted: true as const, view, fingerprint, posted }
}

const sourceKey = (materialId: number, ref: number | string) => String(materialId) + '/' + String(ref)

function backfillReceipts(store: BookStore): BackfillReceipt[] {
  return store.workEventsByOperation(postingOperation).map(event => event.result as unknown as BackfillReceipt)
}

function receiptFor(store: BookStore, draftId: number): BackfillReceipt | undefined {
  const row = store.workEventsByOperation(postingOperation).find(event => event.request.draftId === draftId)
  return row?.result as unknown as BackfillReceipt | undefined
}

function savedDraft(store: BookStore, draftId: number): SavedDraft | undefined {
  return store.workEventsByOperation(draftOperation).find(event => event.id === draftId)?.result as unknown as SavedDraft | undefined
}

export function historicalBackfillStatus(store: BookStore, handoffId?: number) {
  const receipts = backfillReceipts(store)
  const confirmed = historicalHandoffProgress(store).plans[0]
  const drafts = store.workEventsByOperation(draftOperation)
  const latestOpenDraft = drafts.find(event => {
    const input = (event.result as unknown as SavedDraft).input
    return confirmed?.state === 'confirmed' && confirmed.handoffId === input.handoffId &&
      (handoffId === undefined || handoffId === input.handoffId) &&
      input.periods.every(period => confirmed.missingMonths.includes(period.periodKey))
  })
  return { accepted: true as const, phase: 'status' as const,
    receipts: receipts.filter(receipt => handoffId === undefined || handoffId === receipt.handoffId),
    ...(latestOpenDraft ? { latestDraftId: latestOpenDraft.id } : {}) }
}

export function prepareHistoricalBackfill(store: BookStore, pack: LoadedPack, input: HistoricalBackfillInput, now: Date) {
  return store.transaction(() => {
    const simulated = store.previewTransaction(() => applyHistoricalBatch(store, pack, input, now))
    if (!simulated.accepted) return simulated
    const { fingerprint, view } = simulated
    const prior = store.workEventsByOperation(draftOperation).find(event => event.result.fingerprint === fingerprint)
    const draftId = prior?.id ?? store.recordWork(draftOperation, { handoffId: input.handoffId }, { input, fingerprint, view }, now)
    return { accepted: true as const, phase: 'ready' as const, draftId, view }
  })
}

export function reviewHistoricalBackfill(store: BookStore, pack: LoadedPack, draftId: number, now: Date) {
  return store.transaction(() => {
    const receipt = receiptFor(store, draftId)
    if (receipt) return receipt
    const draft = savedDraft(store, draftId)
    if (!draft) return refuse('HISTORY_DRAFT_NOT_FOUND', '当前账本找不到这批补账预演。请按原交接资料重新预演。')
    const simulated = store.previewTransaction(() => applyHistoricalBatch(store, pack, draft.input, now))
    if (!simulated.accepted) return simulated
    if (simulated.fingerprint !== draft.fingerprint)
      return refuse('HISTORY_DRAFT_CHANGED', '期初余额或凭证资料已更新。请重新预演并核对。')
    return { accepted: true as const, phase: 'ready' as const, draftId, view: simulated.view }
  })
}

export function commitHistoricalBackfill(store: BookStore, pack: LoadedPack, draftId: number, now: Date) {
  try {
    return store.transaction(() => {
      const receipt = receiptFor(store, draftId)
      if (receipt) return receipt
      const draft = savedDraft(store, draftId)
      if (!draft) return refuse('HISTORY_DRAFT_NOT_FOUND', '当前账本找不到这批补账预演。')
      const result = applyHistoricalBatch(store, pack, draft.input, now)
      if (!result.accepted) throw new BackfillRejected(result)
      if (result.fingerprint !== draft.fingerprint)
        throw new BackfillRejected(refuse('HISTORY_DRAFT_CHANGED', '期初余额或凭证资料已更新。请重新预演并核对。'))
      const posted: BackfillReceipt = { accepted: true, phase: 'posted', draftId, handoffId: draft.input.handoffId, months: result.posted }
      store.recordWork(postingOperation, { draftId }, posted, now)
      return posted
    })
  } catch (error) {
    if (error instanceof BackfillRejected) return error.refusal
    throw error
  }
}
