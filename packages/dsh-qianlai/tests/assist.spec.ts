import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { bookStatus, openBook, setCompanyFacts, setOpeningBalances } from '../src/book.js'
import { closePeriod, closingCheck } from '../src/closing.js'
import { quarterFilingPrep, upcomingDeadlines } from '../src/deadlines.js'
import { recordEntry, reverseVoucher } from '../src/entries.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import { readProfit, readStatements } from '../src/reports.js'
import { exportReviewPack } from '../src/review-pack.js'
import { seedSampleBook } from '../src/sample-book.js'
import { importStatement } from '../src/statements.js'
import { BookStore } from '../src/store.js'

// 企业、发票全部是编的。
const NOW = new Date('2026-02-03T08:00:00Z')
const COMPANY = '杭州青禾数据服务有限公司'
const pack = loadPack()
const cash = { 'settlement.method': 'cash' }
const TRANSFER = ['closing.pl_transfer']

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

/** 1 月：期初 5000 现金（实收资本），现金买复印纸、开票卖服务（客户还没付），没有银行收付。 */
function januaryBook(): BookStore {
  const store = new BookStore(':memory:')
  seedSampleBook(store, pack, NOW)
  openBook(store, { companyName: COMPANY, accountingStartMonth: '2026-01', replaceSampleBook: true })
  setOpeningBalances(
    store,
    pack,
    [
      { subjectCode: '1001', side: 'debit', amount: '5000.00' },
      { subjectCode: '4001', side: 'credit', amount: '5000.00' },
    ],
    NOW,
  )
  checkInvoice(store, PURCHASE_INVOICE, NOW)
  checkInvoice(store, SALE_INVOICE, NOW)
  expect(
    recordEntry(store, pack, { date: '2026-01-18', summary: '买 A4 复印纸', eventKind: 'office_supply', facts: cash, amounts: { invoice_total: '1300.00' }, invoiceNumber: PURCHASE_INVOICE.invoiceNumber }, NOW),
  ).toMatchObject({ voucherNo: 'PZ-202601-001' })
  expect(
    recordEntry(
      store,
      pack,
      { date: '2026-01-22', summary: '数据整理服务收入', eventKind: 'sale_service', facts: { 'settlement.method': 'unsettled' }, amounts: { invoice_total: '20200.00', invoice_net: '20000.00', invoice_tax: '200.00' }, invoiceNumber: SALE_INVOICE.invoiceNumber },
      NOW,
    ),
  ).toMatchObject({ voucherNo: 'PZ-202601-002' })
  return store
}

function closeJanuary(store: BookStore) {
  const report = closingCheck(store, pack, '2026-01', NOW)
  const facts = 'checks' in report ? report.checks.flatMap((c) => c.blockers).flatMap((b) => ('factKey' in b ? [b.factKey as string] : [])) : []
  setCompanyFacts(store, pack, Object.fromEntries(facts.map((k) => [k, 'no'])))
  expect(closePeriod(store, pack, '2026-01', NOW)).toMatchObject({ accepted: true })
}

describe('报表', () => {
  it('样本账的资产负债表两边相等，没结账的利润并进未分配利润', () => {
    const store = new BookStore(':memory:')
    seedSampleBook(store, pack, NOW)
    const march = readStatements(store, pack, '2026-03')
    expect(march).toMatchObject({
      balanceSheet: { assetsTotal: '485259.10', liabilitiesAndEquityTotal: '485259.10', balanced: true, unclosedProfitInRetained: '183359.10' },
      profit: { yearToDate: { totals: { profit: '183359.10' } } },
    })
  })

  it('含期初余额；结账以后利润已经转进权益，不再单列', () => {
    const store = januaryBook()
    const open = readStatements(store, pack, '2026-01')
    expect(open).toMatchObject({ balanceSheet: { balanced: true, assetsTotal: '23900.00', unclosedProfitInRetained: '18700.00' } })
    closeJanuary(store)
    const closed = readStatements(store, pack, '2026-01')
    expect(closed).toMatchObject({ balanceSheet: { balanced: true, assetsTotal: '23900.00' } })
    expect(closed.accepted && 'unclosedProfitInRetained' in closed.balanceSheet).toBe(false)
    expect(closed.accepted && closed.balanceSheet.assets).toEqual([
      { lineName: '货币资金', amount: '3700.00' },
      { lineName: '应收账款', amount: '20200.00' },
    ])
  })

  it('账上没有的月份照实拒绝', () => {
    expect(readStatements(januaryBook(), pack, '2026-02')).toMatchObject({ code: 'PERIOD_NOT_POSTED' })
  })
})

describe('接下来要办的事', () => {
  const OCT_25 = new Date('2026-10-25T02:00:00Z')

  it('报税日期取会计包期限表里的那一期，带出处；表外的按常规推算并注明', () => {
    const store = januaryBook()
    const result = upcomingDeadlines(store, pack, OCT_25)
    const items = result.accepted ? result.items : []
    expect(items.find((i) => i.deadlineId === 'vat.quarterly')).toMatchObject({
      period: '2026-Q3',
      dueDate: '2026-10-26',
      daysLeft: 1,
      basis: { document: expect.stringContaining('税总') },
      done: null,
    })
    expect(items.find((i) => i.deadlineId === 'cit.annual')).toMatchObject({ period: '2026', dueDate: '2027-05-31', estimated: expect.any(String) })
  })

  it('建账以来没结的月份报成逾期；结了就往后走', () => {
    const store = januaryBook()
    const before = upcomingDeadlines(store, pack, NOW)
    expect(before.accepted && before.items.find((i) => i.deadlineId === 'period_close.monthly')).toMatchObject({
      period: '2026-01',
      dueDate: '2026-02-05',
      done: false,
    })
    closeJanuary(store)
    const later = upcomingDeadlines(store, pack, new Date('2026-03-10T02:00:00Z'))
    expect(later.accepted && later.items.find((i) => i.deadlineId === 'period_close.monthly')).toMatchObject({
      period: '2026-02',
      dueDate: '2026-03-05',
      daysLeft: -5,
      done: false,
    })
  })

  it('账本现状里带上 10 天内到期还没办的事', () => {
    const status = bookStatus(januaryBook(), { pack, now: new Date('2026-04-12T02:00:00Z') })
    expect(status).toMatchObject({ dueSoon: expect.arrayContaining([expect.objectContaining({ title: '季度报税（增值税及附加）', dueDate: '2026-04-20', daysLeft: 8 })]) })
  })
})

describe('季度申报准备单', () => {
  it('同一税率的百分数和小数归到同一档，零税额保留为零', () => {
    const store = januaryBook()
    for (const [invoiceNumber, taxRate, taxAmount, totalInclTax, totalInWords] of [
      ['26330000000087654322', '0.010', '200.00', '20200.00', '贰万零贰佰圆整'],
      ['26330000000087654323', '0%', '0.00', '20000.00', '贰万圆整'],
    ] as const) {
      expect(checkInvoice(store, { ...SALE_INVOICE, invoiceNumber, taxRate, taxAmount, totalInclTax, totalInWords }, NOW)).toMatchObject({ recordable: true })
    }
    expect(quarterFilingPrep(store, pack, '2026-Q1', NOW)).toMatchObject({
      outputInvoices: [
        { taxRate: '1%', count: 2, amountExclTax: '40000.00', tax: '400.00' },
        { taxRate: '0%', count: 1, amountExclTax: '20000.00', tax: '0.00' },
      ],
      invoicedAmountExclTax: '60000.00',
    })
  })

  it('区分不确定金额和真零；已有票的不可读标记优先于候选数字', () => {
    const store = januaryBook()
    const invoiceNumber = '26330000000087654322'
    const partial = { ...SALE_INVOICE, invoiceNumber, unreadable: ['amountExclTax', 'taxAmount', 'taxRate'] }
    expect(checkInvoice(store, partial, NOW)).toMatchObject({ recordable: true })
    expect(quarterFilingPrep(store, pack, '2026-Q1', NOW)).toMatchObject({
      outputInvoices: [{ amountExclTax: '20000.00', tax: '200.00' }, { taxRate: '未读到税率', amountExclTax: null, tax: null }],
      incompleteInvoices: [{ invoiceNumber, fields: ['amountExclTax', 'taxAmount', 'taxRate'] }],
      invoicedAmountExclTax: null, revenueMinusInvoiced: null,
    })
    store.saveInvoice({
      invoiceNumber, issueDate: partial.issueDate, direction: 'output', counterparty: null, totalCents: 2020000n,
      facts: { ...partial, unreadable: ['taxAmountCents'] }, now: NOW,
    })
    expect(quarterFilingPrep(store, pack, '2026-Q1', NOW)).toMatchObject({
      outputInvoices: [{ taxRate: '1%', count: 2, amountExclTax: '40000.00', tax: null }],
      incompleteInvoices: [{ invoiceNumber, fields: ['taxAmount'] }],
      invoicedAmountExclTax: '40000.00', revenueMinusInvoiced: '-20000.00',
    })
  })

  it('汇总销项发票与账上收入，只给数不算税', () => {
    const store = januaryBook()
    const prep = quarterFilingPrep(store, pack, '2026-Q1', new Date('2026-04-02T02:00:00Z'))
    expect(prep).toMatchObject({
      dueDate: '2026-04-20',
      revenueOnBooks: '20000.00',
      outputInvoices: [{ taxRate: '1%', count: 1, amountExclTax: '20000.00', tax: '200.00' }],
      revenueMinusInvoiced: '0.00',
      warnings: ['这个季度还有月份没结账，数字可能还会变。'],
      reminder: expect.stringContaining('不是申报表'),
    })
    expect(quarterFilingPrep(store, pack, '2026Q1', NOW)).toMatchObject({ code: 'QUARTER_INVALID' })
    expect(quarterFilingPrep(store, pack, '2026-Q2', NOW)).toMatchObject({ code: 'PERIOD_FUTURE' })
  })

  it('结了账的月份，收入照算，不被损益结转抵掉', () => {
    const store = januaryBook()
    closeJanuary(store)
    const prep = quarterFilingPrep(store, pack, '2026-Q1', new Date('2026-04-02T02:00:00Z'))
    expect(prep).toMatchObject({
      months: [{ month: '2026-01', closed: true, revenueOnBooks: '20000.00' }, { month: '2026-02' }, { month: '2026-03' }],
      revenueOnBooks: '20000.00',
      revenueMinusInvoiced: '0.00',
    })
  })
})

describe('复核包', () => {
  it('导出报表、凭证、余额、流水、发票、待处理事项，Excel 能直接打开', () => {
    const store = januaryBook()
    const root = mkdtempSync(join(tmpdir(), 'dsh-qianlai-export-'))
    const result = exportReviewPack(store, pack, '2026-01', root, NOW)
    expect(result).toMatchObject({ accepted: true, files: expect.arrayContaining(['0-说明.txt', '3-凭证.csv', '6-发票.csv']) })
    const dir = result.accepted ? result.dir : ''
    expect(readdirSync(dir)).toHaveLength(8)
    const vouchers = readFileSync(join(dir, '3-凭证.csv'), 'utf8')
    expect(vouchers.startsWith('\uFEFF凭证号,')).toBe(true)
    expect(vouchers).toContain('PZ-202601-001')
    expect(readFileSync(join(dir, '6-发票.csv'), 'utf8')).toContain('未查验')
    expect(readFileSync(join(dir, '7-还没处理完的事.csv'), 'utf8')).toContain('公司情况没登记')
    expect(readFileSync(join(dir, '1-资产负债表.csv'), 'utf8')).toContain('资产合计,23900.00')
  })

  it('流水里写成公式的文字导出时当文字，金额照常是数字', () => {
    const store = januaryBook()
    const imported = importStatement(
      store,
      {
        accountRef: '招商银行 尾号 1234',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        printedOpeningBalance: '1000.00',
        rows: [{ rowNumber: 1, occurredAt: '2026-01-25', amount: '-300.00', counterpartyName: '=HYPERLINK("http://example.com","点我")', rawDescription: '@SUM(A1)', balanceAfter: '700.00' }],
      },
      NOW,
    )
    expect(imported).toMatchObject({ accepted: true })
    const result = exportReviewPack(store, pack, '2026-01', mkdtempSync(join(tmpdir(), 'dsh-qianlai-export-')), NOW)
    const lines = readFileSync(join(result.accepted ? result.dir : '', '5-银行流水.csv'), 'utf8')
    expect(lines).toContain(`2026-01-25,-300.00,"'=HYPERLINK(""http://example.com"",""点我"")",'@SUM(A1),`)
  })
})

describe('结账以后更正', () => {
  it('在没结账的月份冲销原凭证，再带 correctsVoucherNo 记对的那一笔；原月份不动', () => {
    const store = januaryBook()
    closeJanuary(store)
    const reason = '复印纸其实是 1200 元的票，记成了别的金额'

    expect(reverseVoucher(store, pack, TRANSFER, { voucherNo: 'PZ-202601-003', date: '2026-02-03', reason }, NOW)).toMatchObject({ code: 'NOT_REVERSIBLE' })
    expect(reverseVoucher(store, pack, TRANSFER, { voucherNo: 'PZ-202601-001', date: '2026-01-31', reason }, NOW)).toMatchObject({ code: 'PERIOD_LOCKED' })
    expect(reverseVoucher(store, pack, TRANSFER, { voucherNo: 'PZ-202601-001', date: '2026-02-03', reason: '短' }, NOW)).toMatchObject({ code: 'REASON_REQUIRED' })
    expect(
      recordEntry(store, pack, { date: '2026-02-03', summary: 'x', eventKind: 'office_supply', facts: cash, amounts: { invoice_total: '1300.00' }, correctsVoucherNo: 'PZ-202601-001' }, NOW),
    ).toMatchObject({ code: 'NOT_REVERSED' })

    expect(reverseVoucher(store, pack, TRANSFER, { voucherNo: 'PZ-202601-001', date: '2026-02-03', reason }, NOW)).toMatchObject({
      voucherNo: 'PZ-202602-001',
      reverses: 'PZ-202601-001',
      legs: [
        { side: '贷', subjectName: '管理费用—办公费', amount: '1300.00' },
        { side: '借', subjectCode: '1001', amount: '1300.00' },
      ],
    })
    expect(reverseVoucher(store, pack, TRANSFER, { voucherNo: 'PZ-202601-001', date: '2026-02-03', reason }, NOW)).toMatchObject({ code: 'ALREADY_REVERSED' })

    // 同一张发票可以再带上，凭据照算，发票仍挂在原凭证上。
    const corrected = recordEntry(
      store,
      pack,
      { date: '2026-02-03', summary: '更正：买 A4 复印纸', eventKind: 'office_supply', facts: cash, amounts: { invoice_total: '1300.00' }, invoiceNumber: PURCHASE_INVOICE.invoiceNumber, correctsVoucherNo: 'PZ-202601-001' },
      NOW,
    )
    expect(corrected).toMatchObject({ voucherNo: 'PZ-202602-002', correctsVoucherNo: 'PZ-202601-001', missingEvidence: [] })
    expect(bookStatus(store)).toMatchObject({ invoicesNotRecorded: [] })
    expect(
      recordEntry(store, pack, { date: '2026-02-03', summary: 'x', eventKind: 'office_supply', facts: cash, amounts: { invoice_total: '1300.00' }, correctsVoucherNo: 'PZ-202601-001' }, NOW),
    ).toMatchObject({ code: 'ALREADY_CORRECTED' })

    // 1 月的利润不变；2 月冲销与更正相抵。
    expect(readProfit(store, pack, '2026-01')).toMatchObject({ month: { totals: { profit: '18700.00' } } })
    expect(readProfit(store, pack, '2026-02')).toMatchObject({ month: { totals: { profit: '0.00' } } })
    // 还没结账的月份不用冲销，作废重记。
    expect(reverseVoucher(store, pack, TRANSFER, { voucherNo: 'PZ-202602-002', date: '2026-02-03', reason }, NOW)).toMatchObject({ code: 'PERIOD_OPEN' })
  })
})
