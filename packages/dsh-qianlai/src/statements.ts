import {
  formatCents,
  hasBlockingImportFailure,
  parseDate,
  parseSignedCents,
  runPrintedFigureChecks,
  runStatementImportChecks,
  type PrintedStatementFigures,
  type RawStatementRow,
} from '@moneycome/fintax-core'

import { accountDigits, bankFromRef, registeredBankProfile, sameBank } from './bank-accounts.js'
import { isCalendarDate, monthRange, refuse, todayInChina } from './period.js'
import type { BookStore } from './store.js'

export { readUpload } from './uploads.js'

export interface ImportStatementInput extends PrintedStatementFigures {
  /** 哪个账户的流水，写开户行加卡号尾号，如「招商银行 尾号 1234」。 */
  readonly accountRef: string
  readonly bankAccountId?: string
  readonly sourceAccountTail?: string
  readonly sourceBank?: string
  readonly materialId?: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly rows: readonly RawStatementRow[]
}

/** accountRef 里的卡号数字（全部数字连起来）。 */
const cardDigits = accountDigits

/** 两个写法的卡号数字一个是另一个的结尾，比如 8801 和 628801：光看数字分不出是不是同一张卡。 */
const tailsCollide = (a: string, b: string) => {
  const x = cardDigits(a)
  const y = cardDigits(b)
  return x.endsWith(y) || y.endsWith(x)
}

/** 已经导过流水的银行账户，按第一次导入的先后。 */
export function bankAccounts(store: BookStore): string[] {
  return [...new Set(store.statementCoverage().map((c) => c.accountRef))]
}

type StatementReceipt = {
  readonly importId: number
  readonly materialId?: number
  readonly months: string[]
  readonly openingBalance: string
  readonly closingBalance: string
}

function statementMonths(from: string, to: string) {
  const months: string[] = []
  for (let year = Number(from.slice(0, 4)), month = Number(from.slice(5, 7));;) {
    const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
    months.push(key)
    if (key === to.slice(0, 7)) return months
    if (++month === 13) { year++; month = 1 }
  }
}

function selectBankAccount(store: BookStore, input: ImportStatementInput) {
  const requested = input.accountRef.trim()
  const digits = cardDigits(requested)
  if (digits.length < 4) return refuse('ACCOUNT_TAIL_REQUIRED', '请选择已有账户，或填写开户行和账号末尾至少四位。')
  const profile = registeredBankProfile(store)
  const registered = profile?.accounts ?? []
  const matching = registered.filter(account => account.number.endsWith(digits) && sameBank(account.bank, bankFromRef(requested)))
  const account = input.bankAccountId ? registered.find(item => item.id === input.bankAccountId) : matching.length === 1 ? matching[0] : undefined
  if (input.bankAccountId && !account)
    return refuse('BANK_ACCOUNT_NOT_FOUND', '该账户未登记在本公司。请从当前账本选择正确账户。')
  if (account && (!sameBank(account.bank, bankFromRef(requested)) || !account.number.endsWith(digits)))
    return refuse('STATEMENT_TARGET_CONFLICT', '选中的账户与填写的账户不一致。请重新选择。')
  const tail = input.sourceAccountTail?.trim()
  if (tail !== undefined && !/^\d{4,6}$/.test(tail))
    return refuse('STATEMENT_SOURCE_TAIL_INVALID', '只填写对账单上可以核实的账号后四至六位。')
  const sourceBank = input.sourceBank?.trim()
  const targetDigits = account?.number ?? digits
  if ((tail && !targetDigits.endsWith(tail) && !(targetDigits.length === 4 && tail.endsWith(targetDigits))) ||
    (sourceBank && !sameBank(account?.bank ?? bankFromRef(requested), sourceBank)))
    return refuse('STATEMENT_ACCOUNT_MISMATCH', '这份流水上的银行或账号尾号与所选账户不符。请选择原件对应的账户后重试。', {
      ...(tail ? { sourceTail: tail.slice(-4) } : {}),
      ...(sourceBank ? { sourceBank } : {}),
    })
  if (!account && matching.length > 1) return refuse('STATEMENT_ACCOUNT_AMBIGUOUS', '有多个账户与这个尾号相符。请先选择银行账户。')
  if (!account) return { accepted: true as const, requested, accountRef: requested }
  const aliases = bankAccounts(store).filter(ref =>
    sameBank(account.bank, bankFromRef(ref)) && tailsCollide(account.number, cardDigits(ref)))
  if (aliases.length > 1) return refuse('STATEMENT_ACCOUNT_AMBIGUOUS', '原记录中有多个可能的账户。请先核对开户行和历史流水。')
  return {
    accepted: true as const, requested: account.bank + ' 尾号 ' + account.number.slice(-4),
    accountRef: aliases[0] ?? account.bank + ' 尾号 ' + account.number.slice(-4), bankAccountId: account.id, openedOn: account.openedOn,
  }
}

/**
 * 给已有账户换个写法，用于两张卡尾号撞了、要多写几位卡号区分时。
 * 新写法的卡号数字要以原来的数字结尾（是同一张卡，只是多写了几位），且和别的账户不再撞。
 */
export function renameBankAccount(store: BookStore, input: { accountRef: string; newAccountRef: string }) {
  if (store.company()?.isSample) return refuse('SAMPLE_BOOK', '样本账不改。')
  const accounts = bankAccounts(store)
  if (!accounts.includes(input.accountRef))
    return refuse('ACCOUNT_NOT_FOUND', `没有叫「${input.accountRef}」的账户。已有：${accounts.join('、') || '无'}。`)
  const name = input.newAccountRef.trim()
  const from = cardDigits(input.accountRef)
  const to = cardDigits(name)
  if (to.length < 4 || !to.endsWith(from))
    return refuse('ACCOUNT_DIGITS_CHANGED', `新写法的卡号要以原来的 ${from} 结尾，只是多写几位。`)
  const clash = accounts.filter((a) => a !== input.accountRef && tailsCollide(a, name))
  if (clash.length) return refuse('ACCOUNT_TAIL_COLLIDES', `新写法和这些账户的卡号仍然分不开：${clash.join('、')}，再多写几位。`)
  store.transaction(() => store.renameStatementAccount(input.accountRef, name))
  return { accepted: true as const, accountRef: name, bankAccounts: bankAccounts(store) }
}

/**
 * 这段流水开始前账户里有多少钱，单位分。原件印的期初余额优先（印的是整份对账单、这次只导了后面一段时不用）；
 * 没印就用第一行的交易后余额倒推。两样都没有时返回 undefined。
 */
function openingBalance(input: ImportStatementInput): bigint | undefined {
  const printedForThisBatch = input.printedPeriodStart === undefined || input.printedPeriodStart === input.periodStart
  if (printedForThisBatch && input.printedOpeningBalance !== undefined) {
    const printed = parseSignedCents(input.printedOpeningBalance)
    if (printed !== undefined) return printed
  }
  const first = input.rows[0]
  if (first?.balanceAfter === undefined) return undefined
  const after = parseSignedCents(first.balanceAfter)
  const amount = parseSignedCents(first.amount, first.direction)
  return after === undefined || amount === undefined ? undefined : after - amount
}

/**
 * 导入一份银行流水。先跑 fintax-core 的导入自查（日期、金额、余额连续、重复行、覆盖区间，
 * 以及原件印出的期初期末与合计），任何一项不过就整份不进账，把问题行号交回去。
 *
 * 进账的只是流水本身，每一行还要说清是什么钱、记成凭证；没记的行结账检查会挡住。
 */
export function importStatement(store: BookStore, input: ImportStatementInput, now: Date) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  if (company.isSample)
    return refuse('SAMPLE_BOOK', '现在是样本账。老板要导自己公司的流水，先用 moneycome_open_book 开账。')
  if (!isCalendarDate(input.periodStart) || !isCalendarDate(input.periodEnd) || input.periodStart > input.periodEnd)
    return refuse('PERIOD_INVALID', '流水的起止日期要写成 YYYY-MM-DD，且起不晚于止。')
  const businessDate = todayInChina(now)
  if (input.periodEnd > businessDate)
    return refuse('PERIOD_FUTURE', `流水截止日期 ${input.periodEnd} 还没到（北京时间 ${businessDate}）。`, {
      businessDate, periodEnd: input.periodEnd,
    })
  if (input.periodStart.slice(0, 7) < company.accountingStartMonth)
    return refuse('PERIOD_BEFORE_BOOK', `这本账从 ${company.accountingStartMonth} 开始记，流水起始日期在建账之前。`)
  const target = selectBankAccount(store, input)
  if (!target.accepted) return target
  const { accountRef, requested } = target
  const bankAccountId = 'bankAccountId' in target ? target.bankAccountId : undefined
  const openedOn = 'openedOn' in target ? target.openedOn : undefined
  if (openedOn && input.periodEnd < openedOn)
    return refuse('STATEMENT_BEFORE_OPENING', '这份流水早于已登记的开户日期，请核对原件和账户。', { openedOn })
  if (openedOn && input.rows.some(row => {
    const date = parseDate(row.occurredAt)
    return date !== undefined && date < openedOn
  })) return refuse('STATEMENT_BEFORE_OPENING', '这份流水中有开户前的交易。请核对原件和账户。', { openedOn })
  const materialId = input.materialId
  if (materialId !== undefined) {
    if (store.workMaterial(materialId)?.status !== 'read')
      return refuse('STATEMENT_SOURCE_UNAVAILABLE', '当前账本没有这份材料的成功读取记录，请重新添加该文件。')
    const previous = store.workEventsByOperation('local-work:statement-source').find(event => event.request.materialId === materialId)
    if (previous) {
      const receipt = previous.result as unknown as StatementReceipt
      const originalRef = store.statementCoverage().find(item => item.id === receipt.importId)?.accountRef
      const sameTarget = originalRef === accountRef || (bankAccountId && previous.request.bankAccountId === bankAccountId)
      if (!sameTarget ||
        previous.request.periodStart !== input.periodStart || previous.request.periodEnd !== input.periodEnd)
        return refuse('STATEMENT_SOURCE_ALREADY_IMPORTED', '这份原件已经导入过其他账户或期间。请先查看原来的导入结果。')
      return {
        accepted: true as const, accountRef: requested, ...(bankAccountId ? { bankAccountId } : {}), businessDate,
        coveredRange: { from: input.periodStart, to: input.periodEnd }, receipt, reused: true,
        lines: store.statementLines({ importId: receipt.importId }).map(lineView),
      }
    }
  }
  const locked = store.lockedPeriods().filter((p) => p >= input.periodStart.slice(0, 7) && p <= input.periodEnd.slice(0, 7))
  if (locked.length) return refuse('PERIOD_LOCKED', `${locked.join('、')} 已经结账，不能再导入这段流水。`)
  const accounts = bankAccounts(store)
  if (!accounts.includes(accountRef)) {
    // 新写法和已有账户的卡号撞上：可能是同一张卡换了个写法，也可能是两张尾号相同的卡，只有老板知道。
    const clash = accounts.filter((a) => tailsCollide(a, accountRef) && (!bankAccountId || sameBank(bankFromRef(a), bankFromRef(accountRef))))
    if (clash.length)
      return refuse(
        'ACCOUNT_TAIL_AMBIGUOUS',
        `已经有卡号尾号相同的账户：${clash.join('、')}。问老板这次是不是同一张卡：是的话 accountRef 照抄原来的写法再导；不是的话，两张卡都要多写几位卡号区分，先用 moneycome_rename_bank_account 把原来那张改成多几位的写法，再用这张卡多几位的写法导入。`,
        { existing: clash },
      )
  }
  const overlap = store
    .statementCoverage()
    .filter((c) => c.accountRef === accountRef && c.from <= input.periodEnd && c.to >= input.periodStart)
  if (overlap.length)
    return refuse(
      'STATEMENT_OVERLAP',
      `${accountRef} 在 ${overlap.map((c) => `${c.from} 至 ${c.to}`).join('、')} 的流水已经导过，这次和它重叠。`,
    )

  const checks = [...runStatementImportChecks(input), ...runPrintedFigureChecks(input)]
  const summary = checks.map((c) => ({
    check: c.check,
    status: c.status,
    ...(c.rowNumbers ? { rowNumbers: c.rowNumbers } : {}),
    ...(c.plainText ? { text: c.plainText } : {}),
  }))
  if (hasBlockingImportFailure(checks))
    return refuse('STATEMENT_CHECK_FAILED', '这份流水自己就对不上，整份先不进账。把有问题的行告诉老板，核对原件后再交。', summary)
  const opening = openingBalance(input)
  if (opening === undefined)
    return refuse(
      'STATEMENT_OPENING_UNKNOWN',
      `看不出 ${input.periodStart} 之前这个账户里有多少钱：原件没印期初余额，表里也没有交易后余额。问老板那天之前账户里的余额，填进 printedOpeningBalance 再导。结账时要靠它核对银行存款。`,
    )

  const receipt = store.transaction(() => {
    const importId = store.importStatement({
      accountRef,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      openingBalanceCents: opening,
      lines: input.rows.map((row) => ({
        rowNumber: row.rowNumber,
        occurredOn: parseDate(row.occurredAt)!,
        signedCents: parseSignedCents(row.amount, row.direction)!,
        counterparty: row.counterpartyName,
        description: row.rawDescription,
      })),
      now,
    })
    const result: StatementReceipt = {
      importId, ...(materialId === undefined ? {} : { materialId }),
      months: statementMonths(input.periodStart, input.periodEnd),
      openingBalance: formatCents(opening),
      closingBalance: formatCents(opening + store.statementLines({ importId }).reduce((sum, line) => sum + line.signedCents, 0n)),
    }
    if (materialId !== undefined) store.recordWork('local-work:statement-source', {
      materialId, ...(bankAccountId ? { bankAccountId } : {}), accountRef, periodStart: input.periodStart, periodEnd: input.periodEnd,
    }, result, now)
    return result
  })
  return {
    accepted: true as const,
    accountRef: requested,
    ...(bankAccountId ? { bankAccountId } : {}),
    businessDate,
    coveredRange: { from: input.periodStart, to: input.periodEnd },
    checks: summary,
    receipt,
    lines: store.statementLines({ importId: receipt.importId }).map(lineView),
  }
}

export const lineView = (l: ReturnType<BookStore['statementLines']>[number]) => ({
  lineId: l.id,
  date: l.occurredOn,
  amount: formatCents(l.signedCents),
  ...(l.counterparty ? { counterparty: l.counterparty } : {}),
  ...(l.description ? { description: l.description } : {}),
  voucherNo: l.voucherNo,
})

/** 还没记成凭证的流水，可按月份筛。 */
export function unrecordedStatementLines(store: BookStore, periodKey?: string) {
  const range = periodKey ? monthRange(periodKey) : {}
  return store
    .statementLines(range)
    .filter((l) => !l.voucherNo)
    .map(lineView)
}
