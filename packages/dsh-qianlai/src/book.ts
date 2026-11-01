import { formatCents, parseAmountToCents } from '@moneycome/fintax-core'

import { dueSoon } from './deadlines.js'
import type { LoadedPack } from './pack.js'
import { PERIOD_KEY, refuse } from './period.js'
import { balanceTransferItems } from './reports.js'
import { bankAccounts, unrecordedStatementLines } from './statements.js'
import type { BookStore, SubjectMovement } from './store.js'

/** 账本现在是什么样：哪家企业、是不是样本账、记到哪个月、结到哪个月、还有什么没处理、近期要办的事。 */
export function bookStatus(store: BookStore, deadlines?: { pack: LoadedPack; now: Date }) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  const facts = store.companyFacts()
  return {
    accepted: true as const,
    company: company.name,
    isSampleBook: company.isSample,
    accountingStartMonth: company.accountingStartMonth,
    openingBalancesEntered: store.openingBalancesSetAt() !== undefined,
    bankAccounts: bankAccounts(store),
    postedPeriods: store.postedPeriods(),
    closedPeriods: store.lockedPeriods(),
    companyFacts: facts,
    invoicesNotRecorded: store.pendingInvoices().map((i) => ({ invoiceNumber: i.invoiceNumber, issueDate: i.issueDate })),
    statementLinesNotRecorded: unrecordedStatementLines(store).length,
    recentWork: store.workEvents(undefined, 5),
    continuation: 'recentWork 是同一本机账本的业务记录，笔记未核实，preview 不代表已记账或已获确认；有记录时先核对当前事项再继续，不重复已完成操作。更多记录可用 moneycome_work_progress 分页读取。',
    ...(deadlines ? { dueSoon: dueSoon(store, deadlines.pack, deadlines.now) } : {}),
  }
}

/**
 * 开老板自己公司的账。账本里是样本账时，要老板同意清掉样本账（`replaceSampleBook: true`）才开；
 * 已经是老板自己的账时拒绝，免得把真账清掉。
 */
export function openBook(
  store: BookStore,
  input: { companyName: string; taxId?: string; accountingStartMonth: string; replaceSampleBook?: boolean },
) {
  const name = input.companyName.trim()
  if (!name) return refuse('NAME_REQUIRED', '要老板公司的全称。')
  if (!PERIOD_KEY.test(input.accountingStartMonth))
    return refuse('PERIOD_INVALID', `建账月份要写成 YYYY-MM，收到的是 ${input.accountingStartMonth}。`)
  const current = store.company()
  if (current && !current.isSample)
    return refuse('BOOK_EXISTS', `本机已经有「${current.name}」的账了。体验版一台电脑只记一家公司的账。`)
  if (current?.isSample && input.replaceSampleBook !== true)
    return refuse('CONFIRM_REQUIRED', '开账会清掉现在的样本账。老板同意后，带上 replaceSampleBook: true 再开。')
  store.transaction(() => {
    store.clearBook()
    store.createCompany({
      name,
      ...(input.taxId?.trim() ? { taxId: input.taxId.trim() } : {}),
      accountingStartMonth: input.accountingStartMonth,
      isSample: false,
    })
  })
  return { accepted: true as const, company: name, accountingStartMonth: input.accountingStartMonth }
}

/**
 * 记下公司的几件基本情况（有没有固定资产、有没有发工资……），结账检查靠它判断哪些月末事项要做。
 * 只收会计包期末事项里用到的那几项，取值 yes 或 no。
 */
export function setCompanyFacts(store: BookStore, pack: LoadedPack, facts: Readonly<Record<string, string>>) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  if (company.isSample) return refuse('SAMPLE_BOOK', '样本账的情况是编好的，不改。先用 moneycome_open_book 开老板自己的账。')
  const known = new Map<string, string[]>()
  for (const item of pack.payload.closingItems)
    for (const cond of item.requiredWhen) known.set(cond.factKey, [...(known.get(cond.factKey) ?? []), item.itemName])
  const unknown = Object.keys(facts).filter((k) => !known.has(k))
  if (unknown.length)
    return refuse('FACT_UNKNOWN', `会计包里没有这些情况：${unknown.join('、')}。`, {
      knownFacts: Object.fromEntries([...known].map(([k, items]) => [k, items.join('、')])),
    })
  const invalid = Object.entries(facts).filter(([, v]) => v !== 'yes' && v !== 'no')
  if (invalid.length) return refuse('FACT_VALUE_INVALID', '取值只能是 yes 或 no。', Object.fromEntries(invalid))
  store.transaction(() => {
    for (const [key, value] of Object.entries(facts)) store.setCompanyFact(key, value)
  })
  return { accepted: true as const, companyFacts: store.companyFacts() }
}

export interface OpeningBalanceInput {
  readonly subjectCode: string
  /** 余额在借方（debit）还是贷方（credit）。 */
  readonly side: string
  /** 元，不带符号。 */
  readonly amount: string
}

const openingView = (rows: readonly SubjectMovement[]) =>
  rows.map((r) => ({
    subjectCode: r.subjectCode,
    subjectName: r.subjectName,
    side: r.netDebitCents > 0n ? ('借' as const) : ('贷' as const),
    balance: formatCents(r.netDebitCents > 0n ? r.netDebitCents : -r.netDebitCents),
  }))

/**
 * 录期初余额：建账那个月月初各科目已有的余额。每次整体替换之前录的；建账那个月结了账就不能再改。
 * 科目要在会计包的科目表里、不能是损益类（损益在上一年末已经结转），借方合计要等于贷方合计。
 * 新成立、月初什么都没有的公司传空列表，表示录过了、期初全是零。
 */
export function setOpeningBalances(store: BookStore, pack: LoadedPack, balances: readonly OpeningBalanceInput[], now: Date) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  if (company.isSample) return refuse('SAMPLE_BOOK', '样本账的期初是编好的，不改。先用 moneycome_open_book 开老板自己的账。')
  if (store.lockedPeriods().includes(company.accountingStartMonth))
    return refuse('PERIOD_LOCKED', `建账那个月 ${company.accountingStartMonth} 已经结账，期初余额不能再改。`)

  const subjects = new Map(pack.payload.catalogs[0]!.subjects.map((s) => [s.subjectCode, s.subjectName]))
  const profitScope = new Set(
    balanceTransferItems(pack.payload).flatMap((item) =>
      pack.payload.reportLines.filter((l) => l.reportId === item.balanceTransfer!.fromReportId).flatMap((l) => l.subjectCodes),
    ),
  )
  const codes = balances.map((b) => b.subjectCode)
  const unknown = codes.filter((c) => !subjects.has(c))
  if (unknown.length) return refuse('SUBJECT_UNKNOWN', `会计包的科目表里没有这些科目：${unknown.join('、')}。`)
  const profitAndLoss = codes.filter((c) => profitScope.has(c))
  if (profitAndLoss.length)
    return refuse(
      'SUBJECT_PROFIT_AND_LOSS',
      `损益类科目没有期初余额：${profitAndLoss.map((c) => `${c} ${subjects.get(c)}`).join('、')}。年内的累计利润录在本年利润（4103），以前年度的录在利润分配—未分配利润（4104）。`,
    )
  const repeated = codes.filter((c, i) => codes.indexOf(c) !== i)
  if (repeated.length) return refuse('SUBJECT_REPEATED', `同一个科目录了不止一次：${[...new Set(repeated)].join('、')}。`)
  const badSide = balances.filter((b) => b.side !== 'debit' && b.side !== 'credit').map((b) => b.subjectCode)
  if (badSide.length) return refuse('SIDE_INVALID', `side 只能是 debit 或 credit：${badSide.join('、')}。`)
  const badAmount = balances.filter((b) => {
    const cents = parseAmountToCents(b.amount)
    return cents === undefined || cents < 0n
  })
  if (badAmount.length)
    return refuse('AMOUNT_INVALID', '金额写成不带符号的元，如 12345.60。', Object.fromEntries(badAmount.map((b) => [b.subjectCode, b.amount])))

  const rows: SubjectMovement[] = balances
    .map((b) => {
      const cents = parseAmountToCents(b.amount)!
      return { subjectCode: b.subjectCode, subjectName: subjects.get(b.subjectCode)!, netDebitCents: b.side === 'debit' ? cents : -cents }
    })
    .filter((r) => r.netDebitCents !== 0n)
  const debit = rows.reduce((sum, r) => (r.netDebitCents > 0n ? sum + r.netDebitCents : sum), 0n)
  const credit = rows.reduce((sum, r) => (r.netDebitCents < 0n ? sum - r.netDebitCents : sum), 0n)
  if (debit !== credit)
    return refuse('OPENING_UNBALANCED', '期初余额借方合计和贷方合计不相等。', {
      debitTotal: formatCents(debit),
      creditTotal: formatCents(credit),
      difference: formatCents(debit > credit ? debit - credit : credit - debit),
    })

  store.transaction(() => store.setOpeningBalances(rows, now))
  return {
    accepted: true as const,
    accountingStartMonth: company.accountingStartMonth,
    balances: openingView(rows),
    debitTotal: formatCents(debit),
    creditTotal: formatCents(credit),
  }
}
