// Run on the Linux Actions runner only, once the linked DSH host has stopped:
// node accounting.mjs <built plugin directory> <synthetic DSH SQLite path> [XLSX output path]
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'linux', 'Run on Linux only')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run on the isolated Actions runner only')
const [pluginInput, databaseInput, outputInput] = process.argv.slice(2)
assert(pluginInput && databaseInput, 'Expected a built plugin directory and the stopped DSH database path')
const plugin = await realpath(resolve(pluginInput))
const database = await realpath(resolve(databaseInput))
const temporaryRoots = [await realpath(tmpdir())]
if (process.env.RUNNER_TEMP) temporaryRoots.push(await realpath(process.env.RUNNER_TEMP))
assert(temporaryRoots.some(root => {
  const path = relative(root, database)
  return path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}), 'The SQLite file must be in a runner temporary directory')

const importer = name => import(pathToFileURL(join(plugin, name)).href)
const [{ apply }, { BookStore }, { loadPack }, { registerCompanyReport }, { monthRange }, { companyReportDefinition }] =
  await Promise.all([
    importer('lib/index.js'), importer('lib/store.js'), importer('lib/pack.js'), importer('lib/report-rpc.js'),
    importer('lib/period.js'), importer('client/report-chat.src.js'),
  ])
const require = createRequire(join(plugin, 'package.json'))
const { PDFDocument } = require('pdf-lib')
const xlsx = require(join(plugin, 'lib/vendor/xlsx.cjs'))

const home = await mkdtemp(join(tmpdir(), 'qianlai-pdf-accounting-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const attachmentsDir = join(home, 'attachments')
const session = { id: randomUUID() }
const pack = loadPack()
let useFullAccess = false
let approvalOutcome = 'allowed-once'
let selection = '暂缓记账'
const approvalPrompts = []
const entryQuestions = []

function openTools() {
  const tools = new Map()
  let dispose
  apply({
    effect(fn) { dispose = fn() },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    get(name) {
      if (name === 'attachments') return {
        async saveImage({ data, mediaType }) {
          assert(data.byteLength > 0)
          assert.equal(mediaType, 'image/png')
          return { attachmentId: 'synthetic-page-' + randomUUID() }
        },
      }
      if (name === 'approval') return { async request(request) {
        approvalPrompts.push(request)
        return approvalOutcome
      } }
      if (name === 'permissionPresets') return {
        current: () => useFullAccess ? 'danger-full-access' : 'restricted',
        resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }),
      }
      if (name === 'userQuestions') return { async ask({ questions }) {
        assert.equal(questions.length, 1)
        const [question] = questions
        assert.deepEqual(question.options.map(option => option.label), ['确认记账', '暂缓记账'])
        entryQuestions.push(question)
        return { answers: [{ id: question.id, selected: [selection] }] }
      } }
    },
  }, { bookPath: database })

  async function call(name, args, callId = randomUUID()) {
    const tool = tools.get('moneycome_' + name)
    assert(tool, 'Missing tool ' + name)
    return tool.execute(args, { callId, agent: { session }, signal: AbortSignal.timeout(35_000) })
  }
  async function ok(name, args, callId) {
    const result = await call(name, args, callId)
    assert.equal(result.accepted, true, name + ' ' + JSON.stringify(result))
    return result
  }
  return { call, ok, close: () => dispose?.() }
}

async function makePdf(name, lines) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  page.drawText(lines.join('\n'), { x: 45, y: 780, size: 12, lineHeight: 21 })
  const bytes = Buffer.from(await pdf.save())
  const path = join(attachmentsDir, name)
  await writeFile(path, bytes)
  return { path, bytes }
}

function reportEvents(result, callId = randomUUID()) {
  return [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, name: 'moneycome_company_report', callId } },
    { type: 'tool/result', seq: 3, data: {
      turn: 1,
      message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text: JSON.stringify(result) }] },
    } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function projectReport(events) {
  const definition = companyReportDefinition(event => event.data.message?.content[0]?.text)
  let state = definition.start()
  for (const event of events.slice(1)) state = definition.update({ state }, { event })
  return definition.buildViewNode({ key: 'synthetic-key', id: '1', state, start: { location: 'chat' } })
}

function openReportRpc(store, events, periodKey, callId) {
  let route
  const off = registerCompanyReport({ fetch: { register(handler) {
    route = handler
    return async () => {}
  } } }, store, pack, {
    async inspect(id) {
      assert.equal(id, session.id)
      return { meta: { agentPreset: 'moneycome-zhangjie' }, events }
    },
  })
  assert.equal(route.path, '/api/qianlai/company-report')
  async function request(action, data) {
    const response = await route.fetch(new Request('http://localhost' + route.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: randomUUID(), method: 'qianlai/company-report',
        payload: { kind: 'ledger-review', periodKey, sessionId: session.id, callId, action, ...data },
      }),
    }))
    assert.equal(response.status, 200)
    const message = await response.json()
    assert.equal(message.result.ok, true)
    const result = message.result.value
    assert.equal(result.accepted, true, JSON.stringify(result))
    return result
  }
  return { request, off }
}

let driver
try {
  await mkdir(attachmentsDir)
  driver = openTools()
  const { ok, call } = driver
  const book = await ok('book_status', {})
  assert.match(book.company, /合成|Synthetic/i, 'Do not use a real company')
  assert.equal(book.isSampleBook, false)
  assert.equal(book.onboarding?.completed, true, 'The linked SQLite file must come from completed DSH onboarding')
  const periodKey = book.accountingStartMonth
  const { from, to } = monthRange(periodKey)
  assert(to <= book.businessDate, 'The start month must be fully elapsed on the runner')
  assert.equal(book.onboarding.startMonth, periodKey)
  assert.equal(book.bankRegistration.status, 'provided')
  assert.equal(book.bankRegistration.accounts.length, 1)
  const [bank] = book.bankRegistration.accounts
  const period = { periodKey }
  const rentDate = periodKey + '-15'
  const receiptDate = periodKey + '-08'

  const openingPdf = await makePdf('synthetic-opening.pdf', [
    'Synthetic accounting opening balance',
    'Month: ' + periodKey,
    'Debit 1002: 10000.00',
    'Credit 4001: 10000.00',
  ])
  const opening = await ok('read_upload', { path: openingPdf.path })
  assert.match(opening.text, /Debit 1002: 10000\.00/)
  assert.match(opening.text, /Credit 4001: 10000\.00/)
  assert(Number.isSafeInteger(opening.material?.id))
  if (!book.openingBalancesEntered) {
    await ok('set_opening_balances', { balances: [
      { subjectCode: '1002', side: 'debit', amount: '10000.00' },
      { subjectCode: '4001', side: 'credit', amount: '10000.00' },
    ] })
    assert.match(approvalPrompts.at(-1)?.reason ?? '', /期初余额/)
  }
  assert.equal((await ok('book_status', {})).openingBalancesEntered, true)
  const initialBalances = (await ok('read_balances', period)).rows
  assert(initialBalances.some(row => row.subjectCode === '1002' && row.side === '借' && row.balance === '10000.00'))
  assert(initialBalances.some(row => row.subjectCode === '4001' && row.side === '贷' && row.balance === '10000.00'))
  const noMaterial = await call('company_report', { action: 'preview', kind: 'financial', periodKey })
  assert.equal(noMaterial.accepted, false)
  assert.equal(noMaterial.code, 'REPORT_NO_BUSINESS')
  assert.equal(noMaterial.nextAction, 'upload')
  assert.equal(projectReport(reportEvents(noMaterial))?.data.nextAction, 'upload')
  console.log('PASS opening PDF, balanced postings, financial report asks for uploads before business material')

  const statementPdf = await makePdf('synthetic-bank-statement.pdf', [
    'Synthetic bank statement',
    'Month: ' + periodKey,
    'Opening balance: 10000.00',
    receiptDate + ' consulting receipt 5000.00',
    rentDate + ' office rent -2000.00',
    'Closing balance: 13000.00',
  ])
  const original = await ok('read_upload', { path: statementPdf.path })
  assert.match(original.text, /consulting receipt 5000\.00/)
  assert.match(original.text, /office rent -2000\.00/)
  assert(Number.isSafeInteger(original.material?.id))
  const statementInput = {
    accountRef: bank.accountRef, bankAccountId: bank.id, materialId: original.material.id,
    periodStart: from, periodEnd: to, printedOpeningBalance: '10000.00', printedClosingBalance: '13000.00',
    rows: [
      { rowNumber: 1, occurredAt: receiptDate, direction: '收入', amount: '5000.00',
        rawDescription: '合成咨询来款', balanceAfter: '15000.00' },
      { rowNumber: 2, occurredAt: rentDate, direction: '支出', amount: '2000.00',
        rawDescription: '合成办公室租金', balanceAfter: '13000.00' },
    ],
  }
  const imported = await ok('import_statement', statementInput)
  assert.equal(imported.receipt.openingBalance, '10000.00')
  assert.equal(imported.receipt.closingBalance, '13000.00')
  assert.deepEqual(imported.receipt.months, [periodKey])
  assert.deepEqual(imported.lines.map(line => line.amount), ['5000.00', '-2000.00'])
  assert(imported.lines.every(line => !line.voucherNo))
  const duplicateFile = await ok('read_upload', { path: statementPdf.path })
  assert.equal(duplicateFile.material.id, original.material.id)
  const reused = await ok('import_statement', { ...statementInput, materialId: duplicateFile.material.id })
  assert.equal(reused.reused, true)
  assert.deepEqual(reused.receipt, imported.receipt)
  assert.deepEqual(reused.lines, imported.lines)

  const onlyStatement = await call('company_report', { action: 'preview', kind: 'financial', periodKey })
  assert.equal(onlyStatement.accepted, false)
  assert.equal(onlyStatement.code, 'REPORT_PREP_REQUIRED')
  assert.equal(onlyStatement.details?.blocker?.kind, 'unexplained_transaction')
  const statementAction = projectReport(reportEvents(onlyStatement))
  if (!onlyStatement.nextAction && statementAction === null) {
    console.log('FINDING #39 only statement: tool reports unexplained_transaction; missing nextAction; report UI emits no action node')
  } else {
    console.log('CHECK #39 only statement: ' + JSON.stringify({
      nextAction: onlyStatement.nextAction ?? null, hasReportUiAction: Boolean(statementAction),
    }))
  }
  console.log('PASS two original statement rows, closing 13000.00, duplicate material and import receipt reused')

  const rentInput = {
    date: rentDate, summary: '合成办公室租金', eventKind: 'rent',
    facts: { 'settlement.method': 'bank', 'cost.timing': 'current' },
    amounts: {
      invoice_total: '2000.00', allocation_admin: '2000.00', allocation_delivery: '0.00', allocation_selling: '0.00',
      allocation_production: '0.00', allocation_research: '0.00', allocation_development: '0.00', allocation_construction: '0.00',
    },
    statementLineIds: [imported.lines[1].lineId],
  }
  const legs = result => result.legs.map(({ side, subjectCode, amount }) => [side, subjectCode, amount])
  const preview = await ok('record_entry', { ...rentInput, preview: true })
  assert.deepEqual(legs(preview), [['借', '660204', '2000.00'], ['贷', '1002', '2000.00']])
  assert(preview.missingEvidence?.length, 'The synthetic source deliberately does not provide the rent invoice or contract')
  assert.deepEqual((await ok('list_vouchers', period)).vouchers, [])

  approvalOutcome = 'denied'
  const rejected = await call('record_entry', { ...rentInput, requestApproval: true })
  assert.equal(rejected.code, 'APPROVAL_REQUIRED')
  assert.deepEqual((await ok('list_vouchers', period)).vouchers, [])
  useFullAccess = true
  const deferred = await call('record_entry', { ...rentInput, requestApproval: true })
  assert.equal(deferred.code, 'ENTRY_CONFIRMATION_DEFERRED')
  assert.deepEqual((await ok('list_vouchers', period)).vouchers, [])
  assert.match(JSON.stringify(entryQuestions.at(-1)?.detail), /2000\.00/)

  selection = '确认记账'
  const postCallId = randomUUID()
  const voucher = await ok('record_entry', { ...rentInput, requestApproval: true }, postCallId)
  assert.deepEqual(legs(voucher), legs(preview))
  assert.deepEqual(voucher.missingEvidence, preview.missingEvidence)
  assert.match(voucher.voucherNo, /^PZ-\d{6}-\d+$/)
  assert.equal((await ok('record_entry', { ...rentInput, requestApproval: true }, postCallId)).voucherNo, voucher.voucherNo)
  assert.equal(entryQuestions.length, 2)
  assert.deepEqual((await ok('list_vouchers', period)).vouchers.map(item => item.voucherNo), [voucher.voucherNo])
  assert.equal((await ok('book_status', {})).statementLinesNotRecorded, 1)
  console.log('PASS rent preview, denial and defer unchanged, confirmation posted once, receipt still pending')

  const parameters = { kind: 'ledger-review', periodKey }
  const previewLedger = await ok('company_report', { ...parameters, action: 'preview' })
  assert.equal(previewLedger.phase, '未结账，供会计核对')
  assert.deepEqual(previewLedger.versions, [])
  const callId = randomUUID()
  const events = reportEvents(previewLedger, callId)
  assert.equal(projectReport(events)?.data.fingerprint, previewLedger.fingerprint)

  let artifact, content
  const reportStore = new BookStore(database)
  try {
    const rpc = openReportRpc(reportStore, events, periodKey, callId)
    try {
      const generated = await rpc.request('generate', { fingerprint: previewLedger.fingerprint })
      artifact = generated.artifact
      assert.equal(artifact.version, 1)
      assert.equal(generated.reused, false)
      const repeat = await rpc.request('generate', { fingerprint: previewLedger.fingerprint })
      assert.equal(repeat.reused, true)
      assert.equal(repeat.artifact.id, artifact.id)
      const download = await rpc.request('download', { id: artifact.id, fingerprint: previewLedger.fingerprint })
      assert.equal(download.fileName, artifact.fileName)
      content = Buffer.from(download.base64, 'base64')
    } finally {
      await rpc.off()
    }
  } finally {
    reportStore.close()
  }
  assert(content.length > 0)
  const loaded = xlsx.read(content, { type: 'buffer' })
  assert.deepEqual(loaded.SheetNames, ['报表说明', '凭证', '科目余额', '银行流水', '发票'])
  const info = loaded.Sheets['报表说明']
  assert.deepEqual([info.B1.v, info.B2.v, info.B4.v, info.B5.v], [book.company, periodKey, 1, previewLedger.phase])
  const readRows = name => xlsx.utils.sheet_to_json(loaded.Sheets[name], { header: 1, defval: null })
  const exportedVouchers = readRows('凭证').filter(row => row[0] === voucher.voucherNo)
  assert.equal(exportedVouchers.length, 2)
  assert(exportedVouchers.every(row => row[1] === rentDate && row[5] === 2000))
  assert(readRows('科目余额').some(row => row[0] === '1002' && row[3] === 8000))
  const bankRows = readRows('银行流水').filter(row => row[1] === receiptDate || row[1] === rentDate)
  assert.deepEqual(bankRows.map(row => [row[1], row[4], row[5]]),
    [[receiptDate, 5000, null], [rentDate, -2000, voucher.voucherNo]])
  assert.equal(readRows('发票').filter(row => typeof row[1] === 'string' && row[1].startsWith(periodKey + '-')).length, 0)

  driver.close()
  driver = openTools()
  assert.equal((await driver.ok('book_status', {})).statementLinesNotRecorded, 1)
  assert.deepEqual((await driver.ok('list_vouchers', period)).vouchers.map(item => item.voucherNo), [voucher.voucherNo])
  const reopenedList = await driver.ok('company_report', { ...parameters, action: 'list' })
  assert.deepEqual(reopenedList.versions.map(item => [item.version, item.id]), [[1, artifact.id]])
  const reopened = new BookStore(database)
  try {
    assert.deepEqual(Buffer.from(reopened.reportArtifact(artifact.id).content), content)
    assert.deepEqual(Buffer.from(reopened.workMaterialOriginal(original.material.id)), statementPdf.bytes)
  } finally {
    reopened.close()
  }
  if (outputInput) await writeFile(resolve(outputInput), content, { flag: 'wx' })
  console.log('PASS downloaded XLSX with 5 correct sheets, known pending receipt, v1 reused, exact bytes persisted after reopen')
  console.log('RESULT ' + JSON.stringify({
    period: periodKey, voucherNo: voucher.voucherNo, statementRows: imported.lines.length, statementEnding: imported.receipt.closingBalance,
    pendingRows: 1, reportVersion: artifact.version, sheets: loaded.SheetNames,
    xlsxSha256: createHash('sha256').update(content).digest('hex'),
  }))
} finally {
  driver?.close()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
}
