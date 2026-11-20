const payrollNode = 'moneycome-payroll-schedule-form'
const payrollModes = { recurring: '每月发薪', once: '仅这个月发薪', paused: '从这个月起暂停' }
const validPayrollMonth = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)

export function payrollFormDefinition(toolResultText) {
  const blockers = new Set(['ask_user_question', 'moneycome_record_entry', 'moneycome_check_invoice',
    'moneycome_read_upload', 'moneycome_read_referenced_pdf', 'moneycome_onboarding'])
  const turn = (event, role = 'update') => Number.isSafeInteger(event.data?.turn)
    ? { id: String(event.data.turn), role } : null
  return {
    kind: payrollNode,
    target: 'chat',
    match: {
      'turn/start': event => turn(event, 'start'),
      'turn/end': event => turn(event),
      'tool/call': event => (event.data?.name === 'moneycome_payroll' || blockers.has(event.data?.name)) ? turn(event) : null,
      'tool/result': event => event.data?.message?.source?.kind === 'tool' ? turn(event) : null,
    },
    start: () => ({}),
    update: ({ state }, { event }) => {
      if (event.type === 'turn/end') return event.data.reason?.kind === 'completed' && state.card && !state.blocked
        ? { ...state, anchorSeq: event.seq } : state
      if (event.type === 'tool/call') return blockers.has(event.data.name) ? { blocked: true }
        : { blocked: state.blocked, callId: event.data.callId }
      if (typeof state.callId !== 'string' || event.data.message.source.callId !== state.callId) return state
      const result = toolResultText(event)
      if (!result || result.length > 65536) return state
      try {
        const parsed = JSON.parse(result)
        const card = parsed?.payrollForm
        return parsed.accepted === true && card?.kind === 'schedule' && validPayrollMonth(card.earliestMonth)
          && validPayrollMonth(card.currentMonth) ? { ...state, card } : state
      } catch {
        return state
      }
    },
    publication: ({ event }) => event.type === 'turn/end' ? 'immediate' : 'none',
    buildViewNode: ({ key, id, state, start }) => state?.anchorSeq === undefined ? null : {
      key, id, kind: payrollNode, target: 'chat', anchorSeq: state.anchorSeq,
      location: start.location, groupTree: 'turn', visibility: 'visible', data: state.card,
    },
  }
}

export function registerPayrollForm(ctx, { jsx, useState, usePreset, useId, toolResultText, panelSectionStyle, buttonStyle,
  OnboardingDateInput, sendOnboardingReply }) {
  ctx.inject(['uiConversation'], scope => scope.effect(() => scope.uiConversation.events.register(payrollFormDefinition(toolResultText)),
    'dsh-qianlai: payroll schedule form'))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: payrollNode }, PayrollForm))

  function PayrollForm({ node, sessionId, useSessions }) {
    const active = usePreset(sessionId, useSessions) === 'moneycome-zhangjie'
    const card = node.data
    const calendarId = useId()
    const [month, setMonth] = useState(card.periodKey || '')
    const [mode, setMode] = useState(Object.hasOwn(payrollModes, card.mode) ? card.mode : '')
    const [day, setDay] = useState(Number.isInteger(card.payday) && card.payday >= 1 && card.payday <= 31 ? String(card.payday) : '')
    const [state, setState] = useState('ready')
    if (!active) return null
    const maxMonth = String(Number(card.currentMonth.slice(0, 4)) + 1).padStart(4, '0') + card.currentMonth.slice(4)
    const ready = Object.hasOwn(payrollModes, mode) && validPayrollMonth(month) && month >= card.earliestMonth && month <= maxMonth
      && (mode === 'paused' || (Number(day) >= 1 && Number(day) <= 31))
    const submit = async event => {
      event.preventDefault()
      if (!ready || state === 'sending' || state === 'submitted') return
      setState('sending')
      try {
        await sendOnboardingReply(sessionId, '发薪安排表单已填：' + payrollModes[mode] + '，生效月份 ' + month
          + (mode === 'paused' ? '。' : '，发薪日 ' + day + ' 日。') + '请给我确认保存。')
        setState('submitted')
      } catch {
        setState('failed')
      }
    }
    const options = (entries, placeholder) => [
      jsx('option', { value: '', disabled: true, children: placeholder }), ...entries.map(([value, label]) => jsx('option', { value, children: label }, value)),
    ]
    const inputStyle = { ...buttonStyle, width: '100%', textAlign: 'left' }
    const fieldStyle = { display: 'grid', gap: 5, minWidth: 0 }
    const disabled = state === 'sending' || state === 'submitted'
    return jsx('form', {
      onSubmit: submit, 'aria-label': '调整发薪安排', style: { ...panelSectionStyle, maxWidth: '38rem' },
      children: [
        jsx('strong', { children: '调整发薪安排' }),
        disabled && state === 'submitted' ? jsx('p', { role: 'status', children: '已提交安排，等待确认。' }) : jsx('div', {
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(10rem, 100%), 1fr))', gap: '10px 14px', marginTop: 12 },
          children: [
            jsx('label', { style: fieldStyle, children: [
              '发薪方式', jsx('select', { required: true, disabled, style: inputStyle, value: mode,
                onChange: e => setMode(e.target.value), children: options(Object.entries(payrollModes), '请选择发薪方式') }),
            ] }),
            jsx('div', { style: fieldStyle, children: [
              jsx('label', { htmlFor: calendarId, children: '生效月份' }),
              jsx(OnboardingDateInput, { id: calendarId, name: 'payrollMonth', type: 'month', label: '生效月份',
                required: true, disabled, value: month, onChange: e => setMonth(e.target.value), style: inputStyle,
                min: card.earliestMonth, max: maxMonth }),
            ] }),
            mode !== 'paused' ? jsx('label', { style: fieldStyle, children: [
              '每月发薪日', jsx('select', { required: true, disabled, style: inputStyle, value: day,
                onChange: e => setDay(e.target.value),
                children: options(Array.from({ length: 31 }, (_, index) => [String(index + 1), index + 1 + ' 日']), '请选择日期') }),
            ] }) : null,
          ],
        }),
        state !== 'submitted' ? jsx('div', { style: { display: 'flex', justifyContent: 'end', marginTop: 12 },
          children: jsx('button', { type: 'submit', disabled: disabled || !ready, style: buttonStyle,
            children: state === 'sending' ? '提交中…' : '核对安排' }) }) : null,
        state === 'failed' ? jsx('p', { role: 'alert', children: '暂时无法提交。请重试当前表单。' }) : null,
      ],
    })
  }
}
