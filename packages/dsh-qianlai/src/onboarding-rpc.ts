import type { CompanyOnboarding } from './company-onboarding.js'
import { recognizeCompanyDocument, type DocumentRecognitionServices, type ModelSelection } from './onboarding-document.js'
import { refuse } from './period.js'
import type { TaxDraftAccess, TaxOnboardingTarget } from './tax-onboarding.js'
import { isIntroductionSession, isWechatSession, type RpcConnection } from './wechat/control.js'

interface SessionSnapshot {
  readonly meta: { readonly agentPreset?: string }
  readonly events: readonly { readonly type: string; readonly data?: unknown }[]
}

// Room for an 8 MiB file in base64 plus the RPC envelope.
const MAX_REQUEST_BYTES = 12 * 1024 * 1024

async function readEnvelope(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader()
  if (!reader) throw Error('Missing body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REQUEST_BYTES) throw Error('Body exceeds limit')
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
  return record(JSON.parse(Buffer.concat(chunks, size).toString('utf8')))
}

export interface OnboardingSessions {
  inspect(id: string, signal: AbortSignal): Promise<SessionSnapshot>
}

export interface OnboardingHostServices extends DocumentRecognitionServices {
  readonly agentDefaultModel?: { currentSelection(): ModelSelection } | undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function hasCurrentReply(session: SessionSnapshot, turn: unknown): boolean {
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) return false
  const { events } = session
  let end = events.length - 1
  while (end >= 0 && events[end]?.type !== 'turn/start' && events[end]?.type !== 'turn/end') end--
  const boundary = events[end]
  if (boundary?.type !== 'turn/end' || record(boundary.data).turn !== turn ||
    record(record(boundary.data).reason).kind !== 'completed') return false
  let start = end - 1
  while (start >= 0 && events[start]?.type !== 'turn/start') start--
  if (start < 0 || record(events[start]?.data).turn !== turn) return false
  const reply = events.slice(start + 1, end)
  return reply.some(event => event.type === 'user/message' && record(record(event.data).source).kind === 'user') &&
    reply.some(event => {
      if (event.type !== 'assistant/message') return false
      const content = record(record(event.data).message).content
      return Array.isArray(content) && content.some(part => {
        const { type, text } = record(part)
        return type === 'text' && typeof text === 'string' && text.trim() !== ''
      })
    })
}

export async function inspectZhangjie(sessions: OnboardingSessions | undefined, id: unknown, signal: AbortSignal) {
  if (!sessions || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) || signal.aborted) return undefined
  try {
    const session = await sessions.inspect(id, signal)
    const lastSelection = session.events.filter(event => event.type === 'agent-preset/selected').at(-1)
    const preset = lastSelection ? record(lastSelection.data).agentPreset : session.meta.agentPreset
    return !signal.aborted && preset === 'moneycome-zhangjie' ? session : undefined
  } catch {
    return undefined
  }
}

function modelOf(session: SessionSnapshot, services: OnboardingHostServices): ModelSelection | undefined {
  const selected = session.events.filter(event => event.type === 'model/selection' || event.type === 'request/header').at(-1)
  const event = record(selected?.data)
  const choice = selected?.type === 'request/header' ? record(record(event.header).config) : event
  if (typeof choice.provider === 'string' && typeof choice.model === 'string') return { provider: choice.provider, model: choice.model }
  return services.agentDefaultModel?.currentSelection()
}

export function companyTaxDraftAccess(onboarding: CompanyOnboarding, sessions?: OnboardingSessions): TaxDraftAccess {
  const isCurrent = (target: TaxOnboardingTarget, flowId: string) =>
    onboarding.isTaxScanCurrent(target.sessionId, target.draftId, flowId)

  function currentTarget(target: TaxOnboardingTarget) {
    const view = onboarding.status()
    const enterprise = view.enterprise
    if (view.draftId !== target.draftId || view.completed || view.mode === 'manual' || !enterprise ||
        enterprise.companyName !== target.companyName || enterprise.taxId !== target.taxId ||
        enterprise.province !== target.province || enterprise.city !== target.city)
      return refuse('ONBOARDING_CHANGED', '企业资料已更新，请回到当前建档，核对后重新扫码。')
    return { accepted: true as const }
  }

  return {
    isCurrent,
    async check(target, signal, flowId) {
      if (!await inspectZhangjie(sessions, target.sessionId, signal)) return refuse('ONBOARDING_SESSION', '请在钱来张姐对话中打开建档。')
      signal.throwIfAborted()
      if (!isCurrent(target, flowId)) return refuse('ONBOARDING_CHANGED', '建档已切换步骤，请在当前对话继续。')
      return currentTarget(target)
    },
    async apply(target, profile, flowId, signal) {
      if (!await inspectZhangjie(sessions, target.sessionId, signal)) return refuse('ONBOARDING_SESSION', '请在钱来张姐对话中继续建档。')
      signal.throwIfAborted()
      const current = currentTarget(target)
      return current.accepted ? onboarding.applyTaxProfile(target.draftId, target.province, target.city, profile, flowId, target.sessionId) : current
    },
  }
}

export function registerCompanyOnboarding(connection: RpcConnection, onboarding: CompanyOnboarding, sessions?: OnboardingSessions, getServices: () => OnboardingHostServices = () => ({})) {
  const stop = new AbortController()
  let recognizing = false
  const off = connection.fetch.register({
    path: '/api/qianlai/company-onboarding', methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      const signal = AbortSignal.any([stop.signal, request.signal])
      let envelope: Record<string, unknown>
      try { envelope = await readEnvelope(request, signal) } catch { return new Response('Invalid request', { status: 400 }) }
      if (envelope.type !== 'client-request' || envelope.method !== 'qianlai/company-onboarding' ||
          typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 128)
        return new Response('Invalid request', { status: 400 })
      const reply = (value: unknown) => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }, { headers: { 'Cache-Control': 'no-store' } })
      const payload = record(envelope.payload)
      const { action, sessionId, draftId, revision, step } = payload
      const session = await inspectZhangjie(sessions, sessionId, signal)
      if (!session) return reply(refuse('ONBOARDING_SESSION', '请在钱来张姐对话中打开建档。'))

      try {
        signal.throwIfAborted()
        if (action === 'entry-status' || action === 'open-entry') {
          if (typeof sessionId !== 'string' || isWechatSession(sessionId) || isIntroductionSession(sessionId) ||
            !hasCurrentReply(session, payload.turn)) return reply({ accepted: true, entry: null })
          if (action === 'entry-status') return reply({ accepted: true, entry: onboarding.entryState() })
          return reply(onboarding.openEntry(sessionId))
        }
        const view = onboarding.status()
        if (action === 'status') return reply(view)
        if (action === 'card-status' && typeof sessionId === 'string' && typeof payload.cardId === 'string')
          return reply(onboarding.cardStatus(sessionId, payload.cardId))
        if (action === 'reopen-profile-card' && typeof sessionId === 'string' && typeof payload.cardId === 'string')
          return reply(onboarding.reopenProfileCard(sessionId, payload.cardId))
        if (draftId !== view.draftId || typeof revision !== 'number' || !Number.isSafeInteger(revision))
          return reply(refuse('ONBOARDING_CHANGED', '建档资料已变化，请重新打开建档。'))
        if (action === 'claim-tax-auto-start' && typeof sessionId === 'string' && typeof payload.cardId === 'string')
          return reply(onboarding.claimTaxAutoStart(sessionId, payload.cardId, revision))
        if (action === 'edit-section')
          return reply(onboarding.editSection(revision, payload.section, payload.input))
        if (action === 'save' && (step === 1 || step === 2 || step === 3) && (payload.advance === undefined || typeof payload.advance === 'boolean'))
          return reply(onboarding.save(step, revision, payload.input, payload.advance !== false))
        if (action === 'set-mode' && (payload.mode === 'scan' || payload.mode === 'manual'))
          return reply(onboarding.setMode(revision, payload.mode))
        if (action === 'submit-card' && typeof sessionId === 'string' && typeof payload.cardId === 'string') {
          if (payload.document !== undefined)
            return reply(refuse('CARD_UNAVAILABLE', '请通过当前资料卡识别并核对文件。'))
          return reply(onboarding.submitCard(sessionId, payload.cardId, revision, payload.mode ?? payload.choice, payload.values, payload.replaceSampleBook === true))
        }
        if (action === 'confirm') return reply(onboarding.confirm(revision, payload.replaceSampleBook === true))
        if (action === 'recognize' && typeof sessionId === 'string') {
          if (view.completed || revision !== view.revision) return reply(refuse('ONBOARDING_CHANGED', '建档资料已变化，请核对后再上传。'))
          const cardId = typeof payload.cardId === 'string' ? payload.cardId : undefined
          const kind = cardId ? onboarding.documentKindForCard(sessionId, cardId, revision) : payload.kind
          if ((cardId && !kind) || (kind === 'bank' && !cardId)) return reply(refuse('CARD_UNAVAILABLE', '请用当前资料卡识别文件。'))
          if (recognizing) return reply(refuse('DOCUMENT_IN_PROGRESS', '上一份资料还在识别，请稍候。'))
          recognizing = true
          try {
            const services = getServices()
            const result = await recognizeCompanyDocument(services, sessionId, modelOf(session, services), kind, payload.file, signal)
            signal.throwIfAborted()
            const updated = onboarding.status()
            if (updated.revision !== revision || updated.draftId !== draftId)
              return reply(refuse('ONBOARDING_CHANGED', '识别期间建档资料已变化，请核对后再上传。'))
            if (!result.accepted || !cardId) return reply(result)
            const reviewed = onboarding.previewDocumentCard(sessionId, cardId, revision, result.fields)
            return reply(reviewed.accepted ? { ...result, fields: reviewed.fields } : reviewed)
          } finally { recognizing = false }
        }
        return reply(refuse('ONBOARDING_ACTION', '请选择有效的建档操作。'))
      } catch {
        return reply(refuse('ONBOARDING_UNAVAILABLE', '暂时无法处理建档。请重新打开查看进度。'))
      }
    },
  })
  return () => { stop.abort(); void off() }
}
