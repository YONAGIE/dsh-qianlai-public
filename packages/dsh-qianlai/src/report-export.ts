import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { formatCents, parseAmountToCents } from '@moneycome/fintax-core'
import type * as SheetJS from 'xlsx'

import { readBalances } from './balances.js'
import { closingCheck } from './closing.js'
import { listVouchers, packParameter, recordEntry } from './entries.js'
import type { LoadedPack } from './pack.js'
import { monthRange, PERIOD_KEY, refuse } from './period.js'
import { readProfit, readStatements } from './reports.js'
import type { BookStore, ReportArtifact } from './store.js'

export const REPORT_TITLES = {
  financial: '月度财务报表',
  'ledger-review': '账务明细',
} as const

export type ReportKind = keyof typeof REPORT_TITLES
type Cell = string | number | null
type Table = { name: string; rows: Cell[][] }
const require = createRequire(import.meta.url)
export const REPORT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const MAX_REPORT_BYTES = 8 * 1024 * 1024

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && Object.hasOwn(REPORT_TITLES, value)
}

function amount(value: string): number | string {
  // Excel stores 15 significant digits. Preserve larger ledger amounts as exact text.
  return value.replace(/\D/g, '').length <= 15 ? Number(value) : value
}

function reportBlocker(store: BookStore, pack: LoadedPack, periodKey: string, now: Date) {
  const check = closingCheck(store, pack, periodKey, now)
  if (!check.accepted) return check
  if (check.locked) return undefined
  const matter = store.reportPendingMatter(periodKey)
  if (matter) return refuse('REPORT_PREP_REQUIRED', `「${matter.title}」还缺${matter.missing.join('、')}。`, {
    periodKey, blocker: { kind: 'matter_missing', matterId: matter.id, missing: matter.missing },
  })
  const finalizationOnly = new Set(['period_not_ended', 'bank_balance_pending', 'previous_period_open'])
  const pending = 'checks' in check ? check.checks.flatMap(row => row.blockers.map(b => b as Record<string, unknown>)) : []
  const blocker = pending.find(b => ['unexplained_transaction', 'evidence_missing'].includes(String(b.kind)))
    ?? pending.find(b => !finalizationOnly.has(String(b.kind)))
  if (blocker?.kind === 'unexplained_transaction')
    return refuse('REPORT_PREP_REQUIRED', '有一笔银行流水还需要核对用途并记账。', { periodKey, blocker })
  if (blocker?.kind === 'evidence_missing')
    return refuse('REPORT_PREP_REQUIRED', '有一张凭证还缺材料。请先补齐该笔业务的材料，再生成本月报表。', { periodKey, blocker })
  if (!store.vouchers({ periodKey }).some(row => !row.voided))
    return refuse('REPORT_NO_BUSINESS', '本月还没有已记账业务。请先发送一份本月的业务材料，或确认本月确实无业务后完成月结。', { periodKey })
  if (blocker) return refuse('REPORT_PREP_REQUIRED', '本月还有一项需要核对。处理后可继续生成这个月的报表。', { periodKey, blocker })
  return undefined
}

function financialTables(store: BookStore, pack: LoadedPack, month: string): Table[] | undefined {
  const report = readStatements(store, pack, month)
  if (!report.accepted || !report.balanceSheet.balanced || report.balanceSheet.subjectsNotInReport?.length || !report.profit)
    return undefined
  const balance = report.balanceSheet
  const { month: current, yearToDate } = report.profit
  const lines = new Set([...current.lines, ...yearToDate.lines].map(line => line.lineName))
  const value = (list: typeof current.lines, name: string) => amount(list.find(line => line.lineName === name)?.amount ?? '0.00')
  return [
    { name: '资产负债表', rows: [
      ['资产', '余额（元）', '负债和所有者权益', '余额（元）'],
      ...Array.from({ length: Math.max(balance.assets.length, balance.liabilitiesAndEquity.length) }, (_, index) => {
        const left = balance.assets[index]
        const right = balance.liabilitiesAndEquity[index]
        return [left?.lineName ?? null, left ? amount(left.amount) : null, right?.lineName ?? null, right ? amount(right.amount) : null]
      }),
      ['资产合计', amount(balance.assetsTotal), '负债和所有者权益合计', amount(balance.liabilitiesAndEquityTotal)],
    ] },
    { name: '利润表', rows: [
      ['项目', '本月（元）', '本年累计（元）'],
      ...[...lines].map(name => [name, value(current.lines, name), value(yearToDate.lines, name)]),
      ...(current.totals && yearToDate.totals ? [
        ['收入合计', amount(current.totals.revenue), amount(yearToDate.totals.revenue)],
        ['费用合计', amount(current.totals.expense), amount(yearToDate.totals.expense)],
        ['利润', amount(current.totals.profit), amount(yearToDate.totals.profit)],
      ] : []),
    ] },
  ]
}

function ledgerTables(store: BookStore, month: string): Table[] {
  const balances = readBalances(store, month)
  return [
    { name: '凭证', rows: [
      ['凭证号', '日期', '摘要', '借贷', '科目', '金额（元）'],
      ...listVouchers(store, month).flatMap(voucher => voucher.legs.map(leg => [
        voucher.voucherNo, voucher.date, voucher.summary, leg.side, leg.subjectName, amount(leg.amount),
      ])),
    ] },
    { name: '科目余额', rows: [
      ['科目代码', '科目名称', '方向', '余额（元）'],
      ...(balances.accepted ? balances.rows.map(row => [row.subjectCode, row.subjectName, row.side, amount(row.balance)]) : []),
    ] },
    { name: '银行流水', rows: [
      ['账户', '日期', '对方', '摘要', '收支金额（元）', '对应凭证'],
      ...store.statementLines(monthRange(month)).map(line => [line.accountRef, line.occurredOn, line.counterparty,
        line.description, amount(formatCents(line.signedCents)), line.voucherNo]),
    ] },
    { name: '发票', rows: [
      ['号码', '开票日期', '方向', '对方', '价税合计（元）', '对应凭证'],
      ...store.invoices(monthRange(month)).map(invoice => [invoice.invoiceNumber, invoice.issueDate,
        invoice.direction === 'input' ? '进项' : '销项', invoice.counterparty,
        invoice.totalCents === null ? null : amount(formatCents(invoice.totalCents)), invoice.voucherNo]),
    ] },
  ]
}

function prepareReport(store: BookStore, pack: LoadedPack, periodKey: string, kind: ReportKind, now: Date) {
  const company = store.company()
  if (!company) return refuse('NO_BOOK', '请先建立企业账本。')
  if (!PERIOD_KEY.test(periodKey)) return refuse('PERIOD_INVALID', '请选择一个月份。')
  if (kind === 'financial') {
    const blocker = reportBlocker(store, pack, periodKey, now)
    if (blocker) return blocker
  }
  const checked = readBalances(store, periodKey)
  if (!checked.accepted) return checked
  const tables = kind === 'financial' ? financialTables(store, pack, periodKey) : ledgerTables(store, periodKey)
  if (!tables) return refuse('REPORT_REVIEW_REQUIRED', '报表有余额未归类或没有平衡，请先核对该月账项。', { periodKey })
  const historical = periodKey < company.accountingStartMonth && store.historicalOpening(periodKey)
  const phase = historical ? '历史补账已核对' : store.lockedPeriods().includes(periodKey) ? '已结账' : '未结账，供会计核对'
  const fingerprint = createHash('sha256').update(JSON.stringify([company.name, company.isSample, periodKey, kind, phase, tables])).digest('hex')
  return { accepted: true as const, kind, periodKey, companyName: company.name, isSample: company.isSample, phase, fingerprint, tables }
}

export function listReports(store: BookStore, periodKey: string, kind: ReportKind, version?: number) {
  if (!store.company()) return refuse('NO_BOOK', '请先建立企业账本。')
  if (!PERIOD_KEY.test(periodKey)) return refuse('PERIOD_INVALID', '请选择一个月份。')
  const versions = store.reportArtifacts(periodKey, kind, version)
  return { accepted: true as const, periodKey, kind, title: REPORT_TITLES[kind], versions,
    message: versions.length ? '可以下载这个月份的已生成文件。' : '这个月份还没有生成这类文件。' }
}

export function previewReport(store: BookStore, pack: LoadedPack, periodKey: string, kind: ReportKind, now: Date) {
  const prepared = prepareReport(store, pack, periodKey, kind, now)
  if (!prepared.accepted) {
    const details = prepared.details as { blocker?: { kind?: string } } | undefined
    const upload = prepared.code === 'REPORT_NO_BUSINESS' || ['evidence_missing', 'statement_gap', 'statement_balance_unknown', 'matter_missing']
      .includes(details?.blocker?.kind ?? '')
    return { ...prepared, periodKey, kind, title: REPORT_TITLES[kind], ...(upload ? { nextAction: 'upload' } : {}) }
  }
  const { companyName, isSample, phase, fingerprint } = prepared
  return { accepted: true as const, periodKey, kind, title: REPORT_TITLES[kind], companyName, isSample, phase, fingerprint,
    versions: store.reportArtifacts(periodKey, kind) }
}

function createWorkbook(company: string, periodKey: string, title: string, version: number, status: string, isSample: boolean, tables: Table[]) {
  const xlsx = require('../lib/vendor/xlsx.cjs') as typeof SheetJS
  const workbook = xlsx.utils.book_new()
  const identity: Cell[][] = [
    ['企业', company], ['期间', periodKey], ['名称', title], ['版本', version], ['账务状态', status],
    ['用途', isSample ? '演示数据' : '源自本机账本，供内部核对及交予会计复核'],
  ]
  const append = (name: string, rows: Cell[][], widths: number[]) => {
    const sheet = xlsx.utils.aoa_to_sheet(rows)
    sheet['!cols'] = widths.map(wch => ({ wch }))
    xlsx.utils.book_append_sheet(workbook, sheet, name)
  }
  append('报表说明', identity, [16, 50])
  for (const table of tables) {
    // Keep identity and revision when a data sheet is used independently.
    const details: Cell[][] = [[company, periodKey, '版本 ' + version], [], ...table.rows]
    append(table.name, details, table.rows[0]!.map((_value, index) => index % 2 === 0 ? 29 : 23))
  }
  const content = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer
  return content
}

export function generateReport(store: BookStore, pack: LoadedPack, periodKey: string, kind: ReportKind, fingerprint: string, now: Date) {
  return store.transaction(() => {
    const prepared = prepareReport(store, pack, periodKey, kind, now)
    if (!prepared.accepted) return prepared
    if (fingerprint !== prepared.fingerprint)
      return refuse('REPORT_CHANGED', '账已更新。请重新预览这个月份后再生成。', { periodKey })
    const latest = store.reportArtifacts(periodKey, kind)[0]
    if (latest?.fingerprint === fingerprint) return { accepted: true as const, artifact: latest, reused: true }
    const version = (latest?.version ?? 0) + 1
    const title = REPORT_TITLES[kind]
    const artifact: ReportArtifact = { id: randomUUID(), kind, periodKey, version, fingerprint, createdAt: now.toISOString(),
      fileName: [periodKey, title, 'v' + version].join('-') + '.xlsx' }
    const content = createWorkbook(prepared.companyName, periodKey, title, version, prepared.phase, prepared.isSample, prepared.tables)
    if (content.byteLength > MAX_REPORT_BYTES)
      return refuse('REPORT_TOO_LARGE', '这个月份的报表超过下载大小限制，请先导出原有复核包。', { periodKey })
    store.saveReportArtifact(artifact, content)
    return { accepted: true as const, artifact, reused: false }
  })
}

/** Compare the pack's two equipment treatments without changing amounts or posting new entries. */
export function compareEquipmentReport(
  store: BookStore, pack: LoadedPack, periodKey: string, invoiceNumber: string, settlement: string,
  treatments: readonly string[], now: Date,
) {
  const invoice = store.invoice(invoiceNumber)
  if (!PERIOD_KEY.test(periodKey) || !invoice?.issueDate?.startsWith(periodKey + '-') || invoice.direction !== 'input'
    || invoice.totalCents === null || invoice.voucherNo)
    return refuse('REPORT_EQUIPMENT_UNAVAILABLE', '请先核对本月尚未入账的设备购买发票。', { periodKey })
  if (!treatments.length || treatments.some(treatment => !['expense', 'capitalize'].includes(treatment)))
    return refuse('REPORT_EQUIPMENT_POLICY', '请先核实这笔设备采购适用的会计处理。', { periodKey })
  const revenue = packParameter(pack.payload, 'headline.revenue.lines')?.split('|')
  const expense = packParameter(pack.payload, 'headline.expense.lines')?.split('|')
  if (!revenue || !expense) return refuse('REPORT_REVIEW_REQUIRED', '当前会计包无法计算处理方案的利润影响。')
  const lines = pack.payload.reportLines.filter(line => line.reportId === 'report.profit')
  const chart = new Map(pack.payload.catalogs[0]!.subjects.map(row => [row.subjectCode, row.normalBalance]))
  const current = readProfit(store, pack, periodKey)
  const base = current.accepted && current.month.totals ? parseAmountToCents(current.month.totals.profit) : undefined
  const options = []
  const confirmedTotal = formatCents(invoice.totalCents)
  for (const treatment of new Set(treatments)) {
    const preview = recordEntry(store, pack, {
      date: invoice.issueDate, summary: '预览设备采购', eventKind: 'equipment_purchase',
      facts: { 'settlement.method': settlement, 'asset.treatment': treatment },
      invoiceNumber, amounts: { invoice_total: confirmedTotal }, preview: true,
    }, now)
    if (!preview.accepted) return preview
    if (preview.missingEvidence.length) return refuse('REPORT_EQUIPMENT_EVIDENCE', '设备采购还缺会计凭据。', { periodKey, missing: preview.missingEvidence })
    let delta = 0n
    for (const line of lines) {
      const multiplier = BigInt(Number(revenue.includes(line.lineId)) - Number(expense.includes(line.lineId)))
      for (const leg of preview.legs) {
        if (!line.subjectCodes.includes(leg.subjectCode)) continue
        const natural = (leg.side === '借') === (chart.get(leg.subjectCode) === 'debit') ? 1n : -1n
        const sign = line.sign === 'negative' ? -1n : 1n
        delta += (parseAmountToCents(leg.amount) ?? 0n) * multiplier * sign * natural
      }
    }
    options.push({
      treatment, label: preview.treatment, legs: preview.legs,
      monthlyProfitChange: formatCents(delta), monthlyProfitAfter: base === undefined ? null : formatCents(base + delta),
      futureExpense: treatment === 'capitalize' ? '从下月起按确认的固定资产资料核对折旧。' : '本笔按该规则一次进费用，没有后续分期费用。',
    })
  }
  const credit = options[0]!.legs.filter(leg => leg.side === '贷')
  if (options.some(option => JSON.stringify(option.legs.filter(leg => leg.side === '贷')) !== JSON.stringify(credit)))
    return refuse('REPORT_REVIEW_REQUIRED', '不同方案的收付分录有差异，请先核对实际付款。')
  return { accepted: true as const, periodKey, invoiceNumber, options, currentProfit: base === undefined ? null : formatCents(base),
    actualPayment: ['unsettled', 'personal_card'].includes(settlement) ? '0.00' : confirmedTotal,
    cashDifference: '0.00', preview: true, message: '这是根据同一笔采购和同一付款方式的预演，没有入账。' }
}
