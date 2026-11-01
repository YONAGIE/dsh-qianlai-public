import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatCents } from '@moneycome/fintax-core'

import { readBalances } from './balances.js'
import { closingCheck } from './closing.js'
import { listVouchers } from './entries.js'
import type { LoadedPack } from './pack.js'
import { monthRange } from './period.js'
import { readStatements } from './reports.js'
import type { BookStore } from './store.js'

const ROLE_NAMES: Record<string, string> = {
  invoice: '发票',
  contract: '合同',
  settlement: '银行回单或流水',
  payroll_sheet: '工资表',
  tax_certificate: '完税凭证',
}

const DIRECTION_NAMES: Record<string, string> = { input: '进项（我方买）', output: '销项（我方卖）' }

/**
 * 一格 CSV：含逗号、引号、换行的加引号，引号写两遍。
 * 流水摘要、对方户名来自银行记录，可能被人写成 `=...` 这类公式；以 = + - @ 等开头又不是数字的，
 * 前面加一个单引号，Excel 打开时当文字显示，不当公式执行。
 */
const cell = (value: unknown) => {
  const raw = value === null || value === undefined ? '' : String(value)
  const text = /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 写一份 CSV。开头加 BOM，Excel 直接双击打开不乱码。 */
function writeCsv(dir: string, name: string, header: readonly string[], rows: readonly (readonly unknown[])[]) {
  const body = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')
  writeFileSync(join(dir, name), `\uFEFF${body}\r\n`)
  return name
}

/** 结账检查的卡点，写成会计能看懂的一句话。 */
function blockerText(blocker: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((k) => blocker[k]).filter((v) => v !== undefined && v !== null && v !== '').join(' ')
  switch (blocker.kind) {
    case 'statement_gap':
      return `${pick('account')} 缺 ${pick('from')} 至 ${pick('to')} 的流水`
    case 'unexplained_transaction':
      return `流水 ${pick('date', 'amount', 'counterparty', 'description')} 还没记账`
    case 'evidence_missing':
      return `${pick('voucherNo', 'summary')} 缺 ${(blocker.missing as string[] | undefined)?.join('、') ?? ''}`
    case 'closing_item_pending':
      return `月末事项没做：${pick('itemName')}`
    case 'entity_fact_unknown':
      return `公司情况没登记：${pick('itemName')}（${pick('factKey')}）`
    case 'voucher_unbalanced':
      return `${pick('voucherNo')} 借贷不平：借 ${pick('debit')}，贷 ${pick('credit')}`
    case 'previous_period_open':
      return `上个月 ${pick('periodKey')} 还没结账`
    case 'opening_balances_unconfirmed':
      return '期初余额尚未确认；新成立企业也需明确确认全零'
    case 'period_not_ended':
      return `${pick('periodKey')} 业务期间尚未结束，不能提前锁月`
    case 'bank_balance_pending':
      return pick('message')
    case 'statement_balance_unknown':
      return `${pick('account')} ${pick('from')} 至 ${pick('to')} 的流水导入时没记下余额，核不了银行存款`
    case 'bank_balance_mismatch':
      return `账上银行存款 ${pick('bookBalance')}，流水余额 ${pick('statementBalance')}，差 ${pick('difference')}`
    default:
      return JSON.stringify(blocker)
  }
}

/**
 * 导出某个月给会计复核的材料：报表、凭证、科目余额、流水、发票、还没处理完的事，各一份 CSV，
 * 外加一份说明。写到 `<exportRoot>/<月份>-<导出时间>/`，返回目录和文件名。
 */
export function exportReviewPack(store: BookStore, pack: LoadedPack, periodKey: string, exportRoot: string, now: Date) {
  const statements = readStatements(store, pack, periodKey)
  if (!statements.accepted) return statements
  const balances = readBalances(store, periodKey)
  const check = closingCheck(store, pack, periodKey, now)
  const range = monthRange(periodKey)
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const dir = join(exportRoot, `${periodKey}-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const files: string[] = []

  const sheet = statements.balanceSheet
  files.push(
    writeCsv(dir, '1-资产负债表.csv', ['项目', '金额（元）'], [
      ['资产', ''],
      ...sheet.assets.map((l) => [l.lineName, l.amount]),
      ['资产合计', sheet.assetsTotal],
      ['负债和所有者权益', ''],
      ...sheet.liabilitiesAndEquity.map((l) => [l.lineName, l.amount]),
      ['负债和所有者权益合计', sheet.liabilitiesAndEquityTotal],
      ...('unclosedProfitInRetained' in sheet ? [['其中：未分配利润含还没结转的利润', sheet.unclosedProfitInRetained]] : []),
    ]),
  )

  const month = statements.profit?.month
  const ytd = statements.profit?.yearToDate
  const lineNames = [...new Set([...(month?.lines ?? []), ...(ytd?.lines ?? [])].map((l) => l.lineName))]
  const amountOf = (lines: readonly { lineName: string; amount: string }[] | undefined, name: string) =>
    lines?.find((l) => l.lineName === name)?.amount ?? '0.00'
  files.push(
    writeCsv(dir, '2-利润表.csv', ['项目', '本月（元）', `本年累计（${ytd?.from ?? ''} 起）`], [
      ...lineNames.map((name) => [name, amountOf(month?.lines, name), amountOf(ytd?.lines, name)]),
      ...(month?.totals && ytd?.totals
        ? [
            ['收入合计', month.totals.revenue, ytd.totals.revenue],
            ['费用合计', month.totals.expense, ytd.totals.expense],
            ['利润', month.totals.profit, ytd.totals.profit],
          ]
        : []),
    ]),
  )

  files.push(
    writeCsv(
      dir,
      '3-凭证.csv',
      ['凭证号', '日期', '摘要', '借贷', '科目代码', '科目名称', '金额（元）', '缺的凭据'],
      listVouchers(store, periodKey).flatMap((v) =>
        v.legs.map((l, i) => [
          v.voucherNo,
          v.date,
          v.summary,
          l.side,
          l.subjectCode,
          l.subjectName,
          l.amount,
          i === 0 ? v.missingEvidence.map((r) => ROLE_NAMES[r] ?? r).join('、') : '',
        ]),
      ),
    ),
  )

  files.push(
    writeCsv(
      dir,
      '4-科目余额.csv',
      ['科目代码', '科目名称', '方向', '月末余额（元）'],
      balances.accepted ? balances.rows.map((r) => [r.subjectCode, r.subjectName, r.side, r.balance]) : [],
    ),
  )

  files.push(
    writeCsv(
      dir,
      '5-银行流水.csv',
      ['账户', '日期', '金额（元）', '对方', '摘要', '记在哪张凭证'],
      store.statementLines(range).map((l) => [l.accountRef, l.occurredOn, formatCents(l.signedCents), l.counterparty, l.description, l.voucherNo ?? '还没记账']),
    ),
  )

  files.push(
    writeCsv(
      dir,
      '6-发票.csv',
      ['发票号码', '开票日期', '方向', '对方', '价税合计（元）', '记在哪张凭证', '验真'],
      store.invoices(range).map((i) => [
        i.invoiceNumber,
        i.issueDate,
        DIRECTION_NAMES[i.direction] ?? i.direction,
        i.counterparty,
        i.totalCents === null ? '' : formatCents(i.totalCents),
        i.voucherNo ?? '还没记账',
        '未查验，请到国家税务总局全国增值税发票查验平台核对',
      ]),
    ),
  )

  const failing = 'checks' in check ? check.checks.filter((c) => !c.passed) : []
  files.push(
    writeCsv(
      dir,
      '7-还没处理完的事.csv',
      ['检查项', '说明'],
      failing.flatMap((c) => c.blockers.map((b) => [c.check, blockerText(b as Record<string, unknown>)])),
    ),
  )

  const company = store.company()!
  const notes = [
    `${company.name} ${periodKey} 复核材料`,
    `导出时间：${now.toISOString()}`,
    `会计包：${pack.packRef}`,
    `这个月${'locked' in check && check.locked ? '已经结账' : '还没结账'}。`,
    '',
    '这些表由钱来张姐（dsh-qianlai 插件）从本机账本导出，供会计复核：',
    '1 资产负债表、2 利润表：简表，行与科目的对应来自会计包；没结账的月份，未分配利润含还没结转的利润。',
    '3 凭证：本月没作废的凭证，每行一条分录。',
    '4 科目余额：建账以来累计到月末，含期初余额。',
    '5 银行流水、6 发票：本月导入的流水和开票日期在本月的发票。发票只核过票面自洽，没有去税务局查验真伪。',
    '7 还没处理完的事：结账检查没过的项。',
    '',
    '会计包是未经执业会计复核的工程候选版；张姐不代为报税。账请会计复核后再用。',
  ]
  writeFileSync(join(dir, '0-说明.txt'), `\uFEFF${notes.join('\r\n')}\r\n`)
  files.unshift('0-说明.txt')

  return {
    accepted: true as const,
    periodKey,
    isSampleBook: company.isSample,
    dir,
    files,
    openItems: failing.reduce((n, c) => n + c.blockers.length, 0),
  }
}
