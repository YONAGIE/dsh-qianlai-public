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

import { isCalendarDate, monthRange, refuse, todayInChina } from './period.js'
import type { BookStore } from './store.js'

export { readUpload } from './uploads.js'

export interface ImportStatementInput extends PrintedStatementFigures {
  /** 哪个账户的流水，写开户行加卡号尾号，如「招商银行 尾号 1234」。 */
  readonly accountRef: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly rows: readonly RawStatementRow[]
}

/** accountRef 里的卡号数字（全部数字连起来）。 */
const cardDigits = (accountRef: string) => accountRef.replace(/\D/g, '')

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
  if (input.periodEnd > todayInChina(now)) return refuse('PERIOD_FUTURE', `流水截止日期 ${input.periodEnd} 还没到。`)
  if (input.periodStart.slice(0, 7) < company.accountingStartMonth)
    return refuse('PERIOD_BEFORE_BOOK', `这本账从 ${company.accountingStartMonth} 开始记，流水起始日期在建账之前。`)
  const locked = store.lockedPeriods().filter((p) => p >= input.periodStart.slice(0, 7) && p <= input.periodEnd.slice(0, 7))
  if (locked.length) return refuse('PERIOD_LOCKED', `${locked.join('、')} 已经结账，不能再导入这段流水。`)
  const accountRef = input.accountRef.trim()
  if (cardDigits(accountRef).length < 4)
    return refuse('ACCOUNT_TAIL_REQUIRED', 'accountRef 要带上卡号尾号（至少 4 位数字），如「招商银行 尾号 1234」。')
  const accounts = bankAccounts(store)
  if (!accounts.includes(accountRef)) {
    // 新写法和已有账户的卡号撞上：可能是同一张卡换了个写法，也可能是两张尾号相同的卡，只有老板知道。
    const clash = accounts.filter((a) => tailsCollide(a, accountRef))
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

  const importId = store.transaction(() =>
    store.importStatement({
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
    }),
  )
  return {
    accepted: true as const,
    accountRef,
    checks: summary,
    lines: store.statementLines({ importId }).map(lineView),
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
