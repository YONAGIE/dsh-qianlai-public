import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { readBalances } from '../src/balances.js'
import { bookStatus, openBook, setCompanyFacts, setOpeningBalances } from '../src/book.js'
import { closePeriod, closingCheck } from '../src/closing.js'
import { addEvidence, linkStatementLines, postingGuide, recordEntry, voidVoucher } from '../src/entries.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import { readProfit } from '../src/reports.js'
import { seedSampleBook } from '../src/sample-book.js'
import { importStatement, renameBankAccount } from '../src/statements.js'
import { BookStore } from '../src/store.js'

// 企业、发票、流水全部是编的。
const NOW = new Date('2026-02-03T08:00:00Z')
const COMPANY = '杭州青禾数据服务有限公司'
const pack = loadPack()

const PURCHASE_INVOICE = {
  invoiceNumber: '26330000000012345678',
  issueDate: '2026-01-18',
  sellerName: '杭州文渊办公用品有限公司',
  sellerTaxId: '91330105MA2TEST02Y',
  buyerName: COMPANY,
  buyerTaxId: '91330106MA2TEST01X',
  amountExclTax: '1287.13',
  taxAmount: '12.87',
  totalInclTax: '1300.00',
  totalInWords: '壹仟叁佰圆整',
  taxRate: '1%',
  lineItems: ['*纸制品*A4复印纸'],
}

const SALE_INVOICE = {
  invoiceNumber: '26330000000087654321',
  issueDate: '2026-01-22',
  sellerName: COMPANY,
  sellerTaxId: '91330106MA2TEST01X',
  buyerName: '宁波远帆贸易有限公司',
  buyerTaxId: '91330201MA2TEST03Z',
  amountExclTax: '20000.00',
  taxAmount: '200.00',
  totalInclTax: '20200.00',
  totalInWords: '贰万零贰佰圆整',
  taxRate: '1%',
  lineItems: ['*信息技术服务*数据整理服务'],
}

const STATEMENT = {
  accountRef: '招商银行 尾号 8801',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  printedOpeningBalance: '0.00',
  printedClosingBalance: '118890.00',
  printedPeriodStart: '2026-01-01',
  printedPeriodEnd: '2026-01-31',
  rows: [
    { rowNumber: 1, occurredAt: '2026-01-05', amount: '100,000.00', direction: '收入', counterpartyName: '李青禾', rawDescription: '投资款', balanceAfter: '100,000.00' },
    { rowNumber: 2, occurredAt: '2026-01-18', amount: '1,300.00', direction: '支出', counterpartyName: '杭州文渊办公用品有限公司', rawDescription: '货款', balanceAfter: '98,700.00' },
    { rowNumber: 3, occurredAt: '2026-01-22', amount: '20,200.00', direction: '收入', counterpartyName: '宁波远帆贸易有限公司', rawDescription: '服务费', balanceAfter: '118,900.00' },
    { rowNumber: 4, occurredAt: '2026-01-31', amount: '10.00', direction: '支出', rawDescription: '账户管理费', balanceAfter: '118,890.00' },
  ],
}

function ownBook(): BookStore {
  const store = new BookStore(':memory:')
  seedSampleBook(store, pack, NOW)
  expect(openBook(store, { companyName: COMPANY, accountingStartMonth: '2026-01', replaceSampleBook: true })).toMatchObject({
    accepted: true,
  })
  return store
}

const bank = { 'settlement.method': 'bank' }

describe('开自己的账', () => {
  it('清样本账要老板同意；开了真账后不能再开', () => {
    const store = new BookStore(':memory:')
    seedSampleBook(store, pack, NOW)
    expect(openBook(store, { companyName: COMPANY, accountingStartMonth: '2026-01' })).toMatchObject({ code: 'CONFIRM_REQUIRED' })
    expect(openBook(store, { companyName: COMPANY, accountingStartMonth: '2026-01', replaceSampleBook: true })).toMatchObject({
      accepted: true,
    })
    expect(bookStatus(store)).toMatchObject({ company: COMPANY, isSampleBook: false, postedPeriods: [] })
    expect(openBook(store, { companyName: '另一家', accountingStartMonth: '2026-01', replaceSampleBook: true })).toMatchObject({
      code: 'BOOK_EXISTS',
    })
  })

  it('样本账里不能记账、导流水', () => {
    const store = new BookStore(':memory:')
    seedSampleBook(store, pack, NOW)
    expect(recordEntry(store, pack, { date: '2026-03-02', summary: 'x', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '1.00' } }, NOW)).toMatchObject({ code: 'SAMPLE_BOOK' })
    expect(importStatement(store, STATEMENT, NOW)).toMatchObject({ code: 'SAMPLE_BOOK' })
  })
})

describe('记账说明', () => {
  it('从会计包推出业务种类和每类要说清的事', () => {
    const all = postingGuide(pack.payload)
    expect(all).toMatchObject({ accepted: true })
    expect('eventKinds' in all && all.eventKinds).toContainEqual({ eventKind: 'office_supply', name: '买办公用品' })
    expect(postingGuide(pack.payload, 'office_supply')).toMatchObject({
      facts: { 'settlement.method': expect.arrayContaining(['bank', 'cash', 'unsettled']) },
      amountSources: ['invoice_total'],
      evidenceRoles: ['invoice'],
    })
    expect(postingGuide(pack.payload, 'nope')).toMatchObject({ code: 'UNKNOWN_EVENT_KIND' })
  })
})

describe('交票 → 交流水 → 问利润 → 结账', () => {
  it('走通 1 月', () => {
    const store = ownBook()
    expect(setOpeningBalances(store, pack, [], NOW)).toMatchObject({ accepted: true })

    // 交一张进货票：核票、试推、正式记。
    expect(checkInvoice(store, PURCHASE_INVOICE, NOW)).toMatchObject({
      recordable: true,
      direction: 'input',
      problems: [],
      amounts: { invoice_total: '1300.00' },
    })
    const office = { date: '2026-01-18', summary: '买 A4 复印纸', eventKind: 'office_supply', facts: bank, amounts: { invoice_total: '1300.00' }, invoiceNumber: PURCHASE_INVOICE.invoiceNumber }
    expect(recordEntry(store, pack, { ...office, preview: true }, NOW)).toMatchObject({
      preview: true,
      legs: [
        { side: '借', subjectName: '管理费用—办公费', amount: '1300.00' },
        { side: '贷', subjectCode: '1002', amount: '1300.00' },
      ],
    })
    expect(bookStatus(store)).toMatchObject({ postedPeriods: [] })
    expect(recordEntry(store, pack, office, NOW)).toMatchObject({ accepted: true, voucherNo: 'PZ-202601-001', missingEvidence: [] })
    expect(recordEntry(store, pack, office, NOW)).toMatchObject({ code: 'INVOICE_ALREADY_RECORDED' })

    // 交一份流水：自查通过后进账，逐行说清。
    const imported = importStatement(store, STATEMENT, NOW)
    expect(imported).toMatchObject({ accepted: true })
    const lines = 'lines' in imported ? imported.lines : []
    expect(lines.map((l) => l.amount)).toEqual(['100000.00', '-1300.00', '20200.00', '-10.00'])
    const [capitalLine, officeLine, saleLine, feeLine] = lines.map((l) => l.lineId) as [number, number, number, number]

    // 进货款先按发票记过了，流水挂上去，不再记第二遍；金额对不上的挂不上。
    expect(linkStatementLines(store, pack, { voucherNo: 'PZ-202601-001', statementLineIds: [feeLine] })).toMatchObject({
      code: 'STATEMENT_AMOUNT_MISMATCH',
    })
    expect(linkStatementLines(store, pack, { voucherNo: 'PZ-202601-001', statementLineIds: [officeLine] })).toMatchObject({ accepted: true })

    expect(
      recordEntry(store, pack, { date: '2026-01-05', summary: '股东实缴注册资本', eventKind: 'capital_contribution', facts: { ...bank, 'capital.nature': 'registeredCapital' }, amounts: { contract: '100000.00' }, evidenceRoles: ['contract'], statementLineIds: [capitalLine] }, NOW),
    ).toMatchObject({ accepted: true, missingEvidence: [] })
    expect(checkInvoice(store, SALE_INVOICE, NOW)).toMatchObject({
      recordable: true,
      direction: 'output',
      authenticity: expect.stringContaining('inv-veri.chinatax.gov.cn'),
    })
    expect(
      recordEntry(store, pack, { date: '2026-01-22', summary: '数据整理服务收入', eventKind: 'sale_service', facts: bank, amounts: { invoice_total: '20200.00', invoice_net: '20000.00', invoice_tax: '200.00' }, invoiceNumber: SALE_INVOICE.invoiceNumber, statementLineIds: [saleLine] }, NOW),
    ).toMatchObject({ accepted: true })
    // 金额和流水对不上的不记。
    expect(
      recordEntry(store, pack, { date: '2026-01-31', summary: '账户管理费', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '12.00' }, statementLineIds: [feeLine] }, NOW),
    ).toMatchObject({ code: 'STATEMENT_AMOUNT_MISMATCH' })
    expect(
      recordEntry(store, pack, { date: '2026-01-31', summary: '账户管理费', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '10.00' }, statementLineIds: [feeLine] }, NOW),
    ).toMatchObject({ accepted: true, voucherNo: 'PZ-202601-004' })

    // 问 1 月利润：收入 20000，办公费 1300 + 手续费 10。
    expect(readProfit(store, pack, '2026-01')).toMatchObject({
      month: { totals: { revenue: '20000.00', expense: '1310.00', profit: '18690.00' } },
    })

    // 问 1 月能不能结账：账都记了，差公司情况没登记。
    const first = closingCheck(store, pack, '2026-01', NOW)
    expect(first).toMatchObject({ canClose: false, atClose: ['损益结转'] })
    const failing = 'checks' in first ? first.checks.filter((c) => !c.passed) : []
    expect(failing.map((c) => c.check)).toEqual(['月末该做的计提、结转都做了'])
    const factKeys = [...new Set(failing[0]!.blockers.map((b) => ('factKey' in b ? b.factKey : '')))]
    expect(factKeys).toContain('entity.has_fixed_asset')
    expect(closePeriod(store, pack, '2026-01', NOW)).toMatchObject({ code: 'CLOSING_BLOCKED' })

    expect(setCompanyFacts(store, pack, Object.fromEntries(factKeys.map((k) => [k, 'no'])))).toMatchObject({ accepted: true })
    expect(closingCheck(store, pack, '2026-01', NOW)).toMatchObject({ canClose: true })

    // 结账：损益结转进本年利润，月份锁住。
    expect(closePeriod(store, pack, '2026-01', NOW)).toMatchObject({
      accepted: true,
      transferVouchers: ['PZ-202601-005'],
      profit: { profit: '18690.00' },
    })
    const balances = readBalances(store, '2026-01')
    const row = (code: string) => (balances.accepted ? balances.rows.find((r) => r.subjectCode === code) : undefined)
    expect(row('4103')).toMatchObject({ side: '贷', balance: '18690.00' })
    expect(row('1002')).toMatchObject({ side: '借', balance: '118890.00' })
    expect(row('6001')).toBeUndefined()
    expect(readProfit(store, pack, '2026-01')).toMatchObject({ month: { totals: { profit: '18690.00' } } })
    expect(
      recordEntry(store, pack, { date: '2026-01-31', summary: 'x', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '1.00' } }, NOW),
    ).toMatchObject({ code: 'PERIOD_LOCKED' })
    expect(closingCheck(store, pack, '2026-01', NOW)).toMatchObject({ locked: true })
    expect(voidVoucher(store, ['closing.pl_transfer'], { voucherNo: 'PZ-202601-001', reason: '结账后再改试试' }, NOW)).toMatchObject({ code: 'PERIOD_LOCKED' })
  })

  it('有流水没记账、没交流水的月份结不了账', () => {
    const store = ownBook()
    importStatement(store, STATEMENT, NOW)
    const report = closingCheck(store, pack, '2026-01', NOW)
    const funds = 'checks' in report ? report.checks.find((c) => c.check === '每笔流水都说清了是什么钱、记了账') : undefined
    expect(funds).toMatchObject({ passed: false })
    expect(funds!.blockers).toHaveLength(4)

    const other = ownBook()
    recordEntry(other, pack, { date: '2026-01-31', summary: '账户管理费', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '10.00' } }, NOW)
    const gaps = closingCheck(other, pack, '2026-01', NOW)
    expect('checks' in gaps && gaps.checks[0]).toMatchObject({
      passed: false,
      blockers: [{ kind: 'statement_gap', account: '银行账户（还没交过流水）', from: '2026-01-01', to: '2026-01-31' }],
    })
  })

  it('上个月没结账，这个月结不了', () => {
    const store = ownBook()
    const report = closingCheck(store, pack, '2026-02', new Date('2026-03-02T00:00:00Z'))
    expect('checks' in report && report.checks[5]).toMatchObject({
      passed: false,
      blockers: [{ kind: 'previous_period_open', periodKey: '2026-01' }],
    })
  })
})

describe('自查挡住坏材料', () => {
  it('流水余额接不上时整份不进账', () => {
    const store = ownBook()
    const broken = { ...STATEMENT, rows: STATEMENT.rows.map((r) => (r.rowNumber === 3 ? { ...r, amount: '20,000.00' } : r)) }
    expect(importStatement(store, broken, NOW)).toMatchObject({ code: 'STATEMENT_CHECK_FAILED' })
    expect(bookStatus(store)).toMatchObject({ statementLinesNotRecorded: 0 })
  })

  it('同一账户同一段流水不能导两次；换个写法、尾号撞上已有账户时先问清是不是同一张卡', () => {
    const store = ownBook()
    importStatement(store, STATEMENT, NOW)
    expect(importStatement(store, STATEMENT, NOW)).toMatchObject({ code: 'STATEMENT_OVERLAP' })
    expect(importStatement(store, { ...STATEMENT, accountRef: '招行8801' }, NOW)).toMatchObject({
      code: 'ACCOUNT_TAIL_AMBIGUOUS',
      details: { existing: ['招商银行 尾号 8801'] },
    })
    expect(importStatement(store, { ...STATEMENT, accountRef: '招商银行基本户' }, NOW)).toMatchObject({ code: 'ACCOUNT_TAIL_REQUIRED' })
    expect(bookStatus(store)).toMatchObject({ bankAccounts: ['招商银行 尾号 8801'] })
  })

  it('看不出流水开始前的账户余额时不进账', () => {
    const store = ownBook()
    const bare = {
      accountRef: STATEMENT.accountRef,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      rows: STATEMENT.rows.map(({ balanceAfter: _balance, ...row }) => row),
    }
    expect(importStatement(store, bare, NOW)).toMatchObject({ code: 'STATEMENT_OPENING_UNKNOWN' })
    expect(importStatement(store, { ...bare, printedOpeningBalance: '0.00' }, NOW)).toMatchObject({ accepted: true })
  })

  it('价税合计对不上的票不能记', () => {
    const store = ownBook()
    const result = checkInvoice(store, { ...PURCHASE_INVOICE, totalInclTax: '1310.00' }, NOW)
    expect(result).toMatchObject({ recordable: false })
    expect(recordEntry(store, pack, { date: '2026-01-18', summary: 'x', eventKind: 'office_supply', facts: bank, amounts: { invoice_total: '1310.00' }, invoiceNumber: PURCHASE_INVOICE.invoiceNumber }, NOW)).toMatchObject({
      code: 'INVOICE_NOT_CHECKED',
    })
  })

  it('填了但换算不出的金额、税率算读不清，不当票上没有', () => {
    const store = ownBook()
    expect(checkInvoice(store, { ...PURCHASE_INVOICE, totalInclTax: '一千三' }, NOW)).toMatchObject({ recordable: false, readability: 'unreadable' })
    expect(checkInvoice(store, { ...PURCHASE_INVOICE, taxAmount: '12,87元' }, NOW)).toMatchObject({ readability: 'partiallyUnreadable' })
    expect(checkInvoice(store, { ...PURCHASE_INVOICE, taxRate: '13' }, NOW)).toMatchObject({ readability: 'partiallyUnreadable' })
  })

  it('抬头不是咱们公司的票不能记', () => {
    const store = ownBook()
    expect(checkInvoice(store, { ...PURCHASE_INVOICE, buyerName: '别人家公司', buyerTaxId: '91330106MA2OTHER9X' }, NOW)).toMatchObject({
      recordable: false,
      direction: 'subjectMismatch',
    })
  })

  it('会计包里没有的记法照实拒绝', () => {
    const store = ownBook()
    expect(recordEntry(store, pack, { date: '2026-01-18', summary: 'x', eventKind: 'office_supply', facts: { 'settlement.method': 'barter' }, amounts: { invoice_total: '1.00' } }, NOW)).toMatchObject({
      code: 'LEDGER_NO_RULE_MATCHED',
    })
    expect(recordEntry(store, pack, { date: '2026-02-30', summary: 'x', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '1.00' } }, NOW)).toMatchObject({
      code: 'DATE_INVALID',
    })
  })
})

describe('作废凭证', () => {
  it('作废后不进余额，发票解开可重记，凭证号不复用；结了账的月份不能作废', () => {
    const store = ownBook()
    checkInvoice(store, PURCHASE_INVOICE, NOW)
    const office = { date: '2026-01-18', summary: '买 A4 复印纸', eventKind: 'office_supply', facts: { 'settlement.method': 'cash' }, amounts: { invoice_total: '1300.00' }, invoiceNumber: PURCHASE_INVOICE.invoiceNumber }
    expect(recordEntry(store, pack, office, NOW)).toMatchObject({ voucherNo: 'PZ-202601-001' })
    expect(voidVoucher(store, ['closing.pl_transfer'], { voucherNo: 'PZ-202601-001', reason: '短' }, NOW)).toMatchObject({ code: 'REASON_REQUIRED' })
    expect(voidVoucher(store, ['closing.pl_transfer'], { voucherNo: 'PZ-202601-001', reason: '付款方式记错，是银行付的' }, NOW)).toMatchObject({ voided: true })
    expect(bookStatus(store)).toMatchObject({ postedPeriods: [], invoicesNotRecorded: [{ invoiceNumber: PURCHASE_INVOICE.invoiceNumber }] })
    expect(recordEntry(store, pack, { ...office, facts: bank }, NOW)).toMatchObject({ voucherNo: 'PZ-202601-002' })
    const balances = readBalances(store, '2026-01')
    expect(balances.accepted && balances.rows.map((r) => r.subjectCode)).toEqual(['1002', '660201'])
    expect(voidVoucher(store, [], { voucherNo: 'PZ-202601-001', reason: '再作废一次试试' }, NOW)).toMatchObject({ code: 'VOUCHER_VOIDED' })
  })
})

describe('记账时的几道核对', () => {
  const office = { date: '2026-01-18', summary: '买 A4 复印纸', eventKind: 'office_supply', facts: bank, amounts: { invoice_total: '1300.00' }, invoiceNumber: PURCHASE_INVOICE.invoiceNumber }
  const FEB_STATEMENT = {
    accountRef: STATEMENT.accountRef,
    periodStart: '2026-02-01',
    periodEnd: '2026-02-02',
    rows: [{ rowNumber: 1, occurredAt: '2026-02-02', amount: '1,300.00', direction: '支出', counterpartyName: '杭州文渊办公用品有限公司', rawDescription: '货款', balanceAfter: '117,590.00' }],
  }

  it('金额和核过的票面对不上的不记', () => {
    const store = ownBook()
    checkInvoice(store, PURCHASE_INVOICE, NOW)
    expect(recordEntry(store, pack, { ...office, amounts: { invoice_total: '1280.00' } }, NOW)).toMatchObject({
      code: 'INVOICE_AMOUNT_MISMATCH',
      details: { invoice_total: { invoice: '1300.00', entry: '1280.00' } },
    })
    expect(recordEntry(store, pack, { ...office, amounts: { invoice_total: '1300.00' } }, NOW)).toMatchObject({ accepted: true })
  })

  it('别的月份的流水不能记进、挂到这个月的凭证', () => {
    const store = ownBook()
    checkInvoice(store, PURCHASE_INVOICE, NOW)
    const imported = importStatement(store, FEB_STATEMENT, NOW)
    const febLine = 'lines' in imported ? imported.lines[0]!.lineId : -1
    expect(recordEntry(store, pack, { ...office, statementLineIds: [febLine] }, NOW)).toMatchObject({ code: 'STATEMENT_LINE_OTHER_PERIOD' })
    expect(recordEntry(store, pack, office, NOW)).toMatchObject({ voucherNo: 'PZ-202601-001' })
    expect(linkStatementLines(store, pack, { voucherNo: 'PZ-202601-001', statementLineIds: [febLine] })).toMatchObject({
      code: 'STATEMENT_LINE_OTHER_PERIOD',
    })
  })

  it('还没到的日子不能先记，按北京时间算', () => {
    const store = ownBook()
    expect(recordEntry(store, pack, { date: '2026-02-10', summary: 'x', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '1.00' } }, NOW)).toMatchObject({
      code: 'DATE_IN_FUTURE',
    })
    expect(importStatement(store, { ...STATEMENT, periodStart: '2026-02-01', periodEnd: '2026-02-28', rows: [] }, NOW)).toMatchObject({
      code: 'PERIOD_FUTURE',
    })
    // UTC 还是 1 月 31 日，北京时间已经是 2 月 1 日凌晨。
    const midnight = new Date('2026-01-31T17:00:00Z')
    expect(closingCheck(store, pack, '2026-02', midnight)).not.toMatchObject({ code: 'PERIOD_FUTURE' })
    expect(recordEntry(store, pack, { date: '2026-02-01', summary: '账户管理费', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '1.00' } }, midnight)).toMatchObject({
      accepted: true,
    })
  })
})

describe('补挂凭据', () => {
  it('记账时缺的凭据后来能补上，只收缺的那几种；结了账不能再补', () => {
    const store = ownBook()
    expect(setOpeningBalances(store, pack, [], NOW)).toMatchObject({ accepted: true })
    const imported = importStatement(store, { ...STATEMENT, printedClosingBalance: '100000.00', rows: STATEMENT.rows.slice(0, 1) }, NOW)
    const capitalLine = 'lines' in imported ? imported.lines[0]!.lineId : -1
    const capital = recordEntry(store, pack, { date: '2026-01-05', summary: '股东实缴注册资本', eventKind: 'capital_contribution', facts: { ...bank, 'capital.nature': 'registeredCapital' }, amounts: { contract: '100000.00' }, statementLineIds: [capitalLine] }, NOW)
    expect(capital).toMatchObject({ voucherNo: 'PZ-202601-001', missingEvidence: ['contract'] })
    const report = closingCheck(store, pack, '2026-01', NOW)
    const evidence = 'checks' in report ? report.checks.find((c) => c.check === '每笔账该有的凭据都有') : undefined
    expect(evidence).toMatchObject({ passed: false, blockers: [{ kind: 'evidence_missing', voucherNo: 'PZ-202601-001', missing: ['合同'] }] })

    expect(addEvidence(store, { voucherNo: 'PZ-202601-001', roles: ['invoice'] })).toMatchObject({ code: 'ROLE_AUTOMATIC' })
    expect(addEvidence(store, { voucherNo: 'PZ-202601-001', roles: ['payroll_sheet'] })).toMatchObject({ code: 'ROLE_NOT_MISSING' })
    expect(addEvidence(store, { voucherNo: 'PZ-202601-009', roles: ['contract'] })).toMatchObject({ code: 'VOUCHER_NOT_FOUND' })
    expect(addEvidence(store, { voucherNo: 'PZ-202601-001', roles: ['contract'] })).toMatchObject({ accepted: true, added: ['contract'], missingEvidence: [] })
    const after = closingCheck(store, pack, '2026-01', NOW)
    expect('checks' in after && after.checks.find((c) => c.check === '每笔账该有的凭据都有')).toMatchObject({ passed: true })

    // 结账以后不能再补、再挂流水。
    const facts = 'checks' in after ? after.checks.flatMap((c) => c.blockers).flatMap((b) => ('factKey' in b ? [b.factKey] : [])) : []
    setCompanyFacts(store, pack, Object.fromEntries(facts.map((k) => [k, 'no'])))
    expect(closePeriod(store, pack, '2026-01', NOW)).toMatchObject({ accepted: true })
    expect(addEvidence(store, { voucherNo: 'PZ-202601-001', roles: ['contract'] })).toMatchObject({ code: 'PERIOD_LOCKED' })
    expect(linkStatementLines(store, pack, { voucherNo: 'PZ-202601-001', statementLineIds: [1] })).toMatchObject({ code: 'PERIOD_LOCKED' })
  })

  it('样本账不补、不挂', () => {
    const store = new BookStore(':memory:')
    seedSampleBook(store, pack, NOW)
    expect(addEvidence(store, { voucherNo: 'PZ-202601-001', roles: ['contract'] })).toMatchObject({ code: 'SAMPLE_BOOK' })
    expect(linkStatementLines(store, pack, { voucherNo: 'PZ-202601-001', statementLineIds: [1] })).toMatchObject({ code: 'SAMPLE_BOOK' })
  })
})

describe('期初余额与银行余额核对', () => {
  // 1 月流水只有一笔手续费，账户在建账前就有 50000 元。
  const JAN = {
    accountRef: '招商银行 尾号 8801',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    rows: [{ rowNumber: 1, occurredAt: '2026-01-31', amount: '10.00', direction: '支出', rawDescription: '账户管理费', balanceAfter: '49,990.00' }],
  }
  const OPENING = [
    { subjectCode: '1002', side: 'debit', amount: '50000.00' },
    { subjectCode: '4001', side: 'credit', amount: '50000.00' },
  ]
  const bankCheck = (report: ReturnType<typeof closingCheck>) =>
    'checks' in report ? report.checks.find((c) => c.check === '账上银行存款和银行流水的余额对得上') : undefined

  function janBook(): BookStore {
    const store = ownBook()
    const imported = importStatement(store, JAN, NOW)
    const line = 'lines' in imported ? imported.lines[0]!.lineId : -1
    recordEntry(store, pack, { date: '2026-01-31', summary: '账户管理费', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '10.00' }, statementLineIds: [line] }, NOW)
    return store
  }

  it('没录期初时账上银行存款对不上流水，挡住结账；录对了就过', () => {
    const store = janBook()
    expect(bookStatus(store)).toMatchObject({ openingBalancesEntered: false })
    expect(bankCheck(closingCheck(store, pack, '2026-01', NOW))).toMatchObject({
      passed: false,
      blockers: [
        {
          kind: 'bank_balance_mismatch',
          bookBalance: '-10.00',
          statementBalance: '49990.00',
          difference: '-50000.00',
          accounts: [{ account: '招商银行 尾号 8801', balance: '49990.00' }],
          openingBalancesEntered: false,
        },
      ],
    })

    expect(setOpeningBalances(store, pack, OPENING, NOW)).toMatchObject({
      accepted: true,
      balances: [
        { subjectCode: '1002', side: '借', balance: '50000.00' },
        { subjectCode: '4001', subjectName: '实收资本', side: '贷', balance: '50000.00' },
      ],
    })
    expect(bookStatus(store)).toMatchObject({ openingBalancesEntered: true })
    expect(bankCheck(closingCheck(store, pack, '2026-01', NOW))).toMatchObject({ passed: true, blockers: [] })
    const balances = readBalances(store, '2026-01')
    expect(balances.accepted && balances.rows.find((r) => r.subjectCode === '1002')).toMatchObject({ side: '借', balance: '49990.00' })
    // 期初不算进利润。
    expect(readProfit(store, pack, '2026-01')).toMatchObject({ month: { totals: { profit: '-10.00' } } })

    // 建账那个月结了账，期初不能再改。
    const report = closingCheck(store, pack, '2026-01', NOW)
    const facts = 'checks' in report ? report.checks.flatMap((c) => c.blockers).flatMap((b) => ('factKey' in b ? [b.factKey as string] : [])) : []
    setCompanyFacts(store, pack, Object.fromEntries(facts.map((k) => [k, 'no'])))
    expect(closePeriod(store, pack, '2026-01', NOW)).toMatchObject({ accepted: true })
    expect(setOpeningBalances(store, pack, [], NOW)).toMatchObject({ code: 'PERIOD_LOCKED' })
  })

  it('期初要借贷平衡，科目要在科目表里、不能是损益类；空列表表示录过了、全是零', () => {
    const store = ownBook()
    expect(setOpeningBalances(store, pack, [OPENING[0]!], NOW)).toMatchObject({
      code: 'OPENING_UNBALANCED',
      details: { debitTotal: '50000.00', creditTotal: '0.00', difference: '50000.00' },
    })
    expect(setOpeningBalances(store, pack, [...OPENING, { subjectCode: '9999', side: 'debit', amount: '1.00' }], NOW)).toMatchObject({ code: 'SUBJECT_UNKNOWN' })
    expect(setOpeningBalances(store, pack, [{ subjectCode: '1002', side: 'debit', amount: '1.00' }, { subjectCode: '6001', side: 'credit', amount: '1.00' }], NOW)).toMatchObject({
      code: 'SUBJECT_PROFIT_AND_LOSS',
    })
    expect(setOpeningBalances(store, pack, [OPENING[0]!, OPENING[0]!], NOW)).toMatchObject({ code: 'SUBJECT_REPEATED' })
    expect(setOpeningBalances(store, pack, [{ ...OPENING[0]!, side: '借' }, OPENING[1]!], NOW)).toMatchObject({ code: 'SIDE_INVALID' })
    expect(setOpeningBalances(store, pack, [{ ...OPENING[0]!, amount: '-50000.00' }, OPENING[1]!], NOW)).toMatchObject({ code: 'AMOUNT_INVALID' })
    expect(bookStatus(store)).toMatchObject({ openingBalancesEntered: false })
    expect(setOpeningBalances(store, pack, [], NOW)).toMatchObject({ accepted: true, balances: [] })
    expect(bookStatus(store)).toMatchObject({ openingBalancesEntered: true })

    const sample = new BookStore(':memory:')
    seedSampleBook(sample, pack, NOW)
    expect(setOpeningBalances(sample, pack, OPENING, NOW)).toMatchObject({ code: 'SAMPLE_BOOK' })
  })

  it('流水没交齐时先不核余额；旧版本导入、没记下余额的流水要说出来', () => {
    const store = ownBook()
    recordEntry(store, pack, { date: '2026-01-31', summary: '账户管理费', eventKind: 'bank_fee', facts: bank, amounts: { settlement: '10.00' } }, NOW)
    expect(bankCheck(closingCheck(store, pack, '2026-01', NOW))).toMatchObject({ passed: false, blockers: [{ kind: 'bank_balance_pending' }] })

    const path = join(mkdtempSync(join(tmpdir(), 'dsh-qianlai-')), 'book.sqlite')
    const file = new BookStore(path)
    seedSampleBook(file, pack, NOW)
    openBook(file, { companyName: COMPANY, accountingStartMonth: '2026-01', replaceSampleBook: true })
    importStatement(file, JAN, NOW)
    const raw = new DatabaseSync(path)
    raw.exec('UPDATE statement_import SET opening_balance_cents = NULL')
    raw.close()
    expect(bankCheck(closingCheck(file, pack, '2026-01', NOW))).toMatchObject({
      passed: false,
      blockers: [{ kind: 'statement_balance_unknown', account: '招商银行 尾号 8801' }],
    })
    file.close()
  })

  it('两张尾号相同的卡：原来那张改成多几位卡号的写法，新卡也写多几位，就分得开', () => {
    const store = ownBook()
    importStatement(store, JAN, NOW)
    const icbc = { ...JAN, accountRef: '工商银行 尾号 8801', rows: [{ ...JAN.rows[0]!, balanceAfter: '990.00' }] }
    expect(importStatement(store, icbc, NOW)).toMatchObject({ code: 'ACCOUNT_TAIL_AMBIGUOUS' })

    expect(renameBankAccount(store, { accountRef: '招行 8801', newAccountRef: '招商银行 尾号 628801' })).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' })
    expect(renameBankAccount(store, { accountRef: '招商银行 尾号 8801', newAccountRef: '招商银行 尾号 628802' })).toMatchObject({ code: 'ACCOUNT_DIGITS_CHANGED' })
    expect(renameBankAccount(store, { accountRef: '招商银行 尾号 8801', newAccountRef: '招商银行 尾号 628801' })).toMatchObject({
      accepted: true,
      bankAccounts: ['招商银行 尾号 628801'],
    })
    // 新卡只写 4 位，仍然是原来那张卡的结尾，分不开。
    expect(importStatement(store, icbc, NOW)).toMatchObject({ code: 'ACCOUNT_TAIL_AMBIGUOUS' })
    expect(importStatement(store, { ...icbc, accountRef: '工商银行 尾号 518801' }, NOW)).toMatchObject({ accepted: true })
    expect(bookStatus(store)).toMatchObject({ bankAccounts: ['招商银行 尾号 628801', '工商银行 尾号 518801'] })
    // 改了名，以前导的那段流水跟着走，同一段日期照样不能再导。
    expect(importStatement(store, { ...JAN, accountRef: '招商银行 尾号 628801' }, NOW)).toMatchObject({ code: 'STATEMENT_OVERLAP' })
  })
})
