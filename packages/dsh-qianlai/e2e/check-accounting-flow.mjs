// After pnpm build: node packages/dsh-qianlai/e2e/check-accounting-flow.mjs
// Runs the built plugin's registered tools with a synthetic host and one-time approval.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'qianlai-accounting-'))
const previousHome = process.env.DSH_HOME
const tools = new Map()
const session = { id: randomUUID() }
const period = { periodKey: '2026-01' }
const companyName = '合成主流程服务企业'
let dispose

async function call(name, args) {
  const exec = { callId: randomUUID(), agent: { session }, signal: new AbortController().signal }
  return tools.get('moneycome_' + name).execute(args, exec)
}
async function ok(name, args) {
  const result = await call(name, args)
  assert.equal(result.accepted, true, name + ' ' + JSON.stringify(result))
  return result
}

try {
  process.env.DSH_HOME = home
  apply({
    effect(fn) { dispose = fn() },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    get(name) { if (name === 'approval') return { request: async () => 'allowed-once' } },
  })
  await ok('open_book', { companyName, accountingStartMonth: period.periodKey, replaceSampleBook: true })
  await ok('set_opening_balances', { balances: [
    { subjectCode: '1002', side: 'debit', amount: '1000.00' },
    { subjectCode: '4001', side: 'credit', amount: '1000.00' },
  ] })

  const day = '2026-01-18'
  const invoiceNumber = '26000000000123456789'
  await ok('check_invoice', { invoiceNumber, issueDate: day, sellerName: companyName, buyerName: '合成客户',
    amountExclTax: '100.00', taxAmount: '1.00', totalInclTax: '101.00', taxRate: '1%' })
  const facts = { 'settlement.method': 'bank' }
  const saleInput = { date: day, summary: '合成服务收入', eventKind: 'sale_service', facts,
    invoiceNumber, amounts: { invoice_total: '101.00', invoice_net: '100.00', invoice_tax: '1.00' } }
  await ok('record_entry', { ...saleInput, preview: true })
  assert.deepEqual((await ok('list_vouchers', period)).vouchers, [])
  const sale = await ok('record_entry', saleInput)
  const statement = await ok('import_statement', {
    accountRef: '合成收款账户 尾号 5678', periodStart: '2026-01-01', periodEnd: '2026-01-31',
    printedPeriodStart: '2026-01-01', printedPeriodEnd: '2026-01-31',
    printedOpeningBalance: '1000.00', printedClosingBalance: '1091.00',
    rows: [
      { rowNumber: 1, occurredAt: day, direction: '收入', amount: '101.00', balanceAfter: '1101.00' },
      { rowNumber: 2, occurredAt: day, direction: '支出', amount: '10.00', balanceAfter: '1091.00' },
    ],
  })
  await ok('link_statement', { voucherNo: sale.voucherNo, statementLineIds: [statement.lines[0].lineId] })
  const fee = { date: day, summary: '合成银行手续费', eventKind: 'bank_fee', facts, amounts: { settlement: '10.00' } }
  const charge = await ok('record_entry', { ...fee, statementLineIds: [statement.lines[1].lineId] })
  assert.deepEqual((await ok('list_vouchers', period)).vouchers.map(v => v.voucherNo), [sale.voucherNo, charge.voucherNo])
  assert.deepEqual((await ok('unrecorded_statement_lines', period)).lines, [])

  const expectedProfit = { revenue: '100.00', expense: '10.00', profit: '90.00' }
  const { checks } = await ok('closing_check', period)
  // This fictional service company has none of the conditional month-end activities.
  const factsToConfirm = checks.flatMap(check => check.blockers).filter(blocker => blocker.kind === 'entity_fact_unknown')
  await ok('set_company_facts', { facts: Object.fromEntries(factsToConfirm.map(blocker => [blocker.factKey, 'no'])) })
  assert.equal((await ok('closing_check', period)).canClose, true)
  assert.deepEqual((await ok('close_period', period)).profit, expectedProfit)
  assert.equal((await call('record_entry', fee)).code, 'PERIOD_LOCKED')
  assert.deepEqual((await ok('read_profit', period)).month.totals, expectedProfit)
  const { balanceSheet } = await ok('financial_statements', period)
  assert.equal(balanceSheet.balanced, true)
  assert.equal(balanceSheet.assetsTotal, '1091.00')
  assert.equal(balanceSheet.liabilitiesAndEquityTotal, '1091.00')

  const { dir, files } = await ok('export_review_pack', period)
  assert.deepEqual(readdirSync(dir).sort(), [...files].sort())
  const exported = name => readFileSync(join(dir, name), 'utf8')
  assert.match(exported('2-利润表.csv'), /利润,90\.00,90\.00/)
  for (const voucherNo of [sale.voucherNo, charge.voucherNo]) {
    assert.ok(exported('3-凭证.csv').includes(voucherNo))
    assert.ok(exported('5-银行流水.csv').includes(voucherNo))
  }
  const reverseFee = { voucherNo: charge.voucherNo, date: '2026-02-01', reason: '合成测试：手续费需重新归类', intent: 'correct' }
  assert.equal((await call('reverse_voucher', reverseFee)).accepted, false)
  await ok('reverse_voucher', { ...reverseFee, replacementPeriod: '2026-02' })
  const february = await ok('closing_check', { periodKey: '2026-02' })
  assert.ok(february.checks.flatMap(check => check.blockers).some(blocker =>
    blocker.kind === 'correction_pending' && blocker.originalVoucherNo === charge.voucherNo))
  console.log(`PASS 2 business vouchers, profit 90.00, assets 1091.00, period locked, ${files.length} review files`)
} finally {
  dispose?.()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
}
