import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { openBook, setOpeningBalances } from '../src/book.js'
import { recordEntry } from '../src/entries.js'
import { loadPack } from '../src/pack.js'
import { exportReviewPack } from '../src/review-pack.js'
import { BookStore } from '../src/store.js'

const failure = vi.hoisted(() => ({ writes: 0, failAt: 0 }))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof FileSystem>()
  return { ...original, writeFileSync: (...args: Parameters<typeof original.writeFileSync>) => {
    if (failure.failAt && ++failure.writes === failure.failAt) throw Error('synthetic disk failure')
    return original.writeFileSync(...args)
  } }
})
const pack = loadPack()
const now = new Date('2026-04-02T00:00:00Z')
const stores: BookStore[] = []
const roots: string[] = []
afterEach(() => {
  failure.failAt = 0
  failure.writes = 0
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const store = new BookStore(':memory:')
  stores.push(store)
  openBook(store, { companyName: '合成导出快照企业', accountingStartMonth: '2026-01' })
  setOpeningBalances(store, pack, [], now)
  const root = mkdtempSync(join(tmpdir(), 'qianlai-snapshots-'))
  roots.push(root)
  return { store, root }
}
describe('复核材料独立快照', () => {
  it('相同时间重复导出也不覆盖先前交付的快照', () => {
    const { store, root } = fixture()
    const first = exportReviewPack(store, pack, '2026-01', root, now)
    if (!first.accepted) throw Error('export failed')
    const before = new Map(first.files.map(name => [name, readFileSync(join(first.dir, name))]))
    expect(recordEntry(store, pack, { date: '2026-01-10', summary: '=合成手续费', eventKind: 'bank_fee',
      facts: { 'settlement.method': 'bank' }, amounts: { settlement: '10.00' } }, now)).toMatchObject({ accepted: true })
    const second = exportReviewPack(store, pack, '2026-01', root, now)
    if (!second.accepted) throw Error('export failed')
    expect(second.dir).not.toBe(first.dir)
    expect(first.files).toHaveLength(8)
    for (const [name, bytes] of before) expect(readFileSync(join(first.dir, name))).toEqual(bytes)
    expect(readFileSync(join(second.dir, '3-凭证.csv'), 'utf8')).toContain("'=合成手续费")
  })

  it('写入中断不发布残缺目录，也不改动原有快照和账本', () => {
    const { store, root } = fixture()
    const first = exportReviewPack(store, pack, '2026-01', root, now)
    if (!first.accepted) throw Error('export failed')
    const names = readdirSync(root)
    const bytes = readFileSync(join(first.dir, '1-资产负债表.csv'))
    const vouchers = store.vouchers({ periodKey: '2026-01' })
    failure.failAt = 2
    expect(() => exportReviewPack(store, pack, '2026-01', root, new Date(now.getTime() + 1000))).toThrow('synthetic disk failure')
    expect(readdirSync(root)).toEqual(names)
    expect(readFileSync(join(first.dir, '1-资产负债表.csv'))).toEqual(bytes)
    expect(store.vouchers({ periodKey: '2026-01' })).toEqual(vouchers)
  })
})
