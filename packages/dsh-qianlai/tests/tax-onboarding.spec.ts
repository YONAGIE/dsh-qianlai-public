import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'

import { openTaxBrowser } from '../src/tax-browser.js'
import { registerTaxOnboarding, type TaxDraftAccess } from '../src/tax-onboarding.js'
import { openTaxPortalLogin, readTaxProfile, type TaxProfile } from '../src/tax-portal.js'
import { taxPortalFor } from '../src/tax-portals.js'

vi.mock('../src/tax-browser.js', () => ({ openTaxBrowser: vi.fn() }))
vi.mock('../src/tax-portal.js', async importOriginal => ({
  ...await importOriginal<object>(),
  openTaxPortalLogin: vi.fn(),
  readTaxProfile: vi.fn(),
}))

function fixture(access: TaxDraftAccess, draftId = randomUUID(), sessionId = 'synthetic-session') {
  let route: ((request: Request) => Promise<Response>) | undefined
  const unregister = registerTaxOnboarding({ fetch: { register(definition) {
    route = definition.fetch
    return async () => {}
  } } }, process.cwd(), access)
  const id = randomUUID()
  const call = async (action: string, payload = {}, signal?: AbortSignal) => {
    const response = await route!(new Request('http://localhost/api/qianlai/tax-onboarding', {
      method: 'POST', ...(signal ? { signal } : {}),
      body: JSON.stringify({ type: 'client-request', method: 'qianlai/tax-onboarding', rpcId: randomUUID(), payload: { id, action, draftId, sessionId, ...payload } }),
    }))
    return (await response.json() as { result: { ok: boolean; value?: unknown } }).result
  }
  return { call, unregister }
}

const beijing = {
  province: '北京市', city: '北京市', companyName: '合成服务企业', taxId: '91110000MA00000000',
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => { resolve = done })
  return { promise, resolve }
}

it.each([
  { province: '浙江省', city: '杭州市', taxId: '91330000MA00000000', authority: '国家税务总局杭州市某区税务局', region: 'zhejiang' },
  { province: '北京市', city: '北京市', taxId: '91110000MA00000000', authority: '国家税务总局北京市某区税务局', region: 'beijing' },
])('$province 只让来源会话确认服务端核对的税务资料', async ({ province, city, taxId, authority, region }) => {
  vi.clearAllMocks()
  const browser = { close: vi.fn(async () => {}), on: vi.fn(), newContext: vi.fn(async () => ({})) }
  vi.mocked(openTaxBrowser).mockResolvedValue(browser as never)
  vi.mocked(openTaxPortalLogin).mockResolvedValue({} as never)
  const expected = { companyName: '合成服务企业', taxId }
  const target = { province, city, ...expected }
  const profile: TaxProfile = {
    ...expected, authority, obligations: [{ taxItem: '增值税', filingCycle: '按季' }],
    obligationCoverage: 'visible_page', observedAt: '2026-11-15T08:00:00.000Z',
    sourceUrl: `https://etax.${region}.chinatax.gov.cn:8443/`,
  }
  vi.mocked(readTaxProfile).mockResolvedValue(profile)
  const draftId = randomUUID()
  const sessionId = 'synthetic-session'
  const access = {
    check: vi.fn((target: { draftId: string; sessionId: string }) => target.draftId === draftId && target.sessionId === sessionId
      ? { accepted: true as const }
      : { accepted: false as const, message: '这份建档已变更。' }),
    apply: vi.fn(async () => ({ accepted: true as const })),
  }
  const { call, unregister } = fixture(access, draftId, sessionId)
  try {
    expect(await call('start', { province: '浙江省', city: '上海市', ...expected })).toMatchObject({ ok: false })
    expect(await call('start', { province: '浙江省', city: '宁波市', ...expected })).toMatchObject({ ok: false })
    expect(await call('start', { province: '上海市', city: '上海市', ...expected })).toMatchObject({ ok: false })
    expect(await call('start', { ...target, sessionId: 'other-session' })).toMatchObject({ ok: false })
    expect(await call('start', { ...target, draftId: randomUUID() })).toMatchObject({ ok: false })
    expect(openTaxBrowser).not.toHaveBeenCalled()
    expect(await call('start', target)).toMatchObject({ value: { phase: 'opening' } })
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'waiting' } }))
    const site = taxPortalFor(province, city)
    expect(openTaxPortalLogin).toHaveBeenCalledWith(expect.objectContaining({
      loginOrigin: `https://tpass.${region}.chinatax.gov.cn:8443`,
    }), expect.anything(), expect.any(AbortSignal))
    await call('read')
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'ready', profile } }))
    expect(readTaxProfile).toHaveBeenCalledWith(site, expect.anything(), expected, expect.any(AbortSignal))
    expect(await call('status', { id: randomUUID() })).toMatchObject({ value: { phase: 'idle' } })
    expect(await call('status', { draftId: randomUUID() })).toMatchObject({ value: { phase: 'idle' } })
    expect(await call('submit', { sessionId: 'other-session' })).toMatchObject({ value: { phase: 'idle' } })
    expect(await call('cancel', { sessionId: 'other-session' })).toMatchObject({ value: { phase: 'idle' } })
    expect(await call('cancel', { draftId: randomUUID() })).toMatchObject({ value: { phase: 'idle' } })
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(access.apply).not.toHaveBeenCalled()
    await call('submit', { profile: { ...profile, taxpayerQualification: '伪造资格' } })
    await call('submit')
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'submitted' } }))
    expect(access.apply).toHaveBeenCalledTimes(1)
    expect(access.apply).toHaveBeenCalledWith({ sessionId, draftId, ...target }, profile, expect.any(AbortSignal))
    expect(await call('cancel')).toMatchObject({ value: { phase: 'idle' } })
  } finally {
    unregister()
  }
})

it.each(['cancel', 'abort'])('%s 中断尚未核对完成的扫码，迟到的核对结果不会开启浏览器或关闭新的扫码', async method => {
  vi.clearAllMocks()
  const pendingCheck = deferred<{ accepted: true }>()
  const check = vi.fn<TaxDraftAccess['check']>().mockResolvedValue({ accepted: true }).mockReturnValueOnce(pendingCheck.promise)
  const apply = vi.fn<TaxDraftAccess['apply']>()
  const browser = { close: vi.fn(async () => {}), on: vi.fn(), newContext: vi.fn(async () => ({})) }
  vi.mocked(openTaxBrowser).mockResolvedValue(browser as never)
  vi.mocked(openTaxPortalLogin).mockResolvedValue({} as never)
  const { call, unregister } = fixture({ check, apply })
  try {
    const request = new AbortController()
    const first = call('start', beijing, request.signal)
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    if (method === 'cancel') expect(await call('cancel')).toMatchObject({ value: { phase: 'idle' } })
    else request.abort()
    expect(check.mock.calls[0]?.[1].aborted).toBe(true)
    expect(openTaxBrowser).not.toHaveBeenCalled()

    const nextId = randomUUID()
    expect(await call('start', { ...beijing, id: nextId })).toMatchObject({ value: { phase: 'opening' } })
    pendingCheck.resolve({ accepted: true })
    expect(await first).toMatchObject({ value: { phase: 'idle' } })
    expect(await call('cancel')).toMatchObject({ value: { phase: 'idle' } })
    expect(await call('status', { id: nextId })).toMatchObject({ value: { phase: 'waiting' } })
    expect(openTaxBrowser).toHaveBeenCalledTimes(1)
    expect(browser.close).not.toHaveBeenCalled()
  } finally { unregister() }
})

it.each(['status', 'start'])('切回手填后的 %s 会关闭旧窗口，迟到的官方结果无法回填', async action => {
  vi.clearAllMocks()
  const pendingRead = deferred<TaxProfile>()
  const browser = { close: vi.fn(async () => {}), on: vi.fn(), newContext: vi.fn(async () => ({})) }
  vi.mocked(openTaxBrowser).mockResolvedValue(browser as never)
  vi.mocked(openTaxPortalLogin).mockResolvedValue({} as never)
  vi.mocked(readTaxProfile).mockReturnValueOnce(pendingRead.promise)
  const profile: TaxProfile = {
    companyName: beijing.companyName, taxId: beijing.taxId, authority: '国家税务总局北京市某区税务局',
    obligations: [], obligationCoverage: 'visible_page', observedAt: '2026-11-16T08:00:00.000Z',
    sourceUrl: 'https://etax.beijing.chinatax.gov.cn:8443/',
  }
  let manual = false
  const check = vi.fn<TaxDraftAccess['check']>(() => manual
    ? { accepted: false, message: '这份建档已切换为手工填写。' }
    : { accepted: true })
  const apply = vi.fn<TaxDraftAccess['apply']>()
  const { call, unregister } = fixture({ check, apply })
  try {
    await call('start', beijing)
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'waiting' } }))
    expect(await call('read')).toMatchObject({ value: { phase: 'reading' } })
    const readSignal = vi.mocked(readTaxProfile).mock.calls[0]?.[3]

    manual = true
    expect(await call(action, beijing)).toMatchObject({ value: { phase: 'failed', message: '这份建档已切换为手工填写。' } })
    expect(readSignal?.aborted).toBe(true)
    pendingRead.resolve(profile)
    expect(await call('submit')).toMatchObject({ value: { phase: 'failed' } })
    expect((await call('status')).value).not.toHaveProperty('profile')
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
  } finally { unregister() }
})
