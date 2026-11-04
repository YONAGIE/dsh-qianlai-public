import {
  formatCents,
  runClosingChecks,
  type ClosingBlocker,
  type ClosingCheckId,
  type LedgerPosting,
} from '@moneycome/fintax-core'

import { packParameter } from './entries.js'
import type { LoadedPack } from './pack.js'
import { monthRange, PERIOD_KEY, previousPeriod, refuse, todayInChina } from './period.js'
import { balanceTransferItems, readProfit } from './reports.js'
import { lineView } from './statements.js'
import type { BookStore } from './store.js'

const CHECK_NAMES: Record<ClosingCheckId, string> = {
  statement_complete: '银行流水这个月每一天都交齐了',
  funds_explained: '每笔流水都说清了是什么钱、记了账',
  evidence_sufficient: '每笔账该有的凭据都有',
  ledger_balanced: '每张凭证借贷平衡',
  closing_items_done: '月末该做的计提、结转都做了',
  previous_period_locked: '上个月已经结账',
}

const ROLE_NAMES: Record<string, string> = {
  invoice: '发票',
  contract: '合同',
  settlement: '银行回单或流水',
  payroll_sheet: '工资表',
  tax_certificate: '完税凭证',
}

const BANK_BALANCE_CHECK = '账上银行存款和银行流水的余额对得上'

/** 还没交过流水、但这个月有银行收付的账户，在结账检查里用这个名字。 */
const UNREGISTERED_BANK_ACCOUNT = '银行账户（还没交过流水）'

function validPeriod(store: BookStore, periodKey: string, now: Date) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '本机还没有账本。')
  if (!PERIOD_KEY.test(periodKey)) return refuse('PERIOD_INVALID', `月份要写成 YYYY-MM，收到的是 ${periodKey}。`)
  if (periodKey < company.accountingStartMonth)
    return refuse('PERIOD_BEFORE_BOOK', `这本账从 ${company.accountingStartMonth} 开始记，没有 ${periodKey} 的账。`)
  if (periodKey > todayInChina(now).slice(0, 7)) return refuse('PERIOD_FUTURE', `${periodKey} 还没到。`)
  return company
}

/**
 * 月末账上银行存款，和各账户流水推出的月末余额之和核对。
 * 每个账户的月末余额 = 盖住月末那份流水的期初余额 + 这份流水里月末及以前的收支。
 * 流水没交齐时先不核，免得同一个缺口报两遍。
 */
function bankBalanceCheck(store: BookStore, bankSubject: string, periodKey: string, statementsComplete: boolean) {
  const blockers: Record<string, unknown>[] = []
  if (!statementsComplete) {
    blockers.push({ kind: 'bank_balance_pending', message: '银行流水交齐以后再核对余额。' })
    return { check: BANK_BALANCE_CHECK, passed: false, blockers }
  }
  const monthEnd = monthRange(periodKey).to
  const imports = store.statementCoverage()
  const accounts: { account: string; balance: string }[] = []
  let statementTotal = 0n
  for (const account of [...new Set(imports.map((i) => i.accountRef))]) {
    const covering = imports.find((i) => i.accountRef === account && i.from <= monthEnd && i.to >= monthEnd)
    // 流水只到月中、之后再没交过的账户，结账检查的「流水交齐」已经管了，这里不重复报。
    if (!covering) continue
    if (covering.openingBalanceCents === null) {
      blockers.push({ kind: 'statement_balance_unknown', account, from: covering.from, to: covering.to })
      continue
    }
    const moved = store.statementLines({ importId: covering.id, to: monthEnd }).reduce((sum, l) => sum + l.signedCents, 0n)
    const balance = covering.openingBalanceCents + moved
    statementTotal += balance
    accounts.push({ account, balance: formatCents(balance) })
  }
  if (blockers.length) return { check: BANK_BALANCE_CHECK, passed: false, blockers }
  const book = store.movements(periodKey).find((m) => m.subjectCode === bankSubject)?.netDebitCents ?? 0n
  if (book !== statementTotal)
    blockers.push({
      kind: 'bank_balance_mismatch',
      bookBalance: formatCents(book),
      statementBalance: formatCents(statementTotal),
      difference: formatCents(book - statementTotal),
      accounts,
      openingBalancesEntered: store.openingBalancesSetAt() !== undefined,
    })
  return { check: BANK_BALANCE_CHECK, passed: blockers.length === 0, blockers }
}

function runChecks(store: BookStore, pack: LoadedPack, periodKey: string, startMonth: string, now: Date) {
  const range = monthRange(periodKey)
  const transferIds = new Set(balanceTransferItems(pack.payload).map((i) => i.itemId))
  const vouchers = store.vouchers({ periodKey }).filter((v) => !transferIds.has(v.eventKind))
  const lines = store.statementLines(range)

  const coverage = new Map<string, { from: string; to: string }[]>()
  for (const c of store.statementCoverage()) coverage.set(c.accountRef, [...(coverage.get(c.accountRef) ?? []), c])
  const bankSubject = packParameter(pack.payload, 'transaction.account.bank.subject')
  if (coverage.size === 0 && bankSubject && vouchers.some((v) => v.legs.some((l) => l.subjectCode === bankSubject)))
    coverage.set(UNREGISTERED_BANK_ACCOUNT, [])

  const prev = previousPeriod(periodKey)
  const report = runClosingChecks({
    periodRange: range,
    previousPeriod:
      periodKey === startMonth
        ? { kind: 'first_period' }
        : { kind: store.lockedPeriods().includes(prev) ? 'locked' : 'open', periodKey: prev },
    accounts: [...coverage].map(([accountRef, coveredRanges]) => ({ accountRef, coveredRanges })),
    unexplainedTransactionRefs: lines.filter((l) => !l.voucherNo).map((l) => String(l.id)),
    events: vouchers.map((v) => ({
      eventRef: v.voucherNo,
      eventKind: v.eventKind,
      evidenceRoles: v.evidenceRoles,
      requiredRoles: v.requiredRoles,
      postingIssue: null,
    })),
    vouchers: vouchers.map((v) => ({
      voucherRef: v.voucherNo,
      debitMinor: v.legs.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amountCents, 0n),
      creditMinor: v.legs.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amountCents, 0n),
    })),
    completedClosingItemIds: [...new Set(vouchers.map((v) => v.eventKind))],
    entityFacts: store.companyFacts(),
    pack: {
      evidenceRequirements: pack.payload.evidenceRequirements,
      // 按余额结转的那一项（损益结转）是结账这一步自己做的，不在检查里等它。
      closingItems: pack.payload.closingItems.filter((i) => !transferIds.has(i.itemId)),
    },
  })

  const lineById = new Map(lines.map((l) => [String(l.id), l]))
  const voucherByNo = new Map(vouchers.map((v) => [v.voucherNo, v]))
  const itemName = (id: string) => pack.payload.closingItems.find((i) => i.itemId === id)?.itemName ?? id
  const describe = (b: ClosingBlocker) => {
    switch (b.kind) {
      case 'statement_gap':
        return { kind: b.kind, account: b.accountRef, from: b.from, to: b.to }
      case 'unexplained_transaction': {
        const line = lineById.get(b.transactionRef)
        return { kind: b.kind, ...(line ? lineView(line) : { lineId: b.transactionRef }) }
      }
      case 'evidence_missing': {
        const v = voucherByNo.get(b.eventRef)
        return {
          kind: b.kind,
          voucherNo: b.eventRef,
          summary: v?.summary,
          missing: b.missingRoles.map((r) => ROLE_NAMES[r] ?? r),
        }
      }
      case 'closing_item_pending':
        return { kind: b.kind, itemId: b.itemId, itemName: itemName(b.itemId) }
      case 'entity_fact_unknown':
        return { kind: b.kind, factKey: b.factKey, itemName: itemName(b.itemId) }
      case 'voucher_unbalanced':
        return {
          kind: b.kind,
          voucherNo: b.voucherRef,
          debit: formatCents(b.debitMinor),
          credit: formatCents(b.creditMinor),
        }
      default:
        return b
    }
  }
  const checks: { check: string; passed: boolean; blockers: object[] }[] = report.checks.map((c) => ({
    check: CHECK_NAMES[c.checkId],
    passed: c.passed,
    blockers: c.blockers.map(describe),
  }))
  if (bankSubject) {
    const complete = report.checks.find((c) => c.checkId === 'statement_complete')?.passed ?? true
    checks.push(bankBalanceCheck(store, bankSubject, periodKey, complete))
  }
  const openingConfirmed = store.openingBalancesSetAt() !== undefined
  const corrections = store.pendingCorrections(periodKey)
  if (corrections.length) checks.push({
    check: '已确认在本月补记的更正凭证已入账', passed: false,
    blockers: corrections.map(row => ({ kind: 'correction_pending', ...row, replacementPeriod: periodKey })),
  })
  const periodEnded = periodKey < todayInChina(now).slice(0, 7)
  checks.push(
    { check: '期初余额已经确认（含全零）', passed: openingConfirmed, blockers: openingConfirmed ? [] : [{ kind: 'opening_balances_unconfirmed' }] },
    { check: '本月业务期间已经结束', passed: periodEnded, blockers: periodEnded ? [] : [{ kind: 'period_not_ended', periodKey }] },
  )
  return {
    canClose: checks.every((c) => c.passed),
    checks,
    atClose: [...transferIds].map(itemName),
  }
}

/** 某月能不能结账：逐项检查，不短路，每一项卡在哪都列出来。 */
export function closingCheck(store: BookStore, pack: LoadedPack, periodKey: string, now: Date) {
  const company = validPeriod(store, periodKey, now)
  if ('accepted' in company) return company
  if (store.lockedPeriods().includes(periodKey))
    return { accepted: true as const, periodKey, locked: true, canClose: false, message: `${periodKey} 已经结过账了。` }
  return {
    accepted: true as const,
    periodKey,
    isSampleBook: company.isSample,
    locked: false,
    ...runChecks(store, pack, periodKey, company.accountingStartMonth, now),
  }
}

/**
 * 结账：所有检查通过才做。先按包声明做损益结转（把这个月损益科目的余额转进声明的科目），再把这个月锁住，
 * 之后不能再往里记账或导流水。
 *
 * 结转分录按余额算、不按规则推，做法与 moneycome `finance-ledger/balance-transfer.ts` 相同。
 */
export function closePeriod(store: BookStore, pack: LoadedPack, periodKey: string, now: Date) {
  const company = validPeriod(store, periodKey, now)
  if ('accepted' in company) return company
  if (company.isSample) return refuse('SAMPLE_BOOK', '样本账只用来演示，不结账。')
  if (store.lockedPeriods().includes(periodKey)) return refuse('PERIOD_LOCKED', `${periodKey} 已经结过账了。`)
  const checks = runChecks(store, pack, periodKey, company.accountingStartMonth, now)
  if (!checks.canClose) return refuse('CLOSING_BLOCKED', '还有没过的检查项，这个月先不能结账。', checks.checks.filter((c) => !c.passed))

  const profit = store.postedPeriods().includes(periodKey) ? readProfit(store, pack, periodKey) : undefined
  const subjects = new Map(pack.payload.catalogs[0]!.subjects.map((s) => [s.subjectCode, s]))
  const posted: string[] = []
  store.transaction(() => {
    for (const item of balanceTransferItems(pack.payload)) {
      const transfer = item.balanceTransfer!
      const inScope = new Set(
        pack.payload.reportLines.filter((l) => l.reportId === transfer.fromReportId).flatMap((l) => l.subjectCodes),
      )
      const legs: LedgerPosting['legs'][number][] = []
      let net = 0n
      for (const m of store.movements(periodKey, periodKey)) {
        if (!inScope.has(m.subjectCode) || m.netDebitCents === 0n) continue
        // 借方余额就贷方冲平，贷方余额就借方冲平。
        const debit = m.netDebitCents < 0n
        const amount = debit ? -m.netDebitCents : m.netDebitCents
        net += debit ? amount : -amount
        legs.push({ direction: debit ? 'debit' : 'credit', subjectCode: m.subjectCode, subjectName: m.subjectName, amount: formatCents(amount), amountSource: 'balance' })
      }
      if (legs.length === 0) continue
      const target = subjects.get(transfer.toSubjectCode)!
      if (net !== 0n)
        legs.push({
          direction: net > 0n ? 'credit' : 'debit',
          subjectCode: target.subjectCode,
          subjectName: target.subjectName,
          amount: formatCents(net > 0n ? net : -net),
          amountSource: 'balance',
        })
      const saved = store.postVoucher({
        periodKey,
        voucherDate: monthRange(periodKey).to,
        summary: `${periodKey} ${item.itemName}`,
        eventKind: item.itemId,
        facts: {},
        posting: { eventId: `close-${periodKey}-${item.itemId}`, packRef: pack.packRef, ruleId: item.itemId, legs },
        requiredRoles: [],
        evidenceRoles: [],
        now,
      })
      posted.push(saved.voucherNo)
    }
    store.lockPeriod(periodKey, now)
  })
  return {
    accepted: true as const,
    periodKey,
    locked: true,
    transferVouchers: posted,
    ...(profit && profit.accepted ? { profit: profit.month.totals } : {}),
  }
}
