import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { openBook } from '../src/book.js'
import { BookStore } from '../src/store.js'
import { saveWorkNote, workProgress } from '../src/work-progress.js'

describe('跨端业务进度', () => {
  it('重启与第二个连接能续接真实记录，笔记和预演不授予记账确认', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qianlai-progress-')), 'book.sqlite')
    const first = new BookStore(path)
    openBook(first, { companyName: 'Synthetic Company', accountingStartMonth: '2026-01' })
    const id = first.recordWork('moneycome_record_entry', { preview: true }, { accepted: true })
    expect(saveWorkNote(first, '等待老板确认这笔银行入账', [id])).toMatchObject({ accepted: true, verified: false, approval: false })
    first.close()
    const second = new BookStore(path)
    const progress = workProgress(second)
    expect(progress).toMatchObject({ accepted: true, scope: 'same-local-book', company: 'Synthetic Company' })
    if (progress.accepted) expect(progress.events).toHaveLength(2)
    expect(second.postedPeriods()).toEqual([])
    second.close()
  })
  it('独立账本不可见，换掉样本账后清理旧材料和笔记', () => {
    const a = new BookStore(':memory:')
    a.createCompany({ name: 'Synthetic sample', accountingStartMonth: '2026-01', isSample: true })
    a.recordWork('material', { path: '/synthetic/attachments/1.xlsx' }, { imported: false })
    const b = new BookStore(':memory:')
    expect(b.workEvents()).toEqual([])
    openBook(a, { companyName: 'Synthetic real book', accountingStartMonth: '2026-01', replaceSampleBook: true })
    expect(a.workEvents()).toEqual([])
    expect(a.recordWork('material', { path: '/synthetic/attachments/new.xlsx' }, { imported: false })).toBeGreaterThan(1)
    expect(saveWorkNote(a, 'stale material', [1])).toMatchObject({ accepted: false, code: 'SOURCE_NOT_FOUND' })
    a.close(); b.close()
  })
  it('分页遍历全部历史，事务失败不留下已完成假记录', () => {
    const store = new BookStore(':memory:')
    openBook(store, { companyName: 'Synthetic Company', accountingStartMonth: '2026-01' })
    for (let i = 0; i < 25; i++) store.recordWork('note', { note: String(i) }, { verified: false })
    const first = workProgress(store)
    if (!first.accepted) throw Error('expected progress')
    expect(first.events).toHaveLength(20)
    const next = workProgress(store, first.nextBeforeId!)
    if (!next.accepted) throw Error('expected progress')
    expect(next.events).toHaveLength(5)
    expect(next.nextBeforeId).toBeNull()
    expect(() => store.transaction(() => { store.recordWork('failed', {}, {}); throw Error('rollback') })).toThrow()
    expect(store.workEvents()[0]?.operation).toBe('note')
    store.close()
  })
})
