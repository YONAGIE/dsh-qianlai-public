import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright-core'
import { beforeEach, expect, it, vi } from 'vitest'

import { openTaxBrowser } from '../src/tax-browser.js'
import { registerTaxOnboarding, type TaxDraftAccess } from '../src/tax-onboarding.js'
import { openTaxPortalLogin, readTaxProfile, TaxPortalError, waitForTaxPortalLogin, type TaxProfile } from '../src/tax-portal.js'
import { taxPortalFor } from '../src/tax-portals.js'

vi.mock('../src/tax-browser.js', () => ({ openTaxBrowser: vi.fn() }))
vi.mock('../src/tax-portal.js', async importOriginal => ({
  ...await importOriginal<object>(),
  openTaxPortalLogin: vi.fn(),
  readTaxProfile: vi.fn(),
  waitForTaxPortalLogin: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(waitForTaxPortalLogin).mockImplementation(() => new Promise(() => {}))
})

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
  return { call, id, unregister }
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
  { province: '浙江省', city: '杭州市', taxId: '91330000MA00000000', authority: '国家税务总局杭州市某区税务局', region: 'zhejiang', prefilled: true },
  { province: '北京市', city: '北京市', taxId: '91110000MA00000000', authority: '国家税务总局北京市某区税务局', region: 'beijing', prefilled: false },
])('$province 在选择企业后自动取数，来源会话确认后才回填', async ({ province, city, taxId, authority, region, prefilled }) => {
  const browser = { close: vi.fn(async () => {}), on: vi.fn(), newContext: vi.fn(async () => ({})) }
  vi.mocked(openTaxBrowser).mockResolvedValue(browser as never)
  vi.mocked(openTaxPortalLogin).mockResolvedValue({} as never)
  const login = deferred<Page>()
  const loggedInPage = {} as Page
  vi.mocked(waitForTaxPortalLogin).mockReturnValueOnce(login.promise)
  const expected = { companyName: '合成服务企业', taxId }
  const initialIdentity = prefilled ? expected : { companyName: '', taxId: '' }
  const target = { province, city, ...initialIdentity }
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
  const { call, id, unregister } = fixture(access, draftId, sessionId)
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
    expect(readTaxProfile).not.toHaveBeenCalled()
    login.resolve(loggedInPage)
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'ready', profile } }))
    expect(readTaxProfile).toHaveBeenCalledTimes(1)
    expect(readTaxProfile).toHaveBeenCalledWith(site, loggedInPage, initialIdentity, expect.any(AbortSignal))
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
    expect(access.apply).toHaveBeenCalledWith({ sessionId, draftId, ...target }, profile, id, expect.any(AbortSignal))
    expect(await call('cancel')).toMatchObject({ value: { phase: 'idle' } })
  } finally {
    unregister()
  }
})

it.each(['cancel', 'abort'])('%s 中断尚未核对完成的扫码，迟到的核对结果不会开启浏览器或关闭新的扫码', async method => {
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
    await vi.waitFor(() => expect(readTaxProfile).toHaveBeenCalledTimes(1))
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

it.each(['cancel', 'timeout'])('%s 后停止等待登录，迟到的授权页面无法触发取数', async action => {
  vi.useFakeTimers()
  const login = deferred<Page>()
  const browser = { close: vi.fn(async () => {}), on: vi.fn(), newContext: vi.fn(async () => ({})) }
  vi.mocked(openTaxBrowser).mockResolvedValue(browser as never)
  vi.mocked(openTaxPortalLogin).mockResolvedValue({} as never)
  vi.mocked(waitForTaxPortalLogin).mockReturnValueOnce(login.promise)
  const { call, unregister } = fixture({ check: () => ({ accepted: true }), apply: vi.fn() })
  try {
    await call('start', { province: beijing.province, city: beijing.city })
    expect(await call('status')).toMatchObject({ value: { phase: 'waiting' } })
    if (action === 'cancel') {
      expect(await call('cancel')).toMatchObject({ value: { phase: 'idle' } })
    } else {
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(await call('status')).toMatchObject({ value: { phase: 'failed', message: expect.stringContaining('超时') } })
    }
    expect(vi.mocked(waitForTaxPortalLogin).mock.calls[0]?.[2].aborted).toBe(true)
    login.resolve({} as Page)
    await Promise.resolve()
    expect(readTaxProfile).not.toHaveBeenCalled()
    expect(browser.close).toHaveBeenCalledTimes(1)
  } finally {
    unregister()
    vi.useRealTimers()
  }
})

it('官方登录完成后遇到未知查询页面，只在可手动重试时提示重试', async () => {
  const login = deferred<Page>()
  const browser = { close: vi.fn(async () => {}), on: vi.fn(), newContext: vi.fn(async () => ({})) }
  const profile: TaxProfile = {
    companyName: beijing.companyName, taxId: beijing.taxId, authority: '国家税务总局北京市某区税务局',
    obligations: [], obligationCoverage: 'visible_page', observedAt: '2026-11-16T08:00:00.000Z',
    sourceUrl: 'https://etax.beijing.chinatax.gov.cn:8443/',
  }
  vi.mocked(openTaxBrowser).mockResolvedValue(browser as never)
  vi.mocked(openTaxPortalLogin).mockResolvedValue({} as never)
  vi.mocked(waitForTaxPortalLogin).mockReturnValueOnce(login.promise)
  vi.mocked(readTaxProfile).mockRejectedValueOnce(new TaxPortalError('TAX_QUERY_UNRECOGNIZED', '合成查询失败'))
    .mockResolvedValueOnce(profile)
  const { call, unregister } = fixture({ check: () => ({ accepted: true }), apply: vi.fn() })
  try {
    await call('start', beijing)
    const waiting = await call('status')
    expect(waiting.value).toMatchObject({ phase: 'waiting' })
    expect(waiting.value).not.toHaveProperty('retryRead')
    login.resolve({} as Page)
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'waiting', retryRead: true } }))
    expect(browser.close).not.toHaveBeenCalled()
    await call('read')
    await vi.waitFor(async () => expect(await call('status')).toMatchObject({ value: { phase: 'ready', profile } }))
    expect((await call('status')).value).not.toHaveProperty('retryRead')
    expect(readTaxProfile).toHaveBeenCalledTimes(2)
  } finally { unregister() }
})
