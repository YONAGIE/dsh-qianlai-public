const materialRetryKind = 'moneycome-material-retry'
const materialReaders = new Set(['moneycome_read_upload', 'moneycome_read_referenced_pdf'])
const materialWatchedCalls = new Set([...materialReaders, 'ask_user_question', 'moneycome_onboarding',
  'moneycome_record_entry', 'moneycome_check_invoice'])
const materialRetryReasons = {
  FILE_FORMAT_MISMATCH: '文件格式与内容不一致。请重新导出后发送。',
  FILE_PARSE_FAILED: '这份文件未能读出。请重新导出，或拆成几份再发。',
  FILE_PARSE_TIMEOUT: '这份文件读取超时。请拆成几份再发。',
  IMAGE_ATTACHMENT_FAILED: '这页图片未能打开。请重新发送这份材料。',
}

function materialJson(value) {
  if (typeof value !== 'string') return value ?? null
  if (value.length > 512_000) return null
  try { return JSON.parse(value) } catch { return null }
}

export function materialRetryDefinition() {
  const turn = (event, role = 'update') => Number.isSafeInteger(event.data?.turn)
    ? { id: String(event.data.turn), role } : null
  return {
    kind: materialRetryKind,
    target: 'chat',
    match: {
      'turn/start': event => turn(event, 'start'),
      'turn/end': event => turn(event),
      'tool/call': event => materialWatchedCalls.has(event.data?.name) ? turn(event) : null,
      'tool/result': event => event.data?.message?.source?.kind === 'tool' ? turn(event) : null,
    },
    start: () => ({ calls: {}, failures: [], blockedThrough: -1 }),
    update: ({ state }, { event }) => {
      if (event.type === 'turn/end') {
        const item = state.failures.find(failure => failure.seq > state.blockedThrough)
        return event.data.reason?.kind === 'completed' && item ? { ...state, item, anchorSeq: event.seq } : state
      }
      if (event.type === 'tool/call') {
        const { name, callId } = event.data
        if (name === 'ask_user_question' || name === 'moneycome_onboarding'
          || (name === 'moneycome_record_entry' && materialJson(event.data.arguments)?.preview !== true))
          return { ...state, blockedThrough: event.seq }
        if (typeof callId === 'string' && (materialReaders.has(name) || name === 'moneycome_check_invoice'))
          return { ...state, calls: { ...state.calls, [callId]: name } }
        return state
      }
      const { message } = event.data
      const callId = message?.source?.callId
      if (event.surfaceOp !== 'append' || message?.isError || !Object.hasOwn(state.calls, callId)) return state
      const first = message.content?.[0]
      if (first?.type !== 'text') return state
      const result = materialJson(first.text)
      if (state.calls[callId] === 'moneycome_check_invoice') {
        const action = result?.nextAction?.kind
        return result?.accepted === true && ['replace_invoice', 'upload_clearer_invoice'].includes(action)
          ? { ...state, blockedThrough: event.seq } : state
      }
      const info = result?.material
      if (!Number.isSafeInteger(info?.id) || info.id < 1) return state
      const failures = state.failures.filter(item => item.id !== info.id)
      if (result.accepted === false && info.status === 'failed' && typeof info.name === 'string'
        && Object.hasOwn(materialRetryReasons, result.code))
        failures.push({ seq: event.seq, id: info.id, name: info.name, code: result.code })
      return { ...state, failures }
    },
    publication: ({ event }) => event.type === 'turn/end' ? 'immediate' : 'none',
    buildViewNode: ({ key, id, state, start }) => state?.anchorSeq === undefined ? null : {
      key, id, kind: materialRetryKind, target: 'chat', anchorSeq: state.anchorSeq,
      location: start.location, groupTree: 'turn', visibility: 'visible',
      data: { id: state.item.id, name: state.item.name, code: state.item.code },
    },
  }
}

export function registerMaterialRetry(ctx, { jsx, useState, usePreset, buttonStyle, panelSectionStyle }) {
  ctx.inject(['uiConversation'], scope => {
    scope.effect(() => scope.uiConversation.events.register(materialRetryDefinition()), 'dsh-qianlai: material retry')
  })
  ctx.inject(['conversation'], scope => {
    scope.effect(() => ctx.slots.inject('conversation.chat.node', () =>
      ctx.slots.register({ name: 'conversation.chat.node', key: materialRetryKind }, MaterialRetry),
    ), 'dsh-qianlai: material retry action')

    function MaterialRetry({ node, sessionId, useSessions }) {
      const preset = usePreset(sessionId, useSessions)
      const [fallback, setFallback] = useState(false)
      const { name, code } = node.data ?? {}
      if (preset !== 'moneycome-zhangjie' || typeof name !== 'string' || !Object.hasOwn(materialRetryReasons, code)) return null
      const input = scope.conversation.input
      const hasPicker = typeof input?.canPickFiles === 'function' && typeof input.pickFiles === 'function'
      const pickFile = () => {
        if (!input.canPickFiles(sessionId)) return setFallback(true)
        setFallback(false)
        input.pickFiles(sessionId)
      }
      return jsx('section', {
        'aria-label': '重新上传材料', style: { ...panelSectionStyle, maxWidth: '38rem' },
        children: [
          jsx('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
            children: [
              jsx('strong', { style: { overflowWrap: 'anywhere' }, children: name }),
              hasPicker ? jsx('button', { type: 'button', onClick: pickFile, style: buttonStyle, children: '重新选文件' }) : null,
            ] }),
          jsx('p', { role: 'status', style: { margin: '8px 0 0', fontSize: '0.875em',
            color: 'var(--dsw-alias-label-secondary)' },
          children: materialRetryReasons[code] + (hasPicker && !fallback
            ? '选好文件后在当前对话发送。'
            : '可把文件拖到当前对话，或用输入框旁的「文件」添加。') }),
        ],
      })
    }
  })
}
