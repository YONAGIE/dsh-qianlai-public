const invoiceUploadKind = 'moneycome-invoice-upload'
const invoiceUploadActions = {
  replace_invoice: { title: '更换发票', label: '上传正确发票' },
  upload_clearer_invoice: { title: '补发清晰原件', label: '上传清晰发票' },
  review_original: { title: '核对发票原件', label: '上传发票原件' },
}

export function invoiceUploadDefinition(toolResultText) {
  const turn = (event, role = 'update') => Number.isSafeInteger(event.data?.turn)
    ? { id: String(event.data.turn), role } : null
  return {
    kind: invoiceUploadKind,
    target: 'chat',
    match: {
      'turn/start': event => turn(event, 'start'),
      'turn/end': event => turn(event),
      'tool/call': event => ['moneycome_check_invoice', 'ask_user_question', 'moneycome_record_entry'].includes(event.data?.name)
        ? turn(event) : null,
      'tool/result': event => event.data?.message?.source?.kind === 'tool' ? turn(event) : null,
    },
    start: () => ({}),
    update: ({ state }, { event }) => {
      if (event.type === 'turn/end') return event.data.reason?.kind === 'completed' && state.action
        ? { ...state, anchorSeq: event.seq } : state
      // Show one current action. Later questions and postings take precedence.
      if (event.type === 'tool/call') return event.data.name === 'moneycome_check_invoice'
        ? { checkCallId: event.data.callId } : {}
      if (typeof state.checkCallId !== 'string' || event.data.message.source.callId !== state.checkCallId) return state
      const text = toolResultText(event)
      if (!text || text.length > 65536) return state
      try {
        const result = JSON.parse(text)
        const action = result?.nextAction?.kind
        return result?.accepted === true && result.recordable === false
          && typeof action === 'string' && Object.hasOwn(invoiceUploadActions, action)
          ? { action } : state
      } catch {
        return state
      }
    },
    publication: ({ event }) => event.type === 'turn/end' ? 'immediate' : 'none',
    buildViewNode: ({ key, id, state, start }) => state?.anchorSeq === undefined ? null : {
      key, id, kind: invoiceUploadKind, target: 'chat', anchorSeq: state.anchorSeq,
      location: start.location, groupTree: 'turn', visibility: 'visible', data: { action: state.action },
    },
  }
}

export function registerInvoiceUpload(ctx, { jsx, useState, usePreset, toolResultText, buttonStyle, panelSectionStyle }) {
  ctx.inject(['uiConversation'], scope => {
    scope.effect(() => scope.uiConversation.events.register(invoiceUploadDefinition(toolResultText)),
      'dsh-qianlai: invoice upload')
  })
  ctx.inject(['conversation'], scope => {
    scope.effect(() => ctx.slots.inject('conversation.chat.node', () =>
      ctx.slots.register({ name: 'conversation.chat.node', key: invoiceUploadKind }, InvoiceUpload),
    ), 'dsh-qianlai: invoice upload action')

    function InvoiceUpload({ node, sessionId, useSessions }) {
      const preset = usePreset(sessionId, useSessions)
      const [showFallback, setShowFallback] = useState(false)
      const action = node.data?.action
      if (preset !== 'moneycome-zhangjie' || typeof action !== 'string' || !Object.hasOwn(invoiceUploadActions, action)) return null
      const { title, label } = invoiceUploadActions[action]
      const input = scope.conversation.input
      const hasPicker = typeof input?.canPickFiles === 'function' && typeof input.pickFiles === 'function'
      const pickFile = () => {
        if (input.canPickFiles(sessionId)) {
          setShowFallback(false)
          input.pickFiles(sessionId)
        } else {
          setShowFallback(true)
        }
      }
      return jsx('section', {
        'aria-label': title, style: { ...panelSectionStyle, maxWidth: '38rem' },
        children: [
          jsx('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
            children: [
              jsx('strong', { children: title }),
              hasPicker ? jsx('button', { type: 'button', onClick: pickFile, style: buttonStyle, children: label }) : null,
            ] }),
          jsx('p', { role: 'status', style: { margin: '8px 0 0', fontSize: '0.875em',
            color: 'var(--dsw-alias-label-secondary)' },
          children: hasPicker && !showFallback
            ? '选好发票后发送给张姐。'
            : '请把发票拖到当前对话，或用输入框旁的「文件」添加后发送。' }),
        ],
      })
    }
  })
}
