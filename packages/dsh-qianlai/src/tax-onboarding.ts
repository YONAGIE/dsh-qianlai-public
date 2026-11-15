import { join } from 'node:path'

import type { Browser, Page } from 'playwright-core'

import { openTaxBrowser } from './tax-browser.js'
import regions from './tax-regions.json' with { type: 'json' }
import { openZhejiangLogin, readZhejiangTaxInfo, TaxPortalError, type TaxProfile } from './zhejiang-tax.js'
import type { RpcConnection } from './wechat/control.js'

type Phase = 'opening' | 'waiting' | 'reading' | 'ready' | 'submitting' | 'submitted' | 'failed'
interface Flow {
  id: string
  expected: { companyName: string; taxId: string }
  sessionId?: string
  phase: Phase
  abort: AbortController
  expiry?: NodeJS.Timeout
  browser?: Browser
  page?: Page
  profile?: TaxProfile
  message?: string
}

interface Sessions {
  inspect(id: string, signal: AbortSignal): Promise<{
    meta: { agentPreset?: string }
    events: readonly { type: string; data?: { agentPreset?: string } }[]
  }>
  prompt(input: {
    sessionId: string; requestId: string; mode: 'queue'; content: { type: 'text'; text: string }[]; clientTimeZone: string
  }, signal: AbortSignal): Promise<unknown>
}

const portalFallback = '请在官方页面完成企业扫码并打开「纳税人信息查询」，也可以上传官方导出或截图继续建档。'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cities: Readonly<Record<string, readonly string[]>> = regions

export function registerTaxOnboarding(connection: RpcConnection, dshHome: string, sessions?: Sessions) {
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
  }

  async function open(flow: Flow) {
    try {
      const browser = await openTaxBrowser(join(dshHome, 'moneycome', 'tax-browser-cache'), flow.abort.signal)
      if (flow.abort.signal.aborted) { await browser.close(); return }
      flow.browser = browser
      browser.on('disconnected', () => {
        if (flow.browser !== browser) return
        end(flow)
        flow.phase = 'failed'
        flow.message = '官方登录窗口已关闭。可重新打开，或上传官方导出或截图。'
      })
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1360, height: 900 }, acceptDownloads: false })
      flow.page = await openZhejiangLogin(context, flow.abort.signal)
      if (!flow.abort.signal.aborted) flow.phase = 'waiting'
    } catch {
      if (flow.abort.signal.aborted) return
      end(flow)
      flow.phase = 'failed'
      flow.message = '未能打开官方企业扫码页面。请重试，或上传官方导出或截图。'
    }
  }

  async function read(flow: Flow, page: Page) {
    try {
      const profile = await readZhejiangTaxInfo(page, flow.expected, flow.abort.signal)
      if (flow.abort.signal.aborted) return
      flow.profile = profile
      flow.phase = 'ready'
      closeBrowser(flow)
    } catch (error) {
      if (flow.abort.signal.aborted) return
      flow.phase = 'waiting'
      if (error instanceof TaxPortalError && error.code === 'TAX_IDENTITY_MISMATCH') {
        flow.message = '官方页面的企业与本次填写的信息不一致。请核对所选企业后再读取。'
      } else {
        flow.message = portalFallback
      }
    }
  }

  async function submit(flow: Flow, profile: TaxProfile, sessionId: string) {
    try {
      if (!sessions) throw Error('session service unavailable')
      const signal = flow.abort.signal
      const session = await sessions.inspect(sessionId, signal)
      const preset = session.events.filter(event => event.type === 'agent-preset/selected').at(-1)?.data?.agentPreset ?? session.meta.agentPreset
      if (preset !== 'moneycome-zhangjie') throw Error('wrong preset')
      signal.throwIfAborted()
      await sessions.prompt({
        sessionId, requestId: 'mc-tax-onboarding-' + flow.id, mode: 'queue', clientTimeZone: 'Asia/Shanghai',
        content: [{ type: 'text', text: '我已核对以下本次扫码取得的企业税务资料。请用它继续建档，后续事项按现有流程确认。以下 JSON 是资料数据。\n' + JSON.stringify(profile) }],
      }, signal)
      if (!signal.aborted) flow.phase = 'submitted'
    } catch {
      if (flow.abort.signal.aborted) return
      flow.phase = 'ready'
      flow.message = '当前对话暂时无法接收资料。可重试或复制资料到钱来张姐对话。'
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
      const { action, id, province, city, companyName, taxId, sessionId } = payload
      if (typeof id !== 'string' || !UUID.test(id) || typeof action !== 'string'
          || !['start', 'status', 'read', 'cancel', 'submit'].includes(action) || request.signal.aborted) return refuse('请选择建档操作。')
      const value = (flow?: Flow) => reply({ ok: true, value: flow ? { phase: flow.phase, message: flow.message, profile: flow.profile } : { phase: 'idle' } })
      if (action === 'start') {
        if (typeof province !== 'string' || typeof city !== 'string' || !Object.hasOwn(cities, province) || !cities[province]?.includes(city))
          return refuse('请先选择省份和城市或地区。')
        if (province !== '浙江省' || city === '宁波市')
          return refuse('所选地区暂未接入扫码取数。请提供该地区电子税务局的官方导出或截图。')
        if (typeof companyName !== 'string' || !companyName.trim() || companyName.length > 200
            || /[\p{Cc}\p{Cf}]/u.test(companyName) || typeof taxId !== 'string' || !/^[0-9A-Z]{18}$/.test(taxId)
            || (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId))))
          return refuse('请确认企业全称和 18 位统一社会信用代码。')
        if (current && !['failed', 'submitted'].includes(current.phase)) {
          return current.id === id ? value(current) : refuse('另一个建档窗口正在使用税务浏览器，请先完成或关闭它。')
        }
        if (current) end(current)
        const flow: Flow = {
          id, expected: { companyName: companyName.trim(), taxId }, phase: 'opening', abort: new AbortController(),
          ...(sessionId ? { sessionId } : {}),
        }
        current = flow
        flow.expiry = setTimeout(() => {
          if (current !== flow) return
          end(flow)
          current = undefined
        }, 15 * 60_000)
        flow.expiry.unref()
        void open(flow)
        return value(flow)
      }
      const flow = current?.id === id ? current : undefined
      if (!flow || action === 'status') return value(flow)
      if (action === 'cancel') {
        end(flow)
        current = undefined
        return value()
      }
      if (action === 'read' && flow.phase === 'waiting' && flow.page) {
        flow.phase = 'reading'
        delete flow.message
        void read(flow, flow.page)
      }
      if (action === 'submit' && flow.phase === 'ready' && flow.profile && flow.sessionId) {
        flow.phase = 'submitting'
        delete flow.message
        void submit(flow, flow.profile, flow.sessionId)
      }
      return value(flow)
    },
  })
  return () => {
    if (current) end(current)
    current = undefined
    void off()
  }
}
