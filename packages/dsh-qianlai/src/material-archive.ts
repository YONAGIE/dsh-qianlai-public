import { inspectZhangjie, type OnboardingSessions } from './onboarding-rpc.js'
import { refuse } from './period.js'
import type { BookStore } from './store.js'
import { MAX_MATERIAL_BYTES } from './uploads.js'
import type { RpcConnection } from './wechat/control.js'
import { readWorkMatter } from './work-progress.js'

const METHOD = 'qianlai/material-archive'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function inspectMaterialArchive(store: BookStore, matterId: number) {
  const result = readWorkMatter(store, matterId)
  if (!result.accepted) return result
  const byId = new Map(result.matter.materials.map(material => [material.id, material]))
  return {
    accepted: true as const, matterId, title: result.matter.title, period: result.matter.period,
    materials: result.matter.materials.map(material => ({
      id: material.id, name: material.name, status: material.status,
      priorName: material.replacesMaterialId ? byId.get(material.replacesMaterialId)?.name : undefined,
      superseded: material.superseded, downloadable: store.hasWorkMaterialOriginal(material.id),
    })),
  }
}

function permitsDownload(
  snapshot: NonNullable<Awaited<ReturnType<typeof inspectZhangjie>>>, callId: string, matterId: number, materialId: number,
) {
  let callIndex = snapshot.events.length - 1
  while (callIndex >= 0) {
    const event = snapshot.events[callIndex]!
    if (event.type === 'tool/call' && object(event.data).name === 'moneycome_material_archive'
      && object(event.data).callId === callId) break
    callIndex--
  }
  if (callIndex < 0) return false
  for (const event of snapshot.events.slice(callIndex + 1)) {
    if (event.type !== 'tool/result') continue
    const message = object(object(event.data).message)
    const source = object(message.source)
    if (message.isError || source.kind !== 'tool' || (source.callId ?? message.toolCallId) !== callId) continue
    const first = Array.isArray(message.content) ? object(message.content[0]) : {}
    if (first.type !== 'text' || typeof first.text !== 'string' || first.text.length > 65_536) continue
    try {
      const result = object(JSON.parse(first.text))
      return result.accepted === true && result.matterId === matterId && Array.isArray(result.materials)
        && result.materials.some(item => object(item).id === materialId && object(item).downloadable === true)
    } catch { return false }
  }
  return false
}

export function registerMaterialArchive(connection: RpcConnection, store: BookStore, sessions?: OnboardingSessions) {
  return connection.fetch.register({
    path: '/api/qianlai/material-archive', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let envelope: Record<string, unknown>
      try { envelope = object(await request.json()) } catch { return new Response('Invalid request', { status: 400 }) }
      if (envelope.type !== 'client-request' || envelope.method !== METHOD || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 128)
        return new Response('Invalid request', { status: 400 })
      const reply = (value: unknown) => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } },
        { headers: { 'Cache-Control': 'no-store' } })
      const { callId, sessionId, matterId, materialId } = object(envelope.payload)
      if (typeof callId !== 'string' || !callId || callId.length > 128 || typeof sessionId !== 'string' ||
        typeof matterId !== 'number' || !Number.isSafeInteger(matterId) || matterId < 1 ||
        typeof materialId !== 'number' || !Number.isSafeInteger(materialId) || materialId < 1)
        return reply(refuse('MATERIAL_DOWNLOAD_INVALID', '请在当前材料卡片下载原件。'))
      const snapshot = await inspectZhangjie(sessions, sessionId, request.signal)
      if (!snapshot || !permitsDownload(snapshot, callId, matterId, materialId) || request.signal.aborted)
        return reply(refuse('MATERIAL_DOWNLOAD_UNAUTHORIZED', '请让张姐在当前对话重新打开这笔业务的材料。'))
      const matter = store.workMatter(matterId)
      const material = store.workMaterial(materialId)
      if (!material || !matter?.materialLinks.some(link => link.materialId === materialId))
        return reply(refuse('MATERIAL_NOT_FOUND', '这份材料不在当前事项里。'))
      const content = store.workMaterialOriginal(materialId)
      if (!content || content.byteLength > MAX_MATERIAL_BYTES)
        return reply(refuse('MATERIAL_FILE_UNAVAILABLE', '这份历史材料只保留了阅读记录，可以重新上传原件。'))
      const fileName = material.name.replace(/[<>:"/\\|?*]/g, '_').replace(/^\.+|[. ]+$/g, '') || '原件'
      return reply({ accepted: true, fileName, base64: Buffer.from(content).toString('base64') })
    },
  })
}
