/* global window */
const archiveChatKind = 'moneycome-material-archive'

export function materialArchiveDefinition(toolResultText) {
  const role = (event, kind = 'update') => Number.isSafeInteger(event.data?.turn)
    ? { id: String(event.data.turn), role: kind } : null
  return {
    kind: archiveChatKind,
    target: 'chat',
    match: {
      'turn/start': event => role(event, 'start'),
      'turn/end': event => role(event),
      'tool/call': event => ['moneycome_material_archive', 'moneycome_onboarding', 'ask_user_question', 'moneycome_record_entry'].includes(event.data?.name)
        ? role(event) : null,
      'tool/result': event => event.data?.message?.source?.kind === 'tool' ? role(event) : null,
    },
    start: () => ({}),
    update: ({ state }, { event }) => {
      if (event.type === 'turn/end') return event.data.reason?.kind === 'completed' && state.archive
        ? { ...state, anchorSeq: event.seq } : state
      if (event.type === 'tool/call') return event.data.name === 'moneycome_material_archive'
        ? { callId: event.data.callId } : {}
      if (typeof state.callId !== 'string' || (event.data.message.source.callId ?? event.data.message.toolCallId) !== state.callId)
        return state
      const text = toolResultText(event)
      if (!text || text.length > 65_536) return state
      try {
        const archive = JSON.parse(text)
        return archive?.accepted === true && Number.isSafeInteger(archive.matterId) && Array.isArray(archive.materials) && archive.materials.length
          ? { ...state, archive } : state
      } catch { return state }
    },
    publication: ({ event }) => event.type === 'turn/end' ? 'immediate' : 'none',
    buildViewNode: ({ key, id, state, start }) => state?.anchorSeq === undefined ? null : {
      key, id, kind: archiveChatKind, target: 'chat', anchorSeq: state.anchorSeq, location: start.location,
      groupTree: 'turn', visibility: 'visible', data: { ...state.archive, callId: state.callId },
    },
  }
}

function downloadOriginal(file) {
  const bytes = Uint8Array.from(window.atob(file.base64), char => char.charCodeAt(0))
  const blob = new window.Blob([bytes], { type: 'application/octet-stream' })
  const url = window.URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  link.href = url
  link.download = file.fileName
  window.document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000)
}

export function registerMaterialArchiveChat(ctx, { jsx, usePreset, useState, useRef, toolResultText, buttonStyle, panelSectionStyle }) {
  ctx.inject(['uiConversation'], scope => {
    scope.effect(() => scope.uiConversation.events.register(materialArchiveDefinition(toolResultText)), 'dsh-qianlai: material archive')
  })
  ctx.inject(['connection'], scope => {
    scope.effect(() => ctx.slots.inject('conversation.chat.node', () =>
      ctx.slots.register({ name: 'conversation.chat.node', key: archiveChatKind }, MaterialArchive),
    ), 'dsh-qianlai: material archive actions')
    function MaterialArchive({ node, sessionId, useSessions }) {
      const active = usePreset(sessionId, useSessions) === 'moneycome-zhangjie'
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)
      const inFlight = useRef(false)
      const archive = node.data
      if (!active || !archive?.callId) return null
      const download = async materialId => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setMessage('')
        try {
          const response = await scope.connection.rpc.call('/api', 'qianlai/material-archive', {
            sessionId, callId: archive.callId, matterId: archive.matterId, materialId,
          }, window.AbortSignal.timeout(25_000))
          const result = response.ok && response.value
          if (result?.accepted) downloadOriginal(result)
          else setMessage(result?.message || '原件暂时无法下载，请重试。')
        } catch { setMessage('原件暂时无法下载，请重试。') }
        finally { inFlight.current = false; setBusy(false) }
      }
      return jsx('section', { 'aria-label': '事项材料', style: panelSectionStyle,
        children: [
          jsx('strong', { children: archive.title }),
          archive.period ? jsx('p', { children: archive.period, style: { margin: '6px 0' } }) : null,
          jsx('ul', { style: { margin: '10px 0 0', display: 'grid', gap: 10, paddingLeft: 20 },
            children: archive.materials.map(material => jsx('li', {
              children: [
                jsx('div', { children: [
                  material.name,
                  material.superseded ? ' · 已替换' : material.priorName ? ' · 当前版本' : '',
                  material.status === 'failed' ? ' · 未能读出' : '',
                ] }),
                material.priorName ? jsx('small', { children: '替换：' + material.priorName }) : null,
                material.downloadable ? jsx('button', { type: 'button', disabled: busy, style: buttonStyle,
                  onClick: () => void download(material.id), children: '下载原件',
                  'aria-label': '下载原件 ' + material.name }) : jsx('small', { children: '仅有历史读取记录' }),
              ],
            }, material.id)) }),
          message ? jsx('p', { role: 'status', children: message }) : null,
        ],
      })
    }
  })
}
