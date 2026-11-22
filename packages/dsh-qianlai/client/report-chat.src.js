/* global window */
const reportChatKind = 'moneycome-report-action'
const reportTools = new Set(['moneycome_company_report', 'ask_user_question', 'moneycome_onboarding', 'moneycome_check_invoice', 'moneycome_record_entry'])
const reportUploadLabels = {
  'transaction-evidence': '上传本笔发票或凭据',
  invoice: '上传发票',
}

export function companyReportDefinition(toolResultText) {
  const role = (event, kind = 'update') => Number.isSafeInteger(event.data?.turn)
    ? { id: String(event.data.turn), role: kind } : null
  return {
    kind: reportChatKind,
    target: 'chat',
    match: {
      'turn/start': event => role(event, 'start'),
      'turn/end': event => role(event),
      'tool/call': event => reportTools.has(event.data?.name) ? role(event) : null,
      'tool/result': event => event.data?.message?.source?.kind === 'tool' ? role(event) : null,
    },
    start: () => ({}),
    update: ({ state }, { event }) => {
      if (event.type === 'turn/end') return event.data.reason?.kind === 'completed' && state.result
        ? { ...state, anchorSeq: event.seq } : state
      if (event.type === 'tool/call') return event.data.name === 'moneycome_company_report'
        ? { callId: event.data.callId } : {}
      if (typeof state.callId !== 'string' || (event.data.message.source.callId ?? event.data.message.toolCallId) !== state.callId)
        return state
      const text = toolResultText(event)
      if (!text || text.length > 65_536) return state
      try {
        const result = JSON.parse(text)
        if (!['financial', 'ledger-review'].includes(result?.kind) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(result.periodKey))
          return state
        if (result.accepted === true && (result.fingerprint || result.versions?.length))
          return { ...state, result }
        if (result.accepted === false && result.nextAction === 'upload')
          return { ...state, result }
        return state
      } catch {
        return state
      }
    },
    publication: ({ event }) => event.type === 'turn/end' ? 'immediate' : 'none',
    buildViewNode: ({ key, id, state, start }) => state?.anchorSeq === undefined ? null : {
      key, id, kind: reportChatKind, target: 'chat', anchorSeq: state.anchorSeq, location: start.location,
      groupTree: 'turn', visibility: 'visible', data: { ...state.result, callId: state.callId },
    },
  }
}

export function downloadCompanyReport(file) {
  const bytes = Uint8Array.from(window.atob(file.base64), char => char.charCodeAt(0))
  const blob = new window.Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = window.URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  link.href = url
  link.download = file.fileName
  window.document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000)
}

export function registerCompanyReportChat(ctx, { jsx, usePreset, useState, useRef, toolResultText, buttonStyle, panelSectionStyle }) {
  ctx.inject(['uiConversation'], scope => {
    scope.effect(() => scope.uiConversation.events.register(companyReportDefinition(toolResultText)), 'dsh-qianlai: company report')
  })
  ctx.inject(['connection', 'conversation'], scope => {
    scope.effect(() => ctx.slots.inject('conversation.chat.node', () =>
      ctx.slots.register({ name: 'conversation.chat.node', key: reportChatKind }, CompanyReport),
    ), 'dsh-qianlai: report actions')

    function CompanyReport({ node, sessionId, useSessions }) {
      const preset = usePreset(sessionId, useSessions)
      const [generated, setGenerated] = useState(null)
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)
      const inFlight = useRef(false)
      const data = node.data
      if (preset !== 'moneycome-zhangjie' || !data?.callId) return null
      const title = data.title ?? '补齐报表资料'
      const request = async (action, extra) => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setMessage('')
        try {
          const response = await scope.connection.rpc.call('/api', 'qianlai/company-report', {
            action, sessionId, callId: data.callId, kind: data.kind, periodKey: data.periodKey, ...extra,
          }, window.AbortSignal.timeout(25_000))
          const result = response.ok && response.value
          if (!result?.accepted) {
            setMessage(result?.message || '报表暂时无法操作，请重试。')
            return
          }
          if (action === 'generate') {
            setGenerated({ artifact: result.artifact, workbookSummary: result.workbookSummary })
            setMessage(result.reused ? '报表内容相同，已保留原版本。' : '文件已生成，可以下载。')
          } else {
            downloadCompanyReport(result)
          }
        } catch {
          setMessage('报表暂时无法操作，请重试。')
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      }
      const button = (text, onClick, primary = false) => jsx('button', {
        type: 'button', disabled: busy, onClick,
        style: { ...buttonStyle, ...(primary ? { fontWeight: 650 } : {}) }, children: text,
      })
      const upload = () => {
        const input = scope.conversation.input
        if (typeof input?.pickFiles === 'function' && input.canPickFiles?.(sessionId)) {
          setMessage('')
          input.pickFiles(sessionId)
        } else {
          setMessage('也可以把资料拖到当前对话，或用输入框旁的文件入口。')
        }
      }
      const uploadLabel = Object.hasOwn(reportUploadLabels, data.uploadKind) ? reportUploadLabels[data.uploadKind] : '上传本月资料'
      const versions = data.versions ?? []
      const current = generated ? [generated.artifact, ...versions.filter(item => item.id !== generated.artifact.id)] : versions
      const summary = generated?.workbookSummary ?? data.workbookSummary
      return jsx('section', { 'aria-label': title, style: panelSectionStyle,
        children: [
          jsx('strong', { children: title }),
          jsx('p', { style: { margin: '7px 0 10px' }, children:
            [data.companyName, data.periodKey, data.phase].filter(Boolean).join(' · ') }),
          typeof summary?.description === 'string' ? jsx('p', { style: { margin: '0 0 10px' },
            children: [jsx('strong', { children: generated ? '本次文件' : '本次预览' }), ' ', summary.description] }) : null,
          data.accepted === false ? jsx('div', { children: [jsx('p', { children: data.message }),
            button(uploadLabel, upload, true)] }) : null,
          data.fingerprint && !generated ? jsx('div', { style: { display: 'flex', justifyContent: 'flex-end' },
            children: button('确认生成 XLSX', () => void request('generate', { fingerprint: data.fingerprint }), true) }) : null,
          current.length ? jsx('ul', { style: { margin: '10px 0 0', display: 'grid', gap: '6px' },
            children: current.map(artifact => jsx('li', {
              children: button('下载第 ' + artifact.version + ' 版 XLSX', () => void request('download', {
                id: artifact.id, ...(artifact.id === generated?.artifact.id ? { fingerprint: artifact.fingerprint } : {}),
              })),
            }, artifact.id)) }) : null,
          message ? jsx('p', { role: 'status', children: message }) : null,
        ],
      })
    }
  })
}
