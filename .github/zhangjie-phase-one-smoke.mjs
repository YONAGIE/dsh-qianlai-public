import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../packages/dsh-qianlai/lib/index.js'

const temp = mkdtempSync(join(tmpdir(), 'qianlai-onboarding-integration-'))
const home = process.env.DSH_HOME
const companyName = '合成业务测试企业'
const periodKey = '2026-01'
const date = periodKey + '-18'
const sources = {
  failed: ['合成损坏合同.pdf', 'This is a deliberately invalid test PDF.'],
  good: ['合成独立票据.csv', 'date,net\n2026-01-18,200.00'],
  replacement: ['合成补充合同.txt', '合成服务合同。已完成交付。'],
}
let stop
let tools
let session
let approvals = 0

function startHost() {
  tools = new Map()
  session = { id: randomUUID() }
  apply({
    effect(setup) { stop = setup() },
    get(name) {
      if (name === 'approval') return { request: async () => { approvals++; return 'allowed-once' } }
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  })
}

async function call(name, args, accept = true) {
  const tool = tools.get('moneycome_' + name)
  assert.ok(tool, 'tool registered: ' + name)
  const result = await tool.execute(args, { callId: randomUUID(), agent: { session }, signal: new AbortController().signal })
  assert.equal(result.accepted, accept, name + ' ' + JSON.stringify(result))
  return result
}

async function read(key, accept = true) {
  const [name, bytes] = sources[key]
  const path = join(temp, 'attachments', name)
  writeFileSync(path, bytes)
  return call('read_upload', { path }, accept)
}

function invoice(number, seller = companyName, total = '101.00') {
  return {
    invoiceNumber: number, issueDate: date, sellerName: seller, buyerName: '合成客户',
    amountExclTax: total === '101.00' ? '100.00' : '200.00', taxAmount: total === '101.00' ? '1.00' : '2.00',
    totalInclTax: total, taxRate: '1%',
  }
}
const sale = (number, total = '101.00') => ({
  date, summary: '合成服务收入', eventKind: 'sale_service', facts: { 'settlement.method': 'bank' },
  invoiceNumber: number, amounts: {
    invoice_total: total, invoice_net: total === '101.00' ? '100.00' : '200.00',
    invoice_tax: total === '101.00' ? '1.00' : '2.00',
  },
})

async function getMatter(matterId) {
  return (await call('work_progress', { matterId })).matter
}

try {
  process.env.DSH_HOME = temp
  mkdirSync(join(temp, 'attachments'))
  startHost()
  await call('open_book', { companyName, accountingStartMonth: periodKey })
  await call('set_opening_balances', { balances: [] })
  const { matter: draft } = await call('save_work_note', {
    action: 'create-matter', title: '合成服务收款', period: periodKey, missing: ['合同'],
  })
  const failed = await read('failed', false)
  assert.ok(failed.material?.id, 'read error belongs to the received file')
  const good = await read('good')
  assert.ok(good.material?.id)
  assert.equal((await read('good')).material.id, good.material.id)
  assert.notEqual(failed.material.id, good.material.id)
  await call('save_work_note', { action: 'attach-material', matterId: draft.id, revision: draft.revision, materialId: failed.material.id })

  const pendingNumber = '26000000000123456781'
  const otherNumber = '26000000000123456782'
  const wrongNumber = '26000000000123456783'
  await call('check_invoice', invoice(pendingNumber))
  const pending = await getMatter(draft.id)
  const checkOnly = await call('record_entry', {
    ...sale(pendingNumber), workMatterId: draft.id, workMatterRevision: pending.revision, preview: true,
  }, false)
  assert.ok(checkOnly.code)
  assert.deepEqual((await call('list_vouchers', { periodKey })).vouchers, [])

  const wrong = await call('check_invoice', invoice(wrongNumber, '另一家合成企业'))
  assert.equal(wrong.recordable, false)
  await call('check_invoice', invoice(otherNumber, companyName, '202.00'))
  await call('record_entry', { ...sale(otherNumber, '202.00'), preview: true })
  const firstVoucher = await call('record_entry', sale(otherNumber, '202.00'))
  assert.ok(firstVoucher.voucherNo)

  stop?.()
  startHost()
  const resumed = await getMatter(draft.id)
  assert.deepEqual(resumed.missing, ['合同'])
  const replacement = await read('replacement')
  await call('save_work_note', {
    action: 'attach-material', matterId: draft.id, revision: resumed.revision,
    materialId: replacement.material.id, replacesMaterialId: failed.material.id,
  })
  const withContract = await getMatter(draft.id)
  await call('save_work_note', { action: 'update-matter', matterId: draft.id, revision: withContract.revision, missing: [] })
  const ready = await getMatter(draft.id)
  const proposal = { ...sale(pendingNumber), workMatterId: draft.id, workMatterRevision: ready.revision }
  await call('record_entry', { ...proposal, preview: true })
  const written = await call('record_entry', { ...proposal, requestApproval: true })
  const approvalCount = approvals
  const replay = await call('record_entry', { ...proposal, requestApproval: true })
  assert.equal(replay.voucherNo, written.voucherNo)
  assert.equal(approvals, approvalCount, 'an identical committed retry requests no additional approval')
  assert.equal((await getMatter(draft.id)).voucherNo, written.voucherNo)
  const { vouchers } = await call('list_vouchers', { periodKey })
  assert.deepEqual(vouchers.map(v => v.voucherNo).sort(), [written.voucherNo, firstVoucher.voucherNo].sort())
  console.log('PASS: bad file tracked independently, duplicate file reused, another invoice posted, replacement resumed original matter after restart, confirmed retry produced one voucher')
} finally {
  stop?.()
  if (home === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = home
  rmSync(temp, { recursive: true, force: true })
}
