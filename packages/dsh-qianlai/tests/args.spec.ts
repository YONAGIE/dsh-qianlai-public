import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { checkArgs } from '../src/args.js'
import { apply } from '../src/index.js'
import { registerLoginControl } from '../src/wechat/control.js'

const schema = { type: 'object', properties: { action: { type: 'string', enum: ['status', 'start', 'refresh'] } }, required: ['action'] }

describe('工具参数枚举', () => {
  it('拒绝未声明的操作', () => {
    expect(checkArgs(schema, { action: 'unsupported-action' }).problems).toEqual([expect.stringContaining('action')])
  })
  it.each(['status', 'start', 'refresh'])('接受明确声明的 %s', action => {
    expect(checkArgs(schema, { action }).problems).toEqual([])
  })
  it('先做现有类型整理，再比较枚举，不改变数字字符串兼容行为', () => {
    expect(checkArgs({ type: 'object', properties: { code: { type: 'string', enum: ['1', '2'] } } }, { code: 1 }))
      .toEqual({ args: { code: '1' }, problems: [] })
  })
  it('嵌套数组中的枚举也指出准确位置', () => {
    expect(checkArgs({ type: 'object', properties: { rows: { type: 'array', items: { type: 'object',
      properties: { direction: { type: 'string', enum: ['in', 'out'] } },
    } } } }, { rows: [{ direction: 'sideways' }] }).problems).toEqual([expect.stringContaining('rows[0].direction')])
  })

  it('真实注册的微信工具在控制器执行前拒绝非法枚举', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qianlai-enum-'))
    const original = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const run = vi.fn(async () => ({ status: 'disconnected' as const }))
    const off = registerLoginControl(join(home, 'moneycome'), { run })
    const tools = new Map<string, { execute(args: Record<string, unknown>): Promise<unknown> }>()
    let dispose = () => {}
    try {
      apply({ effect: fn => { dispose = fn() }, tools: { register: tool => { tools.set(tool.name, tool); return () => {} } } }, { bookPath: join(home, 'book.sqlite') })
      expect(await tools.get('moneycome_wechat')!.execute({ action: 'unsupported-action' })).toMatchObject({ accepted: false, code: 'ARGUMENT_INVALID' })
      expect(run).not.toHaveBeenCalled()
      expect(await tools.get('moneycome_wechat')!.execute({ action: 'status' })).toMatchObject({ accepted: true, status: 'disconnected' })
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      dispose(); off()
      if (original === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = original
      rmSync(home, { recursive: true, force: true })
    }
  })
})
