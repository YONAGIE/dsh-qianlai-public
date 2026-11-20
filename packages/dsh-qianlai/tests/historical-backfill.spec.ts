import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { readBalances } from '../src/balances.js'
import { setOpeningBalances } from '../src/book.js'
import { closePeriod, closingCheck } from '../src/closing.js'
import { CompanyOnboarding } from '../src/company-onboarding.js'
import { recordEntry } from '../src/entries.js'
import {
  commitHistoricalBackfill, historicalBackfillStatus, prepareHistoricalBackfill, reviewHistoricalBackfill,
  type HistoricalBackfillInput,
} from '../src/historical-backfill.js'
import { confirmHistoricalHandoff, historicalHandoffProgress, planHistoricalHandoff } from '../src/historical-handoff.js'
import { apply } from '../src/index.js'
import { checkInvoice } from '../src/invoices.js'
import { loadPack } from '../src/pack.js'
import { previewReport } from '../src/report-export.js'
import { readProfit } from '../src/reports.js'
import { BookStore } from '../src/store.js'

const now = new Date('2025-12-03T08:00:00Z')
const september = '2025-09'
const october = '2025-10'
const takeover = '2025-11'
const company = '合成历史账务数据有限公司'
const taxId = '000000000000000001'
const bank = '样例银行'
const accountRef = bank + ' 尾号 0002'
const pack = loadPack()
const cleanup: (() => void)[] = []

afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop()
})

function opening(amount = '101.00', profit = '100.00') {
  return [
    { subjectCode: '1002', side: 'debit', amount },
    { subjectCode: '222101', side: 'credit', amount: '1.00' },
    { subjectCode: '4103', side: 'credit', amount: profit },
  ]
}

function fixture(path = ':memory:', coveredMonths: string[] = [], decide = true, initial = opening()) {
  const store = new BookStore(path)
  cleanup.push(() => store.close())
  const wizard = new CompanyOnboarding(store, () => now)
  const enterprise = {
    companyName: company, taxId, establishedOn: '2024-12-14',
    province: '浙江省', city: '杭州市', taxpayerIdentity: 'small-scale', taxStatus: '正常',
    taxAuthority: '合成主管税务机关', incomeMethod: '查账征收', accountingSystem: '小企业会计准则',
    business: ['none'], bankStatus: 'provided', accounts: [{ holder: company, number: '000000000000000002', bank, currency: 'CNY', openedOn: '' }],
  }
  const stages = [
    enterprise, { history: 'previous', lastMonth: '2025-08', startMonth: takeover }, { payroll: 'none', social: 'partial' },
  ]
  for (const [index, fields] of stages.entries()) {
    const saved = wizard.save((index + 1) as 1 | 2 | 3, wizard.status().revision, fields)
    if (!saved.accepted) throw Error(saved.message)
  }
  expect(wizard.confirm(wizard.status().revision, false)).toMatchObject({ accepted: true, completed: true })
  expect(setOpeningBalances(store, pack, initial, now)).toMatchObject({ accepted: true })

  const material = (key: string) => store.saveWorkMaterial('synthetic-history-' + key, '合成原件-' + key + '.pdf', 'read', null).id
  const scopeId = material('scope')
  const scope = planHistoricalHandoff(store, { materialId: scopeId, coveredMonths }, now)
  if (!scope.accepted || !('handoffId' in scope)) throw Error('Expected a saved historical scope')
  if (decide) expect(confirmHistoricalHandoff(store, scope.handoffId, 'confirmed', now)).toMatchObject({ accepted: true })

  const invoiceNumber = '25330000000087654321'
  expect(checkInvoice(store, {
    invoiceNumber, issueDate: october + '-10', sellerName: company, sellerTaxId: taxId,
    buyerName: '合成采购公司', buyerTaxId: '000000000000000003', amountExclTax: '100.00', taxAmount: '1.00',
    totalInclTax: '101.00', totalInWords: '壹佰零壹圆整', taxRate: '1%', lineItems: ['*信息技术服务*合成服务'],
  }, now)).toMatchObject({ recordable: true })
  const statementId = material('statement')
  const invoiceId = material('invoice')
  const openingId = material('opening')
  const noActivityId = material('no-activity')
  const input = {
    handoffId: scope.handoffId,
    periods: [
      { periodKey: september, opening: { materialId: openingId, balances: [] }, noActivityMaterialId: noActivityId, entries: [] },
      { periodKey: october, statements: [{
        materialId: statementId, accountRef, sourceBank: bank, sourceAccountTail: '0002',
        periodStart: october + '-01', periodEnd: october + '-31',
        rows: [{ rowNumber: 1, occurredAt: october + '-10', amount: '101.00', direction: '收入', balanceAfter: '101.00' }],
        printedOpeningBalance: '0.00', printedClosingBalance: '101.00', printedPeriodStart: october + '-01', printedPeriodEnd: october + '-31',
      }], entries: [{
        materialId: invoiceId, sourceRef: invoiceNumber, invoiceNumber, date: october + '-10',
        summary: '合成历史服务收入', eventKind: 'sale_service', facts: { 'settlement.method': 'bank' },
        amounts: { invoice_total: '101.00', invoice_net: '100.00', invoice_tax: '1.00' },
        statementRows: [{ materialId: statementId, rowNumber: 1 }],
      }] },
    ],
  } satisfies HistoricalBackfillInput
  return { store, input, material, scopeId, invoiceNumber }
}

function ready(store: BookStore, input: HistoricalBackfillInput) {
  const result = prepareHistoricalBackfill(store, pack, input, now)
  if (!result.accepted) throw Error(result.code + ': ' + result.message)
  return result
}

function expectNoPosting(store: BookStore) {
  expect(store.vouchers()).toEqual([])
  expect(store.historicalPeriods()).toEqual([])
  expect(store.statementCoverage()).toEqual([])
  expect(store.lockedPeriods()).toEqual([])
}

describe('历史缺月正式补账', () => {
  it('预演无写入，确认补记连续缺月，当前账本余额不重复增加', () => {
    const { store, input, invoiceNumber } = fixture()
    const balanceBefore = readBalances(store, takeover)
    expect(recordEntry(store, pack, input.periods[1]!.entries[0]!, now)).toMatchObject({ code: 'PERIOD_BEFORE_BOOK' })
    const draft = ready(store, input)
    expect(draft.view).toMatchObject({ voucherCount: 1, transferCount: 1,
      months: [{ periodKey: september, matchedAgainst: october + ' 期初' },
        { periodKey: october, matchedAgainst: takeover + ' 期初', business: [{ date: october + '-10' }] }] })
    expect(ready(store, input).draftId).toBe(draft.draftId)
    expect(reviewHistoricalBackfill(store, pack, draft.draftId, now)).toEqual(draft)
    expect(historicalBackfillStatus(store)).toMatchObject({ latestDraftId: draft.draftId })
    expectNoPosting(store)
    expect(store.invoice(invoiceNumber)?.voucherNo).toBeNull()

    const posted = commitHistoricalBackfill(store, pack, draft.draftId, now)
    expect(posted).toMatchObject({ phase: 'posted', months: [{ periodKey: september, vouchers: [] }, {
      periodKey: october,
      vouchers: [{ voucherNo: 'PZ-202510-001', materialId: input.periods[1]!.entries[0]!.materialId, sourceRef: invoiceNumber }],
      transferVouchers: ['PZ-202510-002'],
    }] })
    expect(commitHistoricalBackfill(store, pack, draft.draftId, now)).toEqual(posted)
    expect(historicalBackfillStatus(store)).not.toHaveProperty('latestDraftId')
    expect(prepareHistoricalBackfill(store, pack, input, now)).toMatchObject({ code: 'HISTORY_MONTH_OUTSIDE_SCOPE' })
    expect(store.vouchers({ periodKey: october })).toHaveLength(2)
    expect(store.statementLines({ voucherNo: 'PZ-202510-001' })).toHaveLength(1)
    expect(store.invoice(invoiceNumber)?.voucherNo).toBe('PZ-202510-001')
    expect(readBalances(store, september)).toMatchObject({ rows: [] })
    expect(readBalances(store, october)).toMatchObject({ rows: expect.arrayContaining([{ subjectCode: '1002', subjectName: '银行存款', side: '借', balance: '101.00' }]) })
    expect(readBalances(store, takeover)).toEqual(balanceBefore)
    expect(readProfit(store, pack, takeover)).toMatchObject({ month: { totals: { profit: '0.00' } }, yearToDate: { totals: { profit: '100.00' } } })
    expect(previewReport(store, pack, october, 'financial', now)).toMatchObject({ accepted: true, phase: '历史补账已核对' })
    expect(closePeriod(store, pack, october, now)).toMatchObject({ code: 'PERIOD_LOCKED' })
    expect(closingCheck(store, pack, october, now)).toMatchObject({ locked: true })
    expect(historicalHandoffProgress(store).plans[0]).toMatchObject({ missingMonths: [], bookedMonths: [september, october] })
    expect(setOpeningBalances(store, pack, opening('102.00', '101.00'), now)).toMatchObject({ code: 'OPENING_LINKED_TO_HISTORY' })
  })

  it('只给首个衔接差额，确认期间修改期初后整批回滚', () => {
    const { store, input } = fixture()
    const draft = ready(store, input)
    expect(setOpeningBalances(store, pack, opening('102.00', '101.00'), now)).toMatchObject({ accepted: true })
    const difference = { code: 'HISTORY_BALANCE_DIFFERENCE', details: { month: october, subjectCode: '1002',
      actual: '借方 101.00', expected: '借方 102.00', difference: '1.00' } }
    expect(reviewHistoricalBackfill(store, pack, draft.draftId, now)).toMatchObject(difference)
    expect(commitHistoricalBackfill(store, pack, draft.draftId, now)).toMatchObject(difference)
    expectNoPosting(store)
    expect(readBalances(store, takeover)).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ subjectCode: '1002', balance: '102.00' })]) })
  })

  it('保留已交接的原账，只处理确认过的缺月和证据齐全的业务', () => {
    const { store, input, material } = fixture(':memory:', [september], false)
    expect(prepareHistoricalBackfill(store, pack, input, now)).toMatchObject({ code: 'HISTORY_SCOPE_CONFIRMATION_REQUIRED' })
    expect(confirmHistoricalHandoff(store, input.handoffId, 'confirmed', now)).toMatchObject({ accepted: true })
    expect(prepareHistoricalBackfill(store, pack, input, now)).toMatchObject({ code: 'HISTORY_MONTH_OUTSIDE_SCOPE' })
    const octoberInput = input.periods[1]!
    const one = { ...input, periods: [{ ...octoberInput, opening: { materialId: material('october-opening'), balances: [] } }] }
    expect(prepareHistoricalBackfill(store, pack, { ...one, periods: [{ ...one.periods[0]!, entries: [] }] }, now))
      .toMatchObject({ code: 'HISTORY_ACTIVITY_SOURCE_REQUIRED' })
    expect(prepareHistoricalBackfill(store, pack, { ...one, periods: [{ ...one.periods[0]!, entries: [{
      ...octoberInput.entries[0]!, statementRows: [],
    }] }] }, now)).toMatchObject({ code: 'HISTORY_BANK_PROOF_REQUIRED' })
    expect(ready(store, one).view.months).toHaveLength(1)
    expectNoPosting(store)
  })

  it.each([true, false])('只接受当前宿主真实批准后落账，full access=%s', async fullAccess => {
    const directory = mkdtempSync(join(tmpdir(), 'qianlai-history-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'book.sqlite')
    const { store, input } = fixture(path)
    const execution = { agent: { session: { id: 'synthetic-history-owner' } }, callId: 'call-history', signal: new AbortController().signal }
    const approval = vi.fn(async (_request: { reason: string }) => 'rejected')
    const ask = vi.fn(async ({ questions }: { questions: readonly { id: string; detail: string }[] }) =>
      ({ answers: [{ id: questions[0]!.id, selected: ['稍后补账'] }] }))
    const tools = new Map<string, (args: Record<string, unknown>, exec: typeof execution) => Promise<unknown>>()
    apply({
      effect: start => { cleanup.push(start()) },
      tools: { register: tool => { tools.set(tool.name, tool.execute); return () => {} } },
      get: name => name === 'approval' ? { request: approval }
        : name === 'userQuestions' ? { ask }
          : name === 'permissionPresets' && fullAccess ? {
            current: () => 'danger-full-access', resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }),
          } : undefined,
    }, { bookPath: path })
    const run = tools.get('moneycome_historical_backfill')!
    const draft = ready(store, input)
    const args = { action: 'confirm', draftId: draft.draftId, approved: true }
    expect(await run(args, execution)).toMatchObject({ code: 'HISTORY_CONFIRMATION_DEFERRED' })
    expectNoPosting(store)
    if (fullAccess) {
      expect(ask.mock.calls[0]?.[0].questions[0]?.detail).toContain('合成历史服务收入')
      expect(approval).not.toHaveBeenCalled()
      ask.mockImplementationOnce(async ({ questions }) => ({ answers: [{ id: questions[0]!.id, selected: ['确认补账'] }] }))
    } else {
      expect(approval.mock.calls[0]?.[0].reason).toContain('确认后按原日期保存 1 张业务凭证和 1 张结转凭证')
      expect(ask).not.toHaveBeenCalled()
      approval.mockResolvedValueOnce('allowed-once')
    }
    const posted = await run(args, { ...execution, callId: 'call-history-approved' })
    expect(posted).toMatchObject({ accepted: true, phase: 'posted' })
    expect(await run(args, execution)).toEqual(posted)
    expect(fullAccess ? ask : approval).toHaveBeenCalledTimes(2)
  })
})
