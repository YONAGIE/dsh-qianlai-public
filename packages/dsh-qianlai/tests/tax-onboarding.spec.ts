import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'

import { openTaxBrowser } from '../src/tax-browser.js'
import { registerTaxOnboarding } from '../src/tax-onboarding.js'
import { openZhejiangLogin, readZhejiangTaxInfo, type TaxProfile } from '../src/zhejiang-tax.js'

vi.mock('../src/tax-browser.js', () => ({ openTaxBrowser: vi.fn() }))
vi.mock('../src/zhejiang-tax.js', async importOriginal => ({
  ...await importOriginal<object>(),
  openZhejiangLogin: vi.fn(),
  readZhejiangTaxInfo: vi.fn(),
}))

it('核对完成才向来源会话提交一次税务资料，其他流无法读取', async () => {
  const browser = { close: vi.fn(async () => {}), on: vi.fn(), newContext: vi.fn(async () => ({})) }
  vi.mocked(openTaxBrowser).mockResolvedValue(browser as never)
  vi.mocked(openZhejiangLogin).mockResolvedValue({} as never)
  const expected = { companyName: '合成服务企业', taxId: '91330000MA00000000' }
  const profile: TaxProfile = {
    ...expected, authority: '合成税务机关', obligations: [{ taxItem: '增值税', filingCycle: '按季' }],
    obligationCoverage: 'visible_page', observedAt: '2026-11-15T08:00:00.000Z',
    sourceUrl: 'https://etax.zhejiang.chinatax.gov.cn:8443/',
  }
  vi.mocked(readZhejiangTaxInfo).mockResolvedValue(profile)
  let route: ((request: Request) => Promise<Response>) | undefined
  const sessions = {
    inspect: vi.fn(async () => ({ meta: { agentPreset: 'moneycome-zhangjie' }, events: [] })),
    prompt: vi.fn(async () => ({})),
  }
  const unregister = registerTaxOnboarding({ fetch: { register(definition) {
    route = definition.fetch
    return async () => {}
  } } }, process.cwd(), sessions)
  const id = randomUUID()
  const call = async (action: string, payload = {}) => {
    const response = await route!(new Request('http://localhost/api/qianlai/tax-onboarding', {
      method: 'POST', body: JSON.stringify({ type: 'client-request', method: 'qianlai/tax-onboarding', rpcId: randomUUID(), payload: { id, action, ...payload } }),
    }))
    return (await response.json() as { result: { ok: boolean; value?: unknown } }).result
  }
  try {
    expect(await call('start', { region: 'ningbo', ...expected })).toMatchObject({ ok: false })
    expect(await call('start', { region: 'zhejiang', sessionId: 'synthetic-session', ...expected })).toMatchObject({ value: { phase: 'opening' } })
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'waiting' } }))
    await call('read')
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'ready', profile } }))
    expect(await call('status', { id: randomUUID() })).toMatchObject({ value: { phase: 'idle' } })
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(sessions.prompt).not.toHaveBeenCalled()
    await call('submit')
    await call('submit')
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'submitted' } }))
    expect(sessions.prompt).toHaveBeenCalledTimes(1)
    expect(sessions.prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'synthetic-session' }), expect.any(AbortSignal))
    expect(await call('cancel')).toMatchObject({ value: { phase: 'idle' } })
  } finally {
    unregister()
  }
})
