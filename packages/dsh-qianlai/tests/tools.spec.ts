import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'

import { CompanyOnboarding } from '../src/company-onboarding.js'
import { apply } from '../src/index.js'
// Worker URLs resolve relative to the shipped JS entry, so this integration uses the built plugin.
import { apply as applyBuilt } from '../lib/index.js'
import { loadPack } from '../src/pack.js'
import { seedSampleBook } from '../src/sample-book.js'
import { BookStore } from '../src/store.js'

// 企业是编的。这里测的是工具入口：参数校验、出错兜底、和别的进程抢同一本账。

interface Tool {
  execute(args: unknown, exec?: ReturnType<typeof approvedCall>): Promise<unknown>
}

// Synthetic native approval; production uses DSH's actual approval service.
const approvedCall = () => ({ signal: new AbortController().signal, callId: randomUUID(), agent: { session: { id: 'synthetic-tools-session' } } })

function plugin() {
  const bookPath = join(mkdtempSync(join(tmpdir(), 'qianlai-tools-')), 'book.sqlite')
  const tools = new Map<string, Tool>()
  type Guard = Parameters<NonNullable<Parameters<typeof apply>[0]['tools']['guard']>>[0]
  let guard: Guard | undefined
  apply({ effect: (fn) => void fn(), tools: {
    register: (t) => (tools.set(t.name, t), () => {}),
    guard: check => { guard = check; return () => {} },
  },
    get: name => name === 'approval' ? { request: async () => 'allowed-once' } : undefined,
  }, { bookPath })
  const call = (name: string, args: unknown) => tools.get(name)!.execute(args, approvedCall()) as Promise<Record<string, unknown>>
  const ask = (questions: unknown, sessionId = approvedCall().agent.session.id) =>
    guard?.({ name: 'ask_user_question', arguments: { questions }, agent: { session: { id: sessionId } } })
  return { bookPath, call, ask }
}

async function ownBook() {
  const p = plugin()
  await p.call('moneycome_open_book', { companyName: '杭州青禾数据服务有限公司', accountingStartMonth: '2026-01' })
  await p.call('moneycome_set_opening_balances', { balances: [] })
  return p
}

const ENTRY = {
  date: '2026-01-05',
  summary: '股东实缴注册资本',
  eventKind: 'capital_contribution',
  facts: { 'settlement.method': 'bank', 'capital.nature': 'registeredCapital' },
  amounts: { contract: '1000.00' },
}

describe('工具入口', () => {
  it('异步 PDF 读取期间更换样本账时，不把旧材料写进新公司的业务进度', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qianlai-book-switch-'))
    const oldHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const tools = new Map<string, Tool>()
    let dispose = () => {}
    try {
      const legacy = new BookStore(join(home, 'moneycome', 'book.sqlite'))
      try { seedSampleBook(legacy, loadPack(), new Date('2026-04-01T00:00:00Z')) } finally { legacy.close() }
      mkdirSync(join(home, 'attachments'))
      const pdf = await PDFDocument.create()
      pdf.addPage([100, 100]).drawText('synthetic')
      const path = join(home, 'attachments', 'test.pdf')
      writeFileSync(path, await pdf.save())
      applyBuilt({
        effect: fn => { dispose = fn() }, tools: { register: t => { tools.set(t.name, t); return () => {} } },
        get: name => name === 'approval' ? { request: async () => 'allowed-once' } : ({ saveImage: async () => {
          await tools.get('moneycome_open_book')!.execute({ companyName: '合成企业', accountingStartMonth: '2026-01', replaceSampleBook: true }, approvedCall())
          return { type: 'synthetic-image-ref' }
        } }),
      })
      expect(await tools.get('moneycome_read_upload')!.execute({ path })).toMatchObject({ accepted: false, code: 'BOOK_CHANGED' })
      const progress = await tools.get('moneycome_work_progress')!.execute({}) as { events: { operation: string }[] }
      expect(progress.events.some(event => event.operation === 'material')).toBe(false)
    } finally {
      dispose()
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
    }
  })

  it('参数类型不对时拒绝并指出位置，不抛异常', async () => {
    const { call } = await ownBook()
    expect(await call('moneycome_set_opening_balances', { balances: '' })).toMatchObject({ accepted: false, code: 'ARGUMENT_INVALID' })
    const nested = await call('moneycome_set_opening_balances', { balances: [null] })
    expect(nested).toMatchObject({ accepted: false, code: 'ARGUMENT_INVALID' })
    expect(nested.message).toContain('balances[0]')
    expect(await call('moneycome_check_invoice', { invoiceNumber: true })).toMatchObject({ accepted: false, code: 'ARGUMENT_INVALID' })
    expect(await call('moneycome_read_referenced_pdf', { path: 'other.pdf' })).toMatchObject({ accepted: false, code: 'ARGUMENT_INVALID' })
    expect(await call('moneycome_read_referenced_pdf', { fileIndex: '2' })).toMatchObject({ accepted: false, code: 'ARGUMENT_INVALID' })
    expect(await call('moneycome_read_referenced_pdf', { page: 0 })).toMatchObject({ accepted: false, code: 'POSITION_INVALID' })
    expect(await call('moneycome_record_entry', { ...ENTRY, facts: undefined })).toMatchObject({ accepted: false, code: 'ARGUMENT_INVALID' })
  })

  it('建档中的实际经营使用专用卡，明确说以上都没有时直接保存并继续', async () => {
    const { call, bookPath, ask } = plugin()
    const question = [{ id: 'business', header: '实际经营', question: '企业实际开展了哪些业务？' }]
    expect(ask(question)).toBeUndefined()
    await call('moneycome_onboarding', { action: 'start' })

    const store = new BookStore(bookPath)
    try {
      const onboarding = new CompanyOnboarding(store)
      const manual = onboarding.setMode(onboarding.status().revision, 'manual')
      if (!manual.accepted) throw Error('Could not choose manual onboarding')
      const saved = onboarding.save(1, manual.revision, {
        companyName: '合成经营资料企业', taxId: '000000000000000094', establishedOn: '2026-01-01',
        taxpayerIdentity: 'small-scale', taxStatus: '正常', taxAuthority: '合成主管机关',
        incomeMethod: '查账征收', accountingSystem: '小企业会计准则', business: [],
      }, false)
      expect(saved).toMatchObject({ accepted: true })
      const fallback = ask(question)
      expect(fallback).toContain('请用下方钱来建档表单完成当前步骤。')
      expect(JSON.parse(fallback!.split('当前建档卡：')[1]!)).toMatchObject({
        title: '确认实际经营', fields: [{ key: 'business', type: 'multi' }],
      })
      expect(ask(question, 'not-the-setup-session')).toBeUndefined()
      expect(ask([{ question: '这笔账款是如何支付的？' }])).toBeUndefined()

      // The conflicting legacy input is refused with a usable replacement form.
      expect(await call('moneycome_onboarding', { action: 'fill', values: { business: ['goods', 'none'] } }))
        .toMatchObject({ accepted: false, card: { title: '确认实际经营' } })
      expect(await call('moneycome_onboarding', { action: 'fill', values: { business: ['none'] } }))
        .toMatchObject({ accepted: true, draftSummary: { enterprise: { business: ['none'] } }, card: { title: '确认账户情况' } })
      expect(store.company()).toBeUndefined()

      await call('moneycome_onboarding', { action: 'fill', values: { bankStatus: 'none' } })
      await call('moneycome_onboarding', { action: 'fill', values: { history: 'previous' } })
      const month = ask([{ question: '旧账（会计或代账公司）已经记到哪个月？请写明年月。' }])
      expect(JSON.parse(month!.split('当前建档卡：')[1]!)).toMatchObject({
        title: '确认记账准备', fields: [{ key: 'lastMonth', type: 'month' }, { key: 'startMonth', type: 'month' }],
      })
    } finally { store.close() }
  })

  it('可选参数给 null 当没给，字符串参数给数字转成字符串', async () => {
    const { call } = await ownBook()
    const preview = await call('moneycome_record_entry', { ...ENTRY, amounts: { contract: 1000 }, invoiceNumber: null, preview: true })
    expect(preview).toMatchObject({ accepted: true })
  })

  it('执行中出错时整笔回滚，返回 TOOL_FAILED', async () => {
    const { bookPath, call } = await ownBook()
    const other = new DatabaseSync(bookPath)
    // 写完凭证头、写分录时出错。
    other.exec('DROP TABLE voucher_leg')
    const result = await call('moneycome_record_entry', ENTRY)
    expect(result).toMatchObject({ accepted: false, code: 'TOOL_FAILED' })
    expect(other.prepare('SELECT count(*) AS n FROM voucher').get()).toEqual({ n: 0 })
    other.close()
  })

  it('另一个进程正占着写锁时等它写完，不报 database is locked', async () => {
    const { bookPath, call } = await ownBook()
    const holder = spawn(process.execPath, [
      '-e',
      `const { DatabaseSync } = require('node:sqlite')
       const db = new DatabaseSync(${JSON.stringify(bookPath)})
       db.exec('BEGIN IMMEDIATE')
       console.log('locked')
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
       db.exec('COMMIT')`,
    ])
    await once(holder.stdout, 'data')
    expect(await call('moneycome_record_entry', ENTRY)).toMatchObject({ accepted: true })
    await once(holder, 'exit')
  })
})
