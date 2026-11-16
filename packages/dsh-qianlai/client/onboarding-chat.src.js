export function registerOnboardingChat(ctx, {
  jsx, useEffect, useRef, useState, usePreset,
  openOnboarding, refreshOnboarding, onboardingRequest,
}) {
  const kind = 'moneycome-onboarding-card'
  const toolName = 'moneycome_onboarding'
  const modes = { scan: '扫码建档', manual: '手动填写' }
  const fieldTypes = new Set(['text', 'date', 'month', 'select'])
  const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
  const cardStyle = {
    border: '1px solid var(--dsw-alias-border, #a3cdb6)', borderRadius: 12, padding: '12px 14px',
    color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-specific-bubble, #edf8f1)',
    maxWidth: 'min(100%, 38rem)', marginBlock: 8,
  }
  const controlStyle = {
    border: '1px solid var(--dsw-alias-border, #a3cdb6)', borderRadius: 6, padding: '7px 12px',
    font: 'inherit', color: 'inherit',
  }
  const secondary = { color: 'var(--dsw-alias-label-secondary)' }
  const actions = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }

  function validField(field) {
    return typeof field?.key === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(field.key)
      && typeof field.label === 'string' && field.label.length > 0 && field.label.length <= 60
      && fieldTypes.has(field.type)
      && (field.type !== 'select' || (Array.isArray(field.options) && field.options.length > 0
        && field.options.length <= 400 && field.options.every(option =>
          typeof option?.value === 'string' && option.value.length > 0 && typeof option.label === 'string')))
  }

  function cardOf(event) {
    const message = event.data?.message
    const content = message?.content
    if (event.surfaceOp !== 'append' || message?.isError || message?.source?.kind !== 'tool'
      || !Array.isArray(content) || content.length !== 1) return undefined
    const [part] = content
    if (part?.type !== 'text' || typeof part.text !== 'string' || part.text.length > 65536
      || !part.text.includes('"card"')) return undefined
    try {
      const result = JSON.parse(part.text)
      const card = result?.card
      if (result?.accepted !== true || typeof card?.id !== 'string' || !idPattern.test(card.id)
        || typeof card.draftId !== 'string' || !idPattern.test(card.draftId)
        || !Number.isSafeInteger(card.revision) || card.revision < 0) return undefined
      if (card.kind === 'mode') {
        return { id: card.id, draftId: card.draftId, revision: card.revision, kind: card.kind }
      }
      if (card.kind !== 'fields' || !Array.isArray(card.fields) || card.fields.length > 3
        || !card.fields.every(validField)
        || new Set(card.fields.map(({ key }) => key)).size !== card.fields.length) return undefined
      return {
        id: card.id, draftId: card.draftId, revision: card.revision, kind: card.kind,
        fields: card.fields.map(({ key, label, type, maxLength, options }) => ({
          key, label, type,
          ...(Number.isSafeInteger(maxLength) && maxLength > 0 && maxLength <= 200 ? { maxLength } : {}),
          ...(type === 'select' ? { options: options.map(({ value, label }) => ({ value, label })) } : {}),
        })),
      }
    } catch {
      return undefined
    }
  }

  function definition() {
    return {
      kind,
      target: 'chat',
      match: {
        'tool/call': event => event.data?.name === toolName && typeof event.data.callId === 'string'
          ? { id: event.data.callId, role: 'start' } : null,
        'tool/result': event => cardOf(event) && typeof event.data.message.source.callId === 'string'
          ? { id: event.data.message.source.callId, role: 'update' } : null,
      },
      start: () => null,
      update: ({ state }, { event }) => {
        const card = cardOf(event)
        return card ? { card, anchorSeq: event.seq } : state
      },
      buildViewNode: ({ key, id, state, start }) => state?.card ? {
        key, id, kind, target: 'chat', anchorSeq: state.anchorSeq,
        location: start.location, groupTree: 'turn', visibility: 'visible', data: state.card,
      } : null,
    }
  }

  function button(label, onClick, disabled = false, type = 'button') {
    return jsx('button', {
      type, disabled, onClick,
      style: { ...controlStyle, background: 'transparent', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 },
      children: label,
    }, label)
  }

  function shownError(error, fallback) {
    return typeof error?.message === 'string' && error.message.length <= 160 ? error.message : fallback
  }

  function Card({ sessionId, card }) {
    const [values, setValues] = useState({})
    const [status, setStatus] = useState(null)
    const [statusAttempt, setStatusAttempt] = useState(0)
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    const submitting = useRef(false)
    const { id: cardId, draftId, revision } = card
    const viewOnly = card.kind === 'fields' && card.fields.length === 0
    useEffect(() => {
      let active = true
      void onboardingRequest(sessionId, 'card-status', { cardId }).then(result => {
        if (!active) return
        setStatus(result)
        if (result.view) refreshOnboarding(sessionId, result.view)
      }, error => {
        if (active) setError(shownError(error, '建档卡片暂时无法加载。'))
      })
      return () => { active = false }
    }, [sessionId, cardId, statusAttempt])

    async function openDraft(options) {
      try {
        if (await openOnboarding(sessionId, options) === false)
          setError('暂时无法打开建档表单，请重试。')
      } catch {
        setError('暂时无法打开建档表单，请重试。')
      }
    }

    async function submit(input) {
      if (submitting.current || !status || status.receipt || status.stale) return
      submitting.current = true
      setError('')
      setSaving(true)
      try {
        const result = await onboardingRequest(sessionId, 'submit-card', { cardId, draftId, revision, ...input })
        setStatus(result)
        if (!result.receipt) return
        setValues({})
        if (card.kind === 'mode') await openDraft({ mode: result.receipt.mode ?? input.mode, view: result.view })
        else if (result.view) refreshOnboarding(sessionId, result.view)
      } catch (error) {
        setError(shownError(error, '建档资料暂时无法保存，请重试。'))
      } finally {
        submitting.current = false
        setSaving(false)
      }
    }

    const title = viewOnly ? '继续建档' : card.kind === 'mode' ? '选择建档方式' : '补充建档资料'
    const receipt = status?.receipt
    let body
    if (viewOnly) {
      body = jsx('div', { style: actions, children: button('打开建档表单', () => void openDraft()) })
    } else if (receipt) {
      const mode = Object.hasOwn(modes, receipt.mode) ? modes[receipt.mode] : undefined
      const labels = Array.isArray(receipt.labels) ? receipt.labels.filter(label => typeof label === 'string') : []
      body = [
        jsx('p', { role: 'status', style: { ...secondary, margin: '7px 0 0' },
          children: mode ? '已选择' + mode : labels.length ? '已保存 ' + labels.join('、') : '资料已保存。' }),
        jsx('div', { style: actions, children: button('查看建档表单', () => void openDraft()) }),
      ]
    } else if (status?.stale) {
      body = [
        jsx('p', { style: { ...secondary, margin: '7px 0 0' }, children: '建档进度已更新，请在右侧查看当前资料。' }),
        jsx('div', { style: actions, children: button('查看建档表单', () => void openDraft()) }),
      ]
    } else if (!status) {
      body = error ? jsx('div', { style: actions, children: button('重试加载', () => {
        setError('')
        setStatusAttempt(previous => previous + 1)
      }) }) : jsx('p', { role: 'status', style: { ...secondary, margin: '7px 0 0' }, children: '正在加载建档进度…' })
    } else if (card.kind === 'mode') {
      body = jsx('div', {
        style: actions, children: Object.entries(modes).map(([mode, label]) =>
          button(label, () => void submit({ mode }), saving)),
      })
    } else {
      body = jsx('form', {
        style: { display: 'grid', gap: 8, marginTop: 8 },
        onSubmit: event => { event.preventDefault(); void submit({ values }) },
        children: [...card.fields.map(field => {
          const input = {
            required: true, disabled: saving, value: values[field.key] ?? '',
            onChange: event => {
              const value = event.target.value
              setValues(previous => ({ ...previous, [field.key]: value }))
            },
            style: { ...controlStyle, background: 'var(--dsw-alias-fill-primary, transparent)', width: '100%', boxSizing: 'border-box' },
          }
          return jsx('label', {
            style: { display: 'grid', gap: 4 }, children: [
              field.label,
              field.type === 'select'
                ? jsx('select', { ...input, children: [
                  jsx('option', { value: '', children: '请选择' }),
                  ...field.options.map(({ value, label }) => jsx('option', { value, children: label }, value)),
                ] })
                : jsx('input', { ...input, type: field.type, maxLength: field.maxLength }),
            ],
          }, field.key)
        }), jsx('div', { style: actions, children: button('保存到草稿', undefined, saving, 'submit') })],
      })
    }

    return jsx('section', {
      'aria-label': title, 'data-qianlai-onboarding-card': cardId, style: cardStyle,
      children: [
        jsx('strong', { children: title }), body,
        error ? jsx('p', { role: 'alert', style: { margin: '8px 0 0' }, children: error }) : null,
      ],
    })
  }

  function ZhangjieOnboardingCard({ node, sessionId, useSessions }) {
    if (usePreset(sessionId, useSessions) !== 'moneycome-zhangjie') return null
    return jsx(Card, { card: node.data, sessionId }, sessionId + ':' + node.data.id)
  }

  ctx.inject(['uiConversation'], scope => {
    scope.effect(() => scope.uiConversation.events.register(definition()), 'dsh-qianlai: onboarding chat card')
  })
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register({ name: 'conversation.chat.node', key: kind }, ZhangjieOnboardingCard),
  )
}
