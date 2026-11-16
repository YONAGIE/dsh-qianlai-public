import { join } from 'node:path'

import type { Browser, Page } from 'playwright-core'

import { openTaxBrowser } from './tax-browser.js'
import { openTaxPortalLogin, readTaxProfile, TaxPortalError, waitForTaxPortalLogin, type TaxProfile } from './tax-portal.js'
import { isTaxRegion, taxPortalFor, type TaxPortal } from './tax-portals.js'
import type { RpcConnection } from './wechat/control.js'

type Phase = 'opening' | 'waiting' | 'reading' | 'ready' | 'submitting' | 'submitted' | 'failed'
interface Flow {
  id: string
  target: TaxOnboardingTarget
  site: TaxPortal
  phase: Phase
  abort: AbortController
  checked?: true
  expiry?: NodeJS.Timeout
  browser?: Browser
  page?: Page
  watchingLogin?: true
  retryRead?: true
  profile?: TaxProfile
  message?: string
}

export interface TaxOnboardingTarget {
  sessionId: string
  draftId: string
  province: string
  city: string
  companyName: string
  taxId: string
}

type DraftAccessResult = { accepted: true } | { accepted: false; message: string }

export interface TaxDraftAccess {
  check(target: TaxOnboardingTarget, signal: AbortSignal): DraftAccessResult | Promise<DraftAccessResult>
  apply(target: TaxOnboardingTarget, profile: TaxProfile, flowId: string, signal: AbortSignal): DraftAccessResult | Promise<DraftAccessResult>
}

const portalFallback = '暂未读到完整的税务资料。请打开官方页面的「纳税人信息查询」后重试，或上传官方导出或截图。'
const waitingForLogin = '请在官方页面扫码并选择企业。进入企业业务后，张姐会自动读取资料。'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerTaxOnboarding(connection: RpcConnection, dshHome: string, access: TaxDraftAccess) {
  let current: Flow | undefined

  function closeBrowser(flow: Flow) {
    const browser = flow.browser
    delete flow.browser
    delete flow.page
    if (browser) void browser.close().catch(() => undefined)
  }

  function end(flow: Flow) {
    clearTimeout(flow.expiry)
    flow.abort.abort()
    closeBrowser(flow)
    delete flow.profile
    delete flow.retryRead
  }

  function fail(flow: Flow, message: string) {
    end(flow)
    flow.phase = 'failed'
    flow.message = message
  }

  function discard(flow: Flow) {
    if (current === flow) current = undefined
    end(flow)
  }

  async function revalidate(flow: Flow, requestSignal: AbortSignal) {
    const draftCanChange = () => !['submitting', 'submitted', 'failed'].includes(flow.phase)
    if (!flow.checked || !draftCanChange()) return flow
    const signal = AbortSignal.any([requestSignal, flow.abort.signal])
    const result = await access.check(flow.target, signal)
    if (current !== flow || signal.aborted) return undefined
    if (!result.accepted && draftCanChange()) fail(flow, result.message)
    return flow
  }

  async function open(flow: Flow) {
    try {
      const browser = await openTaxBrowser(join(dshHome, 'moneycome', 'tax-browser-cache'), flow.abort.signal)
      if (flow.abort.signal.aborted) { await browser.close(); return }
      flow.browser = browser
      browser.on('disconnected', () => {
        if (flow.browser !== browser) return
        fail(flow, '官方登录窗口已关闭。可重新打开，或上传官方导出或截图。')
      })
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1360, height: 900 }, acceptDownloads: false })
      const page = await openTaxPortalLogin(flow.site, context, flow.abort.signal)
      if (flow.abort.signal.aborted) return
      flow.page = page
      flow.phase = 'waiting'
      flow.message = waitingForLogin
      void watchLogin(flow, page)
    } catch {
      if (flow.abort.signal.aborted) return
      fail(flow, '未能打开官方企业扫码页面。请重试，或上传官方导出或截图。')
    }
  }

  async function watchLogin(flow: Flow, page: Page) {
    if (flow.watchingLogin) return
    flow.watchingLogin = true
    try {
      const portal = await waitForTaxPortalLogin(flow.site, page, flow.abort.signal)
      startRead(flow, portal)
    } catch {
      if (flow.phase === 'waiting' && !flow.abort.signal.aborted)
        fail(flow, '未能确认已进入企业业务。请重新扫码并选择企业，或上传官方导出或截图。')
    } finally {
      delete flow.watchingLogin
    }
  }

  function startRead(flow: Flow, page: Page) {
    if (current !== flow || flow.phase !== 'waiting' || flow.abort.signal.aborted) return
    flow.phase = 'reading'
    delete flow.message
    delete flow.retryRead
    void read(flow, page)
  }

  async function read(flow: Flow, page: Page) {
    try {
      const signal = flow.abort.signal
      await revalidate(flow, signal)
      if (signal.aborted) return
      const { companyName, taxId } = flow.target
      const profile = await readTaxProfile(flow.site, page, { companyName, taxId }, signal)
      await revalidate(flow, signal)
      if (signal.aborted) return
      flow.profile = profile
      flow.phase = 'ready'
      closeBrowser(flow)
    } catch (error) {
      if (flow.abort.signal.aborted) return
      flow.phase = 'waiting'
      if (error instanceof TaxPortalError && error.code === 'TAX_LOGIN_PENDING') {
        flow.message = waitingForLogin
        if (flow.page) void watchLogin(flow, flow.page)
        return
      }
      flow.retryRead = true
      if (error instanceof TaxPortalError && error.code === 'TAX_IDENTITY_MISMATCH') {
        flow.message = '官方页面的企业与本次填写的信息不一致。请核对所选企业后再读取。'
      } else if (error instanceof TaxPortalError && error.code === 'TAX_AUTHORITY_UNVERIFIED') {
        flow.message = '未能核对主管税务机关。请确认当前企业的税务地区，或提供官方资料。'
      } else {
        flow.message = portalFallback
      }
    }
  }

  async function submit(flow: Flow, profile: TaxProfile) {
    try {
      const signal = flow.abort.signal
      const result = await access.apply(flow.target, profile, flow.id, signal)
      if (signal.aborted) return
      flow.phase = result.accepted ? 'submitted' : 'ready'
      if (result.accepted) delete flow.profile
      else flow.message = result.message
    } catch {
      if (flow.abort.signal.aborted) return
      flow.phase = 'ready'
      flow.message = '税务资料暂时无法回填。请返回建档核对企业信息后重试。'
    }
  }

  const off = connection.fetch.register({
    path: '/api/qianlai/tax-onboarding', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let envelope: { type?: unknown; method?: unknown; rpcId?: unknown; payload?: Record<string, unknown> }
      try { envelope = await request.json() as typeof envelope } catch { return new Response('Invalid request', { status: 400 }) }
      if (!envelope || envelope.type !== 'client-request' || envelope.method !== 'qianlai/tax-onboarding'
          || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 128) return new Response('Invalid request', { status: 400 })
      const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result }, { headers: { 'Cache-Control': 'no-store' } })
      const refuse = (message: string) => reply({ ok: false, error: { code: 'invalid-argument', message, details: {} } })
      const payload = envelope.payload
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return refuse('请选择建档操作。')
      const { action, id, province, city, companyName, taxId, sessionId, draftId } = payload
      if (typeof id !== 'string' || !UUID.test(id) || typeof action !== 'string'
          || typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId)
          || typeof draftId !== 'string' || !UUID.test(draftId)
          || !['start', 'status', 'read', 'cancel', 'submit'].includes(action) || request.signal.aborted) return refuse('请选择建档操作。')
      const value = (flow?: Flow) => reply({ ok: true, value: flow
        ? { phase: flow.phase, message: flow.message, profile: flow.profile, retryRead: flow.retryRead }
        : { phase: 'idle' } })
      const findOwnFlow = () => current && current.id === id && current.target.sessionId === sessionId && current.target.draftId === draftId
        ? current
        : undefined
      if (action === 'start') {
        if (typeof province !== 'string' || typeof city !== 'string' || !isTaxRegion(province, city))
          return refuse('请先选择省份和城市或地区。')
        const site = taxPortalFor(province, city)
        if (!site)
          return refuse('所选地区暂未接入扫码取数。请提供该地区电子税务局的官方导出或截图。')
        const name = companyName === undefined ? '' : companyName
        const code = taxId === undefined ? '' : taxId
        if (typeof name !== 'string' || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name)
            || typeof code !== 'string' || (code && !/^[0-9A-Z]{18}$/.test(code)))
          return refuse('请核对已填写的企业全称和 18 位统一社会信用代码。')
        const target = { sessionId, draftId, province, city, companyName: name.trim(), taxId: code }
        if (current && !['failed', 'submitted'].includes(current.phase)) {
          const own = findOwnFlow()
          if (!own || own.target.companyName !== target.companyName || own.target.taxId !== target.taxId
              || own.target.province !== province || own.target.city !== city)
            return refuse('另一个建档窗口正在使用税务浏览器，请先完成或关闭它。')
          try { return value(await revalidate(own, request.signal)) }
          catch { return refuse('暂时无法核对当前建档。请刷新后重试。') }
        }
        if (current) discard(current)
        const flow: Flow = {
          id, target, site, phase: 'opening', abort: new AbortController(),
        }
        current = flow
        flow.expiry = setTimeout(() => {
          if (current !== flow) return
          if (flow.phase === 'submitted') discard(flow)
          else fail(flow, '本次扫码取数已超时。请重新扫码，或上传官方导出或截图。')
        }, 15 * 60_000)
        flow.expiry.unref()
        // Reserve the operation before checking the session. Leaving scan mode
        // can now cancel it even if authorization is still in progress.
        const signal = AbortSignal.any([request.signal, flow.abort.signal])
        const abortStart = () => {
          if (current === flow) discard(flow)
        }
        signal.addEventListener('abort', abortStart, { once: true })
        try {
          signal.throwIfAborted()
          const result = await access.check(target, signal)
          if (current !== flow) return value()
          signal.throwIfAborted()
          if (!result.accepted) {
            discard(flow)
            return refuse(result.message)
          }
        } catch {
          if (current !== flow) return value()
          discard(flow)
          return refuse('暂时无法核对当前建档。请刷新后重试。')
        } finally {
          signal.removeEventListener('abort', abortStart)
        }
        flow.checked = true
        void open(flow)
        return value(flow)
      }
      const flow = findOwnFlow()
      if (!flow) return value()
      if (action === 'cancel') {
        discard(flow)
        return value()
      }
      try {
        if (!await revalidate(flow, request.signal)) return value()
      } catch {
        if (current !== flow || flow.abort.signal.aborted || request.signal.aborted) return value()
        return refuse('暂时无法核对当前建档。请刷新后重试。')
      }
      if (action === 'read' && flow.page) startRead(flow, flow.page)
      if (action === 'submit' && flow.phase === 'ready' && flow.profile) {
        flow.phase = 'submitting'
        delete flow.message
        void submit(flow, flow.profile)
      }
      return value(flow)
    },
  })
  return () => {
    if (current) discard(current)
    void off()
  }
}
