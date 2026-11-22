import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as XLSX from 'xlsx'
import { describe, expect, it } from 'vitest'

import { openBook, setCompanyFacts, setOpeningBalances } from '../src/book.js'
import { closingCheck } from '../src/closing.js'
import { recordEntry } from '../src/entries.js'
import { apply } from '../src/index.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import type { PdfReferenceSession } from '../src/referenced-pdf.js'
import { generateReport, listReports, previewReport } from '../src/report-export.js'
import { registerCompanyReport, reportSessionAccess } from '../src/report-rpc.js'
import { importStatement } from '../src/statements.js'
import { BookStore } from '../src/store.js'
import type { RpcConnection } from '../src/wechat/control.js'

const month = '2026-01'
const companyName = '合成报表测试企业'
const today = new Date('2026-03-04T08:00:00Z')
const pack = loadPack()

function newBook(path = ':memory:') {
  const store = new BookStore(path)
  expect(openBook(store, { companyName, accountingStartMonth: month })).toMatchObject({ accepted: true })
  expect(setOpeningBalances(store, pack, [], today)).toMatchObject({ accepted: true })
  return store
}

function cashSale(store: BookStore, date: string, number: string, net: string, total: string, tax: string) {
  expect(checkInvoice(store, { invoiceNumber: number, issueDate: date, sellerName: companyName, buyerName: '合成买方',
    amountExclTax: net, taxAmount: tax, totalInclTax: total, taxRate: '1%' }, today)).toMatchObject({ recordable: true })
  expect(recordEntry(store, pack, { date, summary: '=合成收入', eventKind: 'sale_service', facts: { 'settlement.method': 'cash' },
    invoiceNumber: number, amounts: { invoice_total: total, invoice_net: net, invoice_tax: tax } }, today)).toMatchObject({ accepted: true })
}

function resolveKnownNo(store: BookStore, period = month) {
  const state = closingCheck(store, pack, period, today)
  if (!('checks' in state)) return
  const keys = state.checks.flatMap(c => c.blockers).flatMap(b => ('factKey' in b ? [String(b.factKey)] : []))
  expect(setCompanyFacts(store, pack, Object.fromEntries(keys.map(key => [key, 'no'])))).toMatchObject({ accepted: true })
}

function approvedPreview(store: BookStore, period = month) {
  const preview = previewReport(store, pack, period, 'financial', today)
  if (!preview.accepted) throw Error(JSON.stringify(preview))
  return preview
}

describe('可下载的报表版本', () => {
  it('已有建档的账本升级后仍可导出，并保留建档资料', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qianlai-report-migration-'))
    const bookPath = join(directory, 'book.sqlite')
    const draft = { draftId: 'existing-report-draft', revision: 2, step: 1, mode: 'manual' } as const
    try {
      const initial = newBook(bookPath)
      try { initial.saveCompanyOnboarding(draft) } finally { initial.close() }
      const database = new DatabaseSync(bookPath)
      try {
        database.exec('DROP TABLE report_artifact; DROP TABLE work_matter; DROP TABLE work_material; PRAGMA user_version = 6')
      } finally { database.close() }
      const upgraded = new BookStore(bookPath)
      try {
        expect(upgraded.company()?.name).toBe(companyName)
        expect(upgraded.companyOnboarding()).toEqual(draft)
        expect(upgraded.reportPendingMatter(month)).toBeUndefined()
        const preview = previewReport(upgraded, pack, month, 'ledger-review', today)
        if (!preview.accepted) throw Error(JSON.stringify(preview))
        expect(generateReport(upgraded, pack, month, 'ledger-review', preview.fingerprint, today)).toMatchObject({ accepted: true })
      } finally { upgraded.close() }
      const inspected = new DatabaseSync(bookPath)
      try {
        expect(inspected.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 })
        expect(inspected.prepare("SELECT name FROM sqlite_schema WHERE name IN ('company_onboarding', 'work_material', 'work_matter') ORDER BY name").all())
          .toEqual([{ name: 'company_onboarding' }, { name: 'work_material' }, { name: 'work_matter' }])
      } finally { inspected.close() }
    } finally { rmSync(directory, { recursive: true }) }
  })

  it('无业务材料和只有流水优先给当月实际缺项', () => {
    const store = newBook()
    try {
      expect(previewReport(store, pack, month, 'financial', today))
        .toMatchObject({ code: 'REPORT_NO_BUSINESS', periodKey: month, nextAction: 'upload', uploadKind: 'report-material' })
      expect(importStatement(store, { accountRef: '合成银行 尾号 0012', periodStart: '2026-01-01', periodEnd: '2026-01-31',
        rows: [
          { rowNumber: 1, occurredAt: '2026-01-10', direction: '收入', amount: '5000.00', balanceAfter: '5000.00', rawDescription: '咨询服务来款' },
          { rowNumber: 2, occurredAt: '2026-01-12', direction: '支出', amount: '2000.00', balanceAfter: '3000.00', rawDescription: '用途待核对' },
        ] }, today))
        .toMatchObject({ accepted: true })
      expect(previewReport(store, pack, month, 'financial', today)).toMatchObject({
        code: 'REPORT_PREP_REQUIRED', periodKey: month, nextAction: 'upload', uploadKind: 'transaction-evidence',
        message: expect.stringContaining('2026-01-10 收入 5000.00 元（咨询服务来款）'),
        details: { blocker: { kind: 'unexplained_transaction', date: '2026-01-10', amount: '5000.00' } },
      })
      expect(store.reportArtifacts(month, 'financial')).toEqual([])
    } finally { store.close() }
  })

  it('已记账凭证确实缺发票时，按凭证号和业务摘要提示上传发票', () => {
    const store = newBook()
    try {
      expect(recordEntry(store, pack, {
        date: '2026-01-10', summary: '合成办公用品', eventKind: 'office_supply',
        facts: { 'settlement.method': 'cash' }, amounts: { invoice_total: '1300.00' },
      }, today)).toMatchObject({ accepted: true, voucherNo: 'PZ-202601-001', missingEvidence: ['invoice'] })
      expect(previewReport(store, pack, month, 'financial', today)).toMatchObject({
        code: 'REPORT_PREP_REQUIRED', periodKey: month, nextAction: 'upload', uploadKind: 'invoice',
        message: expect.stringContaining('凭证 PZ-202601-001（合成办公用品）还缺发票'),
        details: { blocker: { kind: 'evidence_missing', voucherNo: 'PZ-202601-001', missing: ['发票'] } },
      })
    } finally { store.close() }
  })

  it('点击前不落文件，重复确认沿用同一文件，账款变化可保留新旧版', () => {
    const store = newBook()
    try {
      cashSale(store, '2026-01-10', '26000000000123456781', '100.00', '101.00', '1.00')
      resolveKnownNo(store)
      const preview = approvedPreview(store)
      expect(store.reportArtifacts(month, 'financial')).toEqual([])
      const first = generateReport(store, pack, month, 'financial', preview.fingerprint, today)
      if (!first.accepted) throw Error(JSON.stringify(first))
      expect(generateReport(store, pack, month, 'financial', preview.fingerprint, today))
        .toEqual({ accepted: true, artifact: first.artifact, reused: true, workbookSummary: preview.workbookSummary })
      const original = Buffer.from(store.reportArtifact(first.artifact.id)!.content)
      const workbook = XLSX.read(Uint8Array.from(original), { type: 'array' })
      expect(workbook.SheetNames).toEqual(['报表说明', '资产负债表', '利润表'])
      expect(workbook.Sheets['报表说明']?.B1?.v).toBe(companyName)
      expect(workbook.Sheets['报表说明']?.B2?.v).toBe(month)
      expect(workbook.Sheets['报表说明']?.B4?.v).toBe(1)
      expect(XLSX.utils.sheet_to_json(workbook.Sheets['利润表']!, { header: 1 })).toContainEqual(['利润', 100, 100])

      cashSale(store, '2026-01-12', '26000000000123456782', '200.00', '202.00', '2.00')
      expect(generateReport(store, pack, month, 'financial', preview.fingerprint, today)).toMatchObject({ code: 'REPORT_CHANGED' })
      const second = generateReport(store, pack, month, 'financial', approvedPreview(store).fingerprint, today)
      if (!second.accepted) throw Error(JSON.stringify(second))
      const newer = XLSX.read(store.reportArtifact(second.artifact.id)!.content, { type: 'array' })
      expect(XLSX.utils.sheet_to_json(newer.Sheets['利润表']!, { header: 1 })).toContainEqual(['利润', 300, 300])
      expect(second.artifact.version).toBe(2)
      const stillStored = Buffer.from(store.reportArtifact(first.artifact.id)!.content)
      expect(Buffer.compare(stillStored, original)).toBe(0)
      expect(listReports(store, month, 'financial', 1)).toMatchObject({ versions: [first.artifact] })
      expect(listReports(store, '2026-02', 'financial')).toMatchObject({ versions: [] })
    } finally { store.close() }
  })

  it('账务明细摘要和下载的工作表一致，未关联凭证的流水仍导出', () => {
    const store = newBook()
    try {
      const accountRef = '合成银行 尾号 0012'
      const statement = importStatement(store, { accountRef, periodStart: '2026-01-01', periodEnd: '2026-01-31',
        rows: [
          { rowNumber: 1, occurredAt: '2026-01-10', direction: '收入', amount: '500.00', balanceAfter: '500.00' },
          { rowNumber: 2, occurredAt: '2026-01-11', direction: '支出', amount: '20.00', balanceAfter: '480.00' },
        ],
      }, today)
      if (!statement.accepted) throw Error(JSON.stringify(statement))
      const bankFee = recordEntry(store, pack, { date: '2026-01-11', summary: '合成手续费', eventKind: 'bank_fee',
        facts: { 'settlement.method': 'bank' }, amounts: { settlement: '20.00' },
        statementLineIds: [statement.lines[1]!.lineId],
      }, today)
      if (!bankFee.accepted || !('voucherNo' in bankFee)) throw Error(JSON.stringify(bankFee))
      const preview = previewReport(store, pack, month, 'ledger-review', today)
      if (!preview.accepted) throw Error(JSON.stringify(preview))
      const file = generateReport(store, pack, month, 'ledger-review', preview.fingerprint, today)
      if (!file.accepted) throw Error(JSON.stringify(file))
      const listed = listReports(store, month, 'ledger-review')
      expect(listed).toMatchObject({ versions: [{ version: 1, fingerprint: preview.fingerprint }] })
      const stored = store.reportArtifact(file.artifact.id)!
      const workbook = XLSX.read(stored.content, { type: 'array' })
      expect(file.workbookSummary).toEqual(preview.workbookSummary)
      expect(preview.workbookSummary).toMatchObject({
        sheetNames: workbook.SheetNames,
        postedVoucherCount: 1, bankRowCount: 2, bankRowsWithoutVoucher: 1,
        description: expect.stringContaining('仍会列在「银行流水」页，「对应凭证」栏为空'),
      })
      expect(XLSX.utils.sheet_to_json(workbook.Sheets['银行流水']!, { header: 1, defval: null })).toEqual(expect.arrayContaining([
        [accountRef, '2026-01-10', null, null, 500, null],
        [accountRef, '2026-01-11', null, null, -20, bankFee.voucherNo],
      ]))
      expect(XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets['凭证']!, { header: 1 }).slice(3).map(row => row[0]))
        .toEqual([bankFee.voucherNo, bankFee.voucherNo])

      cashSale(store, '2026-01-13', '26000000000123456781', '100.00', '101.00', '1.00')
      const newPreview = previewReport(store, pack, month, 'ledger-review', today)
      if (!newPreview.accepted) throw Error(JSON.stringify(newPreview))
      expect(newPreview.workbookSummary).toMatchObject({ postedVoucherCount: 2 })
      expect(newPreview.fingerprint).not.toBe(preview.fingerprint)
      expect(listReports(store, month, 'ledger-review')).toEqual(listed)
      expect(listReports(store, month, 'ledger-review', 1)).not.toHaveProperty('workbookSummary')
      expect(Buffer.compare(Buffer.from(store.reportArtifact(file.artifact.id)!.content), Buffer.from(stored.content))).toBe(0)
    } finally { store.close() }
  })

  it('每次模型请求读本会话对应的文件版本，能看到界面另存的报表', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qianlai-report-context-'))
    const bookPath = join(directory, 'book.sqlite')
    const store = newBook(bookPath)
    const tools = new Map<string, Parameters<Parameters<typeof apply>[0]['tools']['register']>[0]>()
    let readReportPrompt = (_input: { agent: { session: PdfReferenceSession } }) => ''
    let dispose = () => {}
    try {
      cashSale(store, '2026-01-10', '26000000000123456781', '100.00', '101.00', '1.00')
      apply({
        effect: fn => { dispose = fn() },
        tools: { register: tool => { tools.set(tool.name, tool); return () => {} } },
        get: name => name === 'systemPrompt' ? {
          context(contribution: { name: string; text: typeof readReportPrompt }) {
            if (contribution.name === 'moneycome-report:saved-state') readReportPrompt = contribution.text
            return () => {}
          },
        } : undefined,
      }, { bookPath })
      const agent = { session: { id: 'report-desktop' } }
      const execution = { agent, signal: new AbortController().signal }
      const preview = await tools.get('moneycome_company_report')!.execute({ kind: 'ledger-review', periodKey: month, action: 'preview' }, execution)
      if (!preview || typeof preview !== 'object' || !('fingerprint' in preview) || typeof preview.fingerprint !== 'string')
        throw Error(JSON.stringify(preview))
      expect(readReportPrompt({ agent })).toContain('未找到已生成的 XLSX')
      expect(readReportPrompt({ agent: { session: { id: 'other-desktop' } } })).toBe('')

      const generated = generateReport(store, pack, month, 'ledger-review', preview.fingerprint, today)
      if (!generated.accepted) throw Error(JSON.stringify(generated))
      expect(readReportPrompt({ agent })).toContain(`已生成第 1 版，文件名 ${generated.artifact.fileName}`)
      expect(readReportPrompt({ agent })).toContain(generated.workbookSummary.description)
      expect(readReportPrompt({ agent: { session: { id: 'other-desktop' } } })).toBe('')

      cashSale(store, '2026-01-12', '26000000000123456782', '200.00', '202.00', '2.00')
      const updated = previewReport(store, pack, month, 'ledger-review', today)
      if (!updated.accepted) throw Error(JSON.stringify(updated))
      expect(generateReport(store, pack, month, 'ledger-review', updated.fingerprint, today)).toMatchObject({ accepted: true })
      expect(readReportPrompt({ agent })).toContain('已生成第 2 版')
      expect(readReportPrompt({ agent })).not.toContain(generated.workbookSummary.description)
    } finally {
      dispose()
      store.close()
      rmSync(directory, { recursive: true })
    }
  })

  it('只允许通过匹配原会话与工具结果的操作读写该文件', async () => {
    const store = newBook()
    try {
      cashSale(store, '2026-01-10', '26000000000123456781', '100.00', '101.00', '1.00')
      resolveKnownNo(store)
      const preview = approvedPreview(store)
      const callId = 'exact-report-call'
      let handler!: Parameters<RpcConnection['fetch']['register']>[0]['fetch']
      const connection: RpcConnection = { fetch: { register(route) { handler = route.fetch; return async () => {} } } }
      let observationsClosed = 0
      registerCompanyReport(connection, store, pack, reportSessionAccess(undefined, {
        async observeSession(id, { projectionMode }) {
          expect(projectionMode).toBe('all')
          return {
            projections: { values: { agentPreset: id === 'not-zhangjie' ? 'another-agent' : 'moneycome-zhangjie' } },
            events: id === 'other' ? [] : [
              { type: 'tool/call', data: { name: 'moneycome_company_report', callId } },
              { type: 'tool/result', data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text: JSON.stringify(preview) }] } } },
            ],
            [Symbol.dispose]() { observationsClosed++ },
          }
        },
      }))
      const request = async (payload: Record<string, unknown>) =>
        (await (await handler(new Request('http://localhost/api/qianlai/company-report', { method: 'POST',
          body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'qianlai/company-report',
            payload: { kind: 'financial', periodKey: month, callId, sessionId: 'current', ...payload } }) }))).json()).result.value
      expect(await request({ action: 'generate', sessionId: 'other', fingerprint: preview.fingerprint }))
        .toMatchObject({ code: 'REPORT_ACTION_UNAVAILABLE' })
      expect(await request({ action: 'generate', sessionId: 'not-zhangjie', fingerprint: preview.fingerprint }))
        .toMatchObject({ code: 'REPORT_ACTION_UNAVAILABLE' })
      const generated = await request({ action: 'generate', fingerprint: preview.fingerprint })
      expect(generated.accepted).toBe(true)
      expect(await request({ action: 'download', id: generated.artifact.id, periodKey: '2026-02', fingerprint: preview.fingerprint }))
        .toMatchObject({ code: 'REPORT_ACTION_UNAVAILABLE' })
      const file = await request({ action: 'download', id: generated.artifact.id, fingerprint: preview.fingerprint })
      expect(file).toMatchObject({ accepted: true, fileName: generated.artifact.fileName })
      expect(Buffer.from(file.base64, 'base64').subarray(0, 2).toString()).toBe('PK')
      expect(observationsClosed).toBe(5)
    } finally { store.close() }
  })
})
