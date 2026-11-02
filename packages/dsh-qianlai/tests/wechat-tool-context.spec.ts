import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { apply } from '../src/index.js'
import { registerLoginControl } from '../src/wechat/control.js'

it('二维码工具只转交宿主的来源会话，不接受模型自报会话身份', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qianlai-login-origin-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const run = vi.fn(async () => ({ status: 'disconnected' as const }))
  const off = registerLoginControl(join(home, 'moneycome'), { run })
  const tools = new Map<string, Parameters<Parameters<typeof apply>[0]['tools']['register']>[0]>()
  let dispose = () => {}
  try {
    apply({ effect: fn => { dispose = fn() }, tools: { register: tool => { tools.set(tool.name, tool); return () => {} } } })
    await tools.get('moneycome_wechat')!.execute({ action: 'start', sessionId: 'untrusted-session' },
      { signal: new AbortController().signal, agent: { session: { id: 'host-owned-session' } } })
    expect(run).toHaveBeenCalledWith('start', 'host-owned-session')
  } finally {
    dispose(); off()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
