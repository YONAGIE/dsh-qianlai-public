import type { LoadedPack } from './pack.js'
import { PERIOD_KEY, refuse } from './period.js'
import { generateReport, isReportKind, MAX_REPORT_BYTES } from './report-export.js'
import type { BookStore } from './store.js'
import { isIntroductionSession, isWechatSession, type RpcConnection } from './wechat/control.js'

const METHOD = 'qianlai/company-report'
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const FINGERPRINT = /^[\da-f]{64}$/

interface ReportSessionSnapshot {
  readonly meta: { readonly agentPreset?: string }
  readonly events: readonly { readonly type: string; readonly data?: unknown }[]
  readonly currentPreset?: string | null
}

export interface ReportSessionController {
  inspect(id: string, signal: AbortSignal): Promise<ReportSessionSnapshot>
}

export interface ReportSessionQuery {
  observeSession(id: string, options: { signal: AbortSignal; projectionMode: 'all' }): Promise<{
    readonly projections?: { readonly values: { readonly agentPreset?: string | null } }
    readonly events: ReportSessionSnapshot['events']
    [Symbol.dispose](): void
  }>
}

export function reportSessionAccess(controller?: Partial<ReportSessionController>, query?: ReportSessionQuery): ReportSessionController | undefined {
  if (typeof controller?.inspect === 'function') return { inspect: controller.inspect.bind(controller) }
  if (!query) return undefined
  return {
    async inspect(id, signal) {
      const observation = await query.observeSession(id, { signal, projectionMode: 'all' })
      try {
        signal.throwIfAborted()
        return { meta: {}, currentPreset: observation.projections?.values.agentPreset ?? null, events: observation.events.slice() }
      } finally { observation[Symbol.dispose]() }
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function jsonRecord(value: unknown) {
  if (typeof value !== 'string' || value.length > 65_536) return {}
  try { return record(JSON.parse(value)) } catch { return {} }
}

async function inspectReportSession(sessions: ReportSessionController | undefined, id: string, signal: AbortSignal) {
  if (!sessions || !/^[\w-]{1,128}$/.test(id) || signal.aborted || isIntroductionSession(id) || isWechatSession(id)) return undefined
  try {
    const session = await sessions.inspect(id, signal)
    const lastSelection = session.events.filter(event => event.type === 'agent-preset/selected').at(-1)
    const preset = session.currentPreset !== undefined ? session.currentPreset
      : lastSelection ? record(lastSelection.data).agentPreset : session.meta.agentPreset
    return !signal.aborted && preset === 'moneycome-zhangjie' ? session : undefined
  } catch {
    return undefined
  }
}

function eligible(payload: Record<string, unknown>, snapshot: NonNullable<Awaited<ReturnType<typeof inspectReportSession>>>) {
  let location = snapshot.events.length - 1
  while (location >= 0) {
    const event = snapshot.events[location]!
    if (event.type === 'tool/call' && record(event.data).name === 'moneycome_company_report'
      && record(event.data).callId === payload.callId) break
    location--
  }
  if (location < 0) return false
  for (const event of snapshot.events.slice(location + 1)) {
    if (event.type !== 'tool/result') continue
    const message = record(record(event.data).message)
    if (message.isError) continue
    const source = record(message.source)
    if (source.kind !== 'tool' || (source.callId ?? message.toolCallId) !== payload.callId) continue
    const first = Array.isArray(message.content) ? record(message.content[0]) : {}
    if (first.type !== 'text') continue
    const result = jsonRecord(first.text)
    if (result.accepted !== true || result.kind !== payload.kind || result.periodKey !== payload.periodKey) continue
    if (payload.action === 'generate') return result.fingerprint === payload.fingerprint
    if (Array.isArray(result.versions) && result.versions.some(row => record(row).id === payload.id)) return true
    return typeof result.fingerprint === 'string' && result.fingerprint === payload.fingerprint
  }
  return false
}

export function registerCompanyReport(connection: RpcConnection, store: BookStore, pack: LoadedPack, sessions?: ReportSessionController) {
  return connection.fetch.register({
    path: '/api/qianlai/company-report', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let envelope: Record<string, unknown>
      try { envelope = record(await request.json()) } catch { return new Response('Invalid request', { status: 400 }) }
      if (envelope.type !== 'client-request' || envelope.method !== METHOD || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 128)
        return new Response('Invalid request', { status: 400 })
      const reply = (value: unknown) => Response.json({
        type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value },
      }, { headers: { 'Cache-Control': 'no-store' } })
      const payload = record(envelope.payload)
      const { action, kind, periodKey, sessionId, callId, fingerprint, id } = payload
      if (!isReportKind(kind) || typeof periodKey !== 'string' || !PERIOD_KEY.test(periodKey)
        || typeof callId !== 'string' || !callId || callId.length > 128 || typeof sessionId !== 'string'
        || !['generate', 'download'].includes(String(action))
        || (action === 'generate' && (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)))
        || (action === 'download' && (typeof id !== 'string' || !UUID.test(id))))
        return reply(refuse('REPORT_REQUEST_INVALID', '请在当前报表卡片操作。'))
      const snapshot = await inspectReportSession(sessions, sessionId, request.signal)
      if (!snapshot || !eligible(payload, snapshot) || request.signal.aborted)
        return reply(refuse('REPORT_ACTION_UNAVAILABLE', '当前报表卡片无法操作，请让张姐重新打开该月份的报表。'))
      if (action === 'generate' && typeof fingerprint === 'string') return reply(generateReport(store, pack, periodKey, kind, fingerprint, new Date()))
      const artifact = typeof id === 'string' ? store.reportArtifact(id) : undefined
      if (!artifact || artifact.periodKey !== periodKey || artifact.kind !== kind || artifact.content.byteLength > MAX_REPORT_BYTES)
        return reply(refuse('REPORT_FILE_UNAVAILABLE', '这份报表文件无法打开，请核对月份和版本。'))
      // The call may authorize old version IDs or the exact fingerprint from its preview.
      if (payload.fingerprint !== undefined && artifact.fingerprint !== payload.fingerprint)
        return reply(refuse('REPORT_FILE_UNAVAILABLE', '这份报表文件和预览版本不一致。'))
      return reply({ accepted: true, fileName: artifact.fileName, base64: Buffer.from(artifact.content).toString('base64') })
    },
  })
}
