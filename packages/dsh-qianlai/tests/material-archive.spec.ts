import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { openBook } from '../src/book.js'
import { apply } from '../src/index.js'
import { inspectMaterialArchive, registerMaterialArchive } from '../src/material-archive.js'
import { BookStore } from '../src/store.js'
import type { RpcConnection } from '../src/wechat/control.js'
import { saveWorkMatter } from '../src/work-progress.js'

type Tool = Parameters<Parameters<typeof apply>[0]['tools']['register']>[0]

describe('同一事项的原始材料和替换版本', () => {
  it('可靠保存、下载前后原件且不扩展附件读路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qianlai-material-archive-'))
    const home = process.env.DSH_HOME
    const path = join(root, 'book.sqlite')
    const store = new BookStore(path)
    const disposers: (() => void)[] = []
    try {
      process.env.DSH_HOME = root
      mkdirSync(join(root, 'attachments'))
      openBook(store, { companyName: '合成归档企业', accountingStartMonth: '2026-01' })
      const oldBytes = Buffer.from('amount,100.12\n')
      const newBytes = Buffer.from('amount,110.12\n')
      const oldPath = join(root, 'attachments', '合成付款凭据旧版.csv')
      const newPath = join(root, 'attachments', '合成付款凭据新版.csv')
      const outside = join(root, 'out.csv')
      writeFileSync(oldPath, oldBytes)
      writeFileSync(newPath, newBytes)
      writeFileSync(outside, 'amount,999\n')
      const tools = new Map<string, Tool>()
      apply({
        effect(fn) { disposers.push(fn()) },
        tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      }, { bookPath: path })
      const read = tools.get('moneycome_read_upload')!
      expect(await read.execute({ path: outside })).toMatchObject({ accepted: false, code: 'FILE_OUTSIDE_UPLOADS' })
      const accepted = async (file: string) => await read.execute({ path: file }) as { material: { id: number } }
      const first = (await accepted(oldPath)).material
      const second = (await accepted(newPath)).material
      expect((await accepted(oldPath)).material.id).toBe(first.id)
      expect(Buffer.from(store.workMaterialOriginal(first.id)!)).toEqual(oldBytes)
      expect(Buffer.from(store.workMaterialOriginal(second.id)!)).toEqual(newBytes)
      expect(store.recentWorkMaterials()).toHaveLength(2)

      const task = saveWorkMatter(store, { action: 'create-matter', title: '合成报销', period: '2026-01', missing: [] })
      if (!task.accepted) throw Error('missing task')
      const matterId = task.matter.id
      expect(saveWorkMatter(store, { action: 'attach-material', matterId, revision: task.matter.revision, materialId: first.id }))
        .toMatchObject({ accepted: true })
      expect(saveWorkMatter(store, { action: 'attach-material', matterId, revision: task.matter.revision + 1, materialId: second.id, replacesMaterialId: first.id }))
        .toMatchObject({ accepted: true })

      disposers.pop()?.()
      const reopen = new BookStore(path)
      try {
        const list = inspectMaterialArchive(reopen, matterId)
        expect(list).toMatchObject({ accepted: true, materials: [
          { id: first.id, downloadable: true, superseded: true },
          { id: second.id, downloadable: true, priorName: '合成付款凭据旧版.csv', superseded: false },
        ] })
        const callId = 'synthetic-material-archive'
        let handler!: Parameters<RpcConnection['fetch']['register']>[0]['fetch']
        registerMaterialArchive({ fetch: { register(route) { handler = route.fetch; return async () => {} } } }, reopen, {
          async inspect(id) {
            return { meta: { agentPreset: 'moneycome-zhangjie' }, events: id === 'current' ? [
              { type: 'tool/call', data: { name: 'moneycome_material_archive', callId } },
              { type: 'tool/result', data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text: JSON.stringify(list) }] } } },
            ] : [] }
          },
        })
        const request = async (params: Record<string, unknown>) =>
          (await (await handler(new Request('http://localhost/api/qianlai/material-archive', { method: 'POST',
            body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'qianlai/material-archive',
              payload: { callId, sessionId: 'current', matterId, materialId: first.id, ...params } }) }))).json()).result.value
        expect(await request({ sessionId: 'other' })).toMatchObject({ code: 'MATERIAL_DOWNLOAD_UNAUTHORIZED' })
        expect(await request({ callId: 'fake' })).toMatchObject({ code: 'MATERIAL_DOWNLOAD_UNAUTHORIZED' })
        expect(await request({ matterId: matterId + 1 })).toMatchObject({ code: 'MATERIAL_DOWNLOAD_UNAUTHORIZED' })
        expect(Buffer.from((await request({})).base64, 'base64')).toEqual(oldBytes)
        expect(Buffer.from((await request({ materialId: second.id })).base64, 'base64')).toEqual(newBytes)
      } finally { reopen.close() }
    } finally {
      disposers.pop()?.()
      store.close()
      if (home === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = home
      rmSync(root, { recursive: true, force: true })
    }
  })
})
