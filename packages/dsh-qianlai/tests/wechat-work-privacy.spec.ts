import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { apply } from '../src/index.js'
import { BookStore } from '../src/store.js'
import { registerLoginControl } from '../src/wechat/control.js'
import { compactWechatWorkResult } from '../src/wechat/work-privacy.js'

it('微信的进度和待办详情保留编号与缺件摘要，不把桌面员工记录或文件名带出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qianlai-wechat-privacy-'))
  const bookPath = join(dir, 'book.sqlite')
  const mobile = 'synthetic-wechat-progress'
  const stop = registerLoginControl(dir, {
    run: async () => ({ status: 'connected' }),
    ownsSession: id => id === mobile,
  })
  let dispose = () => {}
  try {
    const store = new BookStore(bookPath)
    store.createCompany({ name: '合成保密案例公司', accountingStartMonth: '2026-01', isSample: false })
    const matter = store.createWorkMatter('合成员工姓名待核对', '2026-01', ['合成员工详细工资', '合同'])
    const material = store.saveWorkMaterial('synthetic-example', '合成员工私人报表.pdf', 'read', null)
    store.updateWorkMatter({ ...matter, materialLinks: [{ materialId: material.id }] })
    store.recordWork('moneycome_record_entry', { eventKind: 'payroll', summary: '合成员工工资记账' }, { accepted: true })
    store.recordWork('moneycome_record_entry', { eventKind: 'bank_fee', summary: '合成手续费摘要' }, { accepted: true, voucherNo: 'PZ-202601-001' })
    store.close()

    type Registrar = Parameters<typeof apply>[0]['tools']['register']
    const tools = new Map<string, Parameters<Registrar>[0]>()
    apply({
      effect: setup => { dispose = setup() },
      tools: { register: tool => { tools.set(tool.name, tool); return () => {} } },
    }, { bookPath })
    const call = (name: string, args: Record<string, unknown>, id = mobile) => tools.get(name)!.execute(args, {
      callId: 'privacy-test', signal: new AbortController().signal, agent: { session: { id } },
    })
    const progress = await call('moneycome_work_progress', {})
    expect(JSON.stringify(progress)).not.toContain('合成员工')
    expect(progress).toMatchObject({
      accepted: true, recentMaterialCount: 1, pendingMatterCount: 1, pendingMatters: [
        { id: matter.id, missingCount: 2, missingKinds: ['合同'], materialCount: 1 },
      ],
      events: [{ operation: 'moneycome_record_entry', voucherNo: 'PZ-202601-001' }],
    })
    const detail = await call('moneycome_work_progress', { matterId: matter.id })
    expect(detail).toMatchObject({ accepted: true, matter: { id: matter.id, period: '2026-01', missingCount: 2 } })
    expect(JSON.stringify(detail)).not.toContain('合成员工')
    const book = await call('moneycome_book_status', {})
    expect(JSON.stringify(book)).not.toContain('合成员工')
    expect(book).toMatchObject({ accepted: true, company: '合成保密案例公司', recentWork: [{ voucherNo: 'PZ-202601-001' }] })
    expect(JSON.stringify(await call('moneycome_work_progress', {}, 'synthetic-desktop-progress'))).toContain('合成员工私人报表')
  } finally {
    dispose()
    stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('渠道对当前待补事项和原件只提供通用状态，截止日期仍保留', () => {
  const reminder = { kind: 'deadline', message: '合成到期事项', period: '2026-02' }
  const confidential = { kind: 'material', matterId: 123, message: '合成私人姓名和材料' }
  const input = { accepted: true, currentWork: { reminders: [reminder], nextAction: confidential } }
  const book = compactWechatWorkResult('moneycome_book_status', input)
  expect(book).toMatchObject({ currentWork: { reminders: [reminder], nextAction: { kind: 'material' } } })
  expect(JSON.stringify(book)).not.toMatch(/合成私人|matterId/)
  expect(compactWechatWorkResult('moneycome_book_status', { ...input, currentWork: { reminders: [reminder], nextAction: reminder } }))
    .toMatchObject({ currentWork: { nextAction: reminder } })
  const archive = compactWechatWorkResult('moneycome_material_archive', {
    accepted: true, matterId: 123, title: '合成私人标题', materials: [{ name: '合成私人名称.pdf', downloadable: true }],
  })
  expect(JSON.stringify(archive)).not.toContain('合成私人')
  expect(archive).toMatchObject({ accepted: true, matterId: 123, materialCount: 1 })
})
