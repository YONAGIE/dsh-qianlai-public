/* global FormData, setInterval, clearInterval */

export function onboardingFieldError(key, value, { savedNumber = false, lastMonth } = {}) {
  const input = String(value ?? '').trim()
  if (key === 'accountTail' && !/^\d{4}$/.test(input)) return '请输入四位数字，开头的 0 也要保留。'
  if (key === 'number' && (!savedNumber || input) && !/^\d{4,34}$/.test(input.replace(/[ -]/g, '')))
    return '请输入 4 至 34 位数字。账号中的空格和短横线会自动忽略。'
  if (key === 'holder' && !input) return '请填写账户户名。'
  if (key === 'bank' && !input) return '请填写开户行。'
  if (key === 'currency' && !/^[A-Z]{3}$/i.test(input)) return '请输入三位币种代码，如 CNY。'
  if (key === 'taxId' && input && !/^[A-Z0-9]{18}$/i.test(input)) return '请输入 18 位统一社会信用代码。'
  if ((key === 'establishedOn' || key === 'openedOn') && input) {
    const date = new Date(input + 'T00:00:00Z')
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input || input > today)
      return (key === 'openedOn' ? '开户日期' : '成立日期') + '须为有效日期，且不能晚于今天。'
  }
  if (key === 'startMonth' && input && lastMonth && input <= lastMonth)
    return '起账月份须在旧账截止月 ' + lastMonth + ' 之后。'
  return ''
}

export function registerOnboardingChat(ctx, {
  jsx, useEffect, useRef, useState, usePreset, OnboardingDateInput = 'input',
  openOnboarding, refreshOnboarding, onboardingRequest, sendOnboardingReply, subscribeOnboarding,
  readOnboardingFile, taxRequest, previewOnboardingTax, taxRegionCities = {},
}) {
  const kind = 'moneycome-onboarding-card'
  const toolName = 'moneycome_onboarding'
  const modes = { scan: '扫码建档', manual: '手动填写' }
  const fieldTypes = new Set(['text', 'date', 'month', 'select', 'multi'])
  const kinds = new Set(['mode', 'source', 'upload', 'document', 'fields', 'region', 'tax-scan', 'bank', 'bank-next', 'confirm', 'blocked'])
  const titles = {
    mode: '选择建档方式', source: '提供公司资料', upload: '上传建档资料', fields: '补充建档资料',
    region: '选择税务地区', 'tax-scan': '电子税务局扫码', bank: '填写银行账户',
    'bank-next': '银行账户已保存', confirm: '确认建档', blocked: '请核对企业情况',
  }
  const corrections = [
    { value: 'edit-company', label: '企业信息' },
    { value: 'edit-accounting', label: '记账准备' },
    { value: 'edit-payroll', label: '工资社保' },
  ]
  const bankFields = [
    { key: 'holder', label: '户名', type: 'text', maxLength: 200 },
    { key: 'bank', label: '开户行', type: 'text', maxLength: 200 },
    { key: 'number', label: '银行账号', type: 'text', maxLength: 48 },
    { key: 'currency', label: '币种', type: 'select', options: [
      { value: 'CNY', label: '人民币 (CNY)' }, { value: 'USD', label: '美元 (USD)' },
      { value: 'HKD', label: '港元 (HKD)' }, { value: 'EUR', label: '欧元 (EUR)' },
      { value: 'GBP', label: '英镑 (GBP)' }, { value: 'JPY', label: '日元 (JPY)' },
      { value: 'SGD', label: '新加坡元 (SGD)' }, { value: 'AUD', label: '澳元 (AUD)' },
      { value: 'CAD', label: '加拿大元 (CAD)' },
    ] },
    { key: 'openedOn', label: '开户日期（选填）', type: 'date', required: false },
  ]
  const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
  const controlBorder = '1px solid color-mix(in srgb, currentColor 18%, transparent)'
  const accent = 'var(--dsw-static-deepseek-500, #1f8a5b)'
  const accentStrong = 'var(--dsw-static-deepseek-600, #1b6f4a)'
  const tintedSurface = 'color-mix(in srgb, ' + accent + ' 6%, transparent)'
  const cardStyle = {
    border: controlBorder, borderRadius: 16, padding: '18px clamp(12px, 4%, 24px)',
    color: 'var(--dsw-alias-label-primary)',
    background: 'color-mix(in srgb, ' + accent + ' 3%, var(--dsw-alias-fill-primary, transparent))',
    boxShadow: '0 2px 8px color-mix(in srgb, #000 4%, transparent)',
    boxSizing: 'border-box', width: 'min(100%, 39rem)', marginBlock: 12,
  }
  const receiptStyle = { ...cardStyle, background: 'transparent', boxShadow: 'none', paddingBlock: 11 }
  const controlStyle = {
    border: controlBorder, borderRadius: 9, padding: '8px 12px', minHeight: 40,
    font: 'inherit', color: 'inherit', boxSizing: 'border-box',
  }
  const secondary = { color: 'var(--dsw-alias-label-secondary)', fontSize: '0.875em', lineHeight: 1.55 }
  const actions = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }
  const footerActions = { ...actions, justifyContent: 'flex-end' }
  const cardHeading = { fontSize: '1.05em', lineHeight: 1.45, fontWeight: 670, margin: 0 }
  const formColumns = 'repeat(auto-fit, minmax(min(100%, max(10rem, 45%)), 1fr))'
  const startingTaxFlows = new Map()

  function validField(field) {
    return typeof field?.key === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(field.key)
      && typeof field.label === 'string' && field.label.length > 0 && field.label.length <= 60
      && fieldTypes.has(field.type)
      && (!['select', 'multi'].includes(field.type) || (Array.isArray(field.options) && field.options.length > 0
        && field.options.length <= 400 && field.options.every(option =>
          typeof option?.value === 'string' && option.value.length > 0 && typeof option.label === 'string')))
  }

  function validCard(card) {
    if (typeof card?.id !== 'string' || !idPattern.test(card.id)
      || typeof card.draftId !== 'string' || !idPattern.test(card.draftId)
      || !Number.isSafeInteger(card.revision) || card.revision < 0 || !kinds.has(card.kind)) return undefined
    if (['source', 'upload', 'document'].includes(card.kind) && !['license', 'tax'].includes(card.documentKind)) return undefined
    if (card.kind === 'tax-scan' && (typeof card.province !== 'string' || typeof card.city !== 'string')) return undefined
    if (['fields', 'document'].includes(card.kind) && (!Array.isArray(card.fields) || card.fields.length > 9 || !card.fields.every(validField)
      || new Set(card.fields.map(({ key }) => key)).size !== card.fields.length)) return undefined
    return card
  }

  function toolResult(event) {
    const message = event.data?.message
    const content = message?.content
    if (event.surfaceOp !== 'append' || message?.isError || message?.source?.kind !== 'tool'
      || !Array.isArray(content) || content.length !== 1) return undefined
    const [part] = content
    if (part?.type !== 'text' || typeof part.text !== 'string' || part.text.length > 65536) return undefined
    try {
      return JSON.parse(part.text)
    } catch {
      return undefined
    }
  }

  function questionFallbackCard(event, previousProfileCard) {
    const message = event.data?.message
    const prefix = 'Error: 请用下方钱来建档表单完成当前步骤。当前建档卡：'
    if (event.surfaceOp !== 'append' || message?.source?.kind !== 'tool' || !message.isError ||
      !Array.isArray(message.content) || message.content.length !== 1) return undefined
    const [part] = message.content
    if (part?.type !== 'text' || typeof part.text !== 'string' || part.text.length > 65536) return undefined
    if (previousProfileCard && part.text.startsWith('Error: 本轮已经提供企业档案更正卡，')) return previousProfileCard
    if (!part.text.startsWith(prefix)) return undefined
    try {
      return validCard(JSON.parse(part.text.slice(prefix.length)))
    } catch {
      return undefined
    }
  }

  function turnMatch(event, role = 'update') {
    return Number.isSafeInteger(event.data?.turn) ? { id: String(event.data.turn), role } : null
  }

  function definition() {
    return {
      kind,
      target: 'chat',
      match: {
        'turn/start': event => turnMatch(event, 'start'),
        'tool/call': event => [toolName, 'ask_user_question'].includes(event.data?.name)
          && typeof event.data.callId === 'string' ? turnMatch(event) : null,
        'tool/result': event => typeof event.data?.message?.source?.callId === 'string' ? turnMatch(event) : null,
        'turn/end': event => turnMatch(event),
      },
      start: (_context, _match, reader) => {
        const previousCardId = reader?.previous(kind)?.state.lastShownCardId
        return { calls: [], previousCardId, lastShownCardId: previousCardId }
      },
      update: ({ state }, { event }) => {
        if (event.type === 'turn/end') {
          const completed = event.data.reason?.kind === 'completed'
          const show = completed && state.card && state.card.id !== state.previousCardId
          return { ...state, anchorSeq: event.seq, show, lastShownCardId: show ? state.card.id : state.previousCardId }
        }
        if (event.type === 'tool/call') {
          if (event.data.name === 'ask_user_question') {
            // A question invalidates any proposed action from before the question.
            return {
              ...state, calls: [], card: undefined, question: event.data.callId,
              previousProfileCard: state.card?.maintenance ? state.card : undefined,
            }
          }
          return state.question ? state : { ...state, calls: [...state.calls, event.data.callId] }
        }
        const callId = event.data.message.source.callId
        if (callId === state.question) {
          const fallback = questionFallbackCard(event, state.previousProfileCard)
          if (fallback) return { ...state, card: fallback, question: undefined }
          const result = toolResult(event)
          const answered = !result?.pending && Array.isArray(result?.answers) && result.answers.some(answer =>
            (Array.isArray(answer?.selected) && answer.selected.some(label => typeof label === 'string' && label.trim())) ||
            (typeof answer?.custom === 'string' && answer.custom.trim()),
          )
          return answered ? { ...state, question: undefined } : state
        }
        if (!state.calls.includes(callId)) return state
        const result = toolResult(event)
        const card = validCard(result?.card)
        const readProfile = result?.accepted === true && result.completed === true && typeof result.field === 'string'
        if (!card && state.card?.maintenance && (readProfile || result?.code === 'PROFILE_CARD_OPEN')) return state
        return { ...state, card }
      },
      publication: ({ event }) => event.type === 'turn/end' ? 'immediate' : 'none',
      buildViewNode: ({ key, id, state, start }) => state?.anchorSeq !== undefined ? {
        key, id, kind, target: 'chat', anchorSeq: state.anchorSeq,
        location: start.location, groupTree: 'turn',
        // Replay can hide a previously shown card while keeping the same node.
        visibility: state.show ? 'visible' : 'hidden',
        data: state.show ? state.card : null,
      } : null,
    }
  }

  function button(label, onClick, disabled = false, type = 'button', primary = false) {
    return jsx('button', {
      type, disabled, onClick,
      style: {
        ...controlStyle,
        ...(primary ? {
          background: accentStrong, borderColor: accentStrong, color: '#fff', fontWeight: 650,
        } : { background: 'var(--dsw-alias-fill-primary, transparent)', fontWeight: 520 }),
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
        maxWidth: '100%', overflowWrap: 'anywhere',
      },
      children: label,
    }, label)
  }

  function shownError(error, fallback) {
    return typeof error?.message === 'string' && error.message.length <= 160 ? error.message : fallback
  }

  function sourceText(documentKind) {
    if (documentKind === 'tax') return '税务资料'
    if (documentKind === 'bank') return '银行开户资料'
    return '营业执照'
  }

  function replyFor(card, input, result) {
    switch (card.kind) {
      case 'mode':
        return '我选择' + modes[input.mode] + '。'
      case 'region': {
        const { province = input.values.province, city = input.values.city } = result.view?.enterprise ?? {}
        return '我的税务地区是' + (province === city ? city : province + ' ' + city) + '，请继续。'
      }
      case 'source':
        return input.document ? '我已上传' + sourceText(card.documentKind) + '，请继续。'
          : '我想自己填写' + (card.documentKind === 'tax' ? '税务资料' : '公司资料') + '。'
      case 'upload':
        return '我已上传' + sourceText(card.documentKind) + '，请继续。'
      case 'document':
        return '我已核对并确认' + (card.documentKind === 'tax' ? '税务资料' : '公司资料') + '，请继续建档。'
      case 'tax-scan':
        return '我已核对并回填税务资料，请继续建档。'
      case 'bank':
        return input.choice === 'skip' ? '银行账户资料我稍后补，请继续。' : '我已填好这个银行账户，请继续。'
      case 'bank-next':
        return input.choice === 'add' ? '我还要添加一个银行账户。' : '银行账户已核对，请继续建档。'
      case 'confirm':
        if (input.choice === 'confirm') return '我已确认建档，请告诉我下一步。'
        return '我要更正' + (corrections.find(item => item.value === input.choice)?.label ?? '建档资料') + '。'
      case 'blocked':
        return '我想重新核对企业情况。'
      default: {
        if (card.recheck) return '我已核对并保存' + card.fields[0].label + '，请继续建档。'
        if (card.correction) return '我已核对并保存更正，请继续建档。'
        const labels = card.fields.filter(field => Object.hasOwn(input.values ?? {}, field.key) &&
          input.values[field.key]?.length).map(field => field.label)
        return labels.length ? '我已填写' + labels.join('、') + '，请继续建档。' : '资料已填写，请继续建档。'
      }
    }
  }

  function form({ fields, values, change, saving, onSubmit, label = '保存到草稿', secondaryAction,
    reviewed, review, serverIssue, errorPrefix, establishedOn, lastMonth }) {
    const inputStyle = {
      ...controlStyle,
      background: 'var(--dsw-alias-fill-primary, transparent)',
      width: '100%',
      minWidth: 0,
    }
    const visibleFields = fields.filter(field => !field.requiredWhen || values[field.requiredWhen] === '其他')
    return jsx('form', {
      style: { display: 'grid', gridTemplateColumns: formColumns, gap: '12px 16px', marginTop: 12 },
      onSubmit: event => {
        event.preventDefault()
        const target = event.currentTarget
        const input = target ? new FormData(target) : undefined
        const submitted = Object.fromEntries(visibleFields.map(({ key, type }) => [
          key, input ? (type === 'multi' ? input.getAll(key) : input.get(key)) : values[key],
        ]))
        const invalid = visibleFields.filter(field => onboardingFieldError(field.key, submitted[field.key], submitted))
        if (invalid.length) {
          review(invalid.map(field => field.key))
          target?.elements.namedItem(invalid[0].key)?.focus()
          return
        }
        onSubmit(submitted)
      },
      children: [...visibleFields.map(field => {
        if (field.type === 'multi') {
          const existing = values[field.key] ?? []
          return jsx('fieldset', {
            style: { gridColumn: '1 / -1', minWidth: 0, margin: 0, padding: 8, border: cardStyle.border, borderRadius: 6 },
            children: [jsx('legend', { children: field.label }), jsx('div', {
              style: { display: 'flex', flexWrap: 'wrap', gap: '4px 16px' },
              children: field.options.map(({ value, label }) => jsx('label', {
                style: { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 32 }, children: [
                jsx('input', {
                  name: field.key, type: 'checkbox', value, disabled: saving, checked: existing.includes(value),
                  onChange: event => {
                    const selected = event.target.checked
                      ? value === 'none' ? ['none'] : [...existing.filter(item => item !== 'none'), value]
                      : existing.filter(item => item !== value)
                    change(field.key, selected)
                  },
                }), label,
              ] }, value)),
            })],
          }, field.key)
        }
        const value = values[field.key] ?? ''
        const isDate = field.type === 'date' || field.type === 'month'
        const error = (reviewed[field.key] && onboardingFieldError(field.key, value, values)) ||
          (serverIssue?.field === field.key ? serverIssue.message : '')
        const fieldId = errorPrefix + '-' + field.key
        const errorId = fieldId + '-error'
        const input = {
          id: fieldId, name: field.key, required: Boolean(field.requiredWhen) || field.required !== false, disabled: saving, value,
          onChange: event => change(field.key, event.target.value),
          onBlur: () => review([field.key]),
          'aria-invalid': error ? true : undefined,
          'aria-describedby': error ? errorId : undefined,
          style: error ? { ...inputStyle, borderColor: 'var(--dsw-alias-label-danger, #ad3939)' } : inputStyle,
        }
        return jsx(isDate ? 'div' : 'label', {
          style: { display: 'grid', alignContent: 'start', gap: 5, minWidth: 0,
            ...(['companyName', 'taxAuthority'].includes(field.key) || field.requiredWhen ? { gridColumn: '1 / -1' } : {}) }, children: [
            isDate ? jsx('label', { htmlFor: fieldId, children: field.label }) : field.label,
            field.type === 'select'
              ? jsx('select', { ...input, disabled: saving || !field.options.length, children: [
                jsx('option', { value: '', disabled: true, children: '请选择' }),
                ...field.options.map(({ value, label }) => jsx('option', { value, children: label }, value)),
              ] })
              : isDate
                ? jsx(OnboardingDateInput, { ...input, type: field.type, label: field.label, establishedOn,
                  lastMonth: values.history && values.history !== 'previous' ? undefined : values.lastMonth ?? lastMonth })
                : jsx('input', { ...input, type: field.type, maxLength: field.maxLength,
                  inputMode: ['number', 'accountTail'].includes(field.key) ? 'numeric' : undefined,
                  ...(field.requiredWhen ? { placeholder: '请按税务登记资料填写' } : {}) }),
            error ? jsx('span', { id: errorId, role: 'alert', style: { color: 'var(--dsw-alias-label-danger, #ad3939)', fontSize: '0.875em' }, children: error }) : null,
          ],
        }, field.key)
      }), jsx('div', {
        style: { ...footerActions, gridColumn: '1 / -1', marginTop: 0 },
        children: [secondaryAction, button(label, undefined, saving, 'submit', true)],
      })],
    })
  }

  function startTaxIfNeeded(sessionId, card, enterprise) {
    const { id, draftId, revision, province, city } = card
    const status = () => taxRequest('status', id, sessionId, draftId, {})
    if (!card.autoStart) return status()
    // Share the claim/start operation across remounts while the RPC is pending.
    const running = startingTaxFlows.get(id)
    if (running) return running
    const attempt = (async () => {
      const { start } = await onboardingRequest(sessionId, 'claim-tax-auto-start', { cardId: id, draftId, revision })
      if (!start) return status()
      const { companyName = '', taxId = '' } = enterprise ?? {}
      return taxRequest('start', id, sessionId, draftId, { province, city, companyName, taxId })
    })()
    startingTaxFlows.set(id, attempt)
    const clear = () => startingTaxFlows.delete(id)
    void attempt.then(clear, clear)
    return attempt
  }

  function TaxStep({ sessionId, card, enterprise, onConfirm }) {
    const [flow, setFlow] = useState(null)
    const [error, setError] = useState('')
    const attempt = useRef(null)

    async function request(action, current = attempt.current) {
      if (!current || current.stopped || (current.pending && action !== 'cancel')) return false
      const serial = ++current.serial
      current.pending = true
      if (action !== 'status') setError('')
      if (action === 'start') setFlow({ phase: 'opening' })
      try {
        const { id, draftId, province, city } = card
        const { companyName = '', taxId = '' } = enterprise ?? {}
        const result = await (action === 'initial' ? startTaxIfNeeded(sessionId, card, enterprise)
          : taxRequest(action, id, sessionId, draftId, action === 'start'
            ? { province, city, companyName, taxId } : {}))
        if (current.stopped || current.serial !== serial) return false
        setError('')
        setFlow(result)
        if (result.phase === 'ready') previewOnboardingTax?.(sessionId, result.profile, draftId)
        else if (['idle', 'failed', 'submitted'].includes(result.phase)) previewOnboardingTax?.(sessionId)
        if (action === 'submit') current.wantsReceipt = ['submitting', 'submitted'].includes(result.phase)
        if (result.phase === 'ready') current.wantsReceipt = false
        if (result.phase === 'submitted' && current.wantsReceipt) {
          await onConfirm()
          current.wantsReceipt = false
        }
        return true
      } catch (error) {
        if (!current.stopped && current.serial === serial) {
          if (action === 'start' || action === 'initial') setFlow({ phase: 'failed' })
          setError(shownError(error, '暂时无法连接电子税务局，请重试。'))
        }
        return false
      } finally {
        if (current.serial === serial) current.pending = false
      }
    }

    useEffect(() => {
      const current = { stopped: false, pending: false, serial: 0 }
      attempt.current = current
      void request('initial', current)
      return () => { current.stopped = true }
    }, [sessionId, card.id])
    const phase = flow?.phase
    useEffect(() => {
      if (!['opening', 'waiting', 'reading', 'submitting'].includes(phase)) return
      const timer = setInterval(() => void request('status'), 1400)
      return () => clearInterval(timer)
    }, [sessionId, card.id, phase])

    const status = {
      opening: '正在为您打开官方扫码页…',
      waiting: '请在官方网页扫码并选择企业。登录后张姐会自动读取资料。',
      reading: '已登录，正在读取税务资料…',
      ready: '税务资料已在右侧表单显示，请核对后回填。',
      submitting: '正在保存税务资料…',
      submitted: '税务资料已保存。',
    }[phase]
    const message = flow?.message || status || (!flow && !error ? '正在检查扫码进度…' : undefined)
    const active = ['opening', 'waiting', 'reading'].includes(phase)
    return [
      message ? jsx('p', { role: 'status', style: secondary, children: message }) : null,
      error ? jsx('p', { role: 'alert', children: error }) : null,
      jsx('div', { style: footerActions, children: [
        active || phase === 'ready' ? button('取消扫码', () => void request('cancel')) : null,
        phase === 'idle' || phase === 'failed'
          ? button('重新打开扫码页', () => void request('start')) : null,
        phase === 'waiting' && flow.retryRead ? button('重试读取', () => void request('read')) : null,
        phase === 'ready' ? button('核对无误，回填税务资料', () => void request('submit'), false, 'button', true) : null,
        phase === 'submitted' && error ? button('继续建档', () => void request('status')) : null,
      ] }),
    ]
  }

  function Card({ sessionId, card: projectedCard }) {
    const [values, setValues] = useState({})
    const [reviewed, setReviewed] = useState({})
    const [serverIssue, setServerIssue] = useState(null)
    const [status, setStatus] = useState(null)
    const [reopenedCard, setReopenedCard] = useState(null)
    const [statusAttempt, setStatusAttempt] = useState(0)
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    const [readingDocument, setReadingDocument] = useState('')
    const [documentPreview, setDocumentPreview] = useState(null)
    const [dropActive, setDropActive] = useState(false)
    const [obsolete, setObsolete] = useState(false)
    const [pendingReply, setPendingReply] = useState('')
    const submitting = useRef(false)
    const sending = useRef(false)
    const documentInput = useRef(null)
    const currentRevision = useRef(projectedCard.revision)
    const statusVersion = useRef(0)
    const card = status?.card ?? reopenedCard ?? projectedCard
    const { id: cardId, draftId, revision } = card
    const viewOnly = card.kind === 'fields' && card.fields.length === 0
    const buildForm = props => form({
      ...props, reviewed, serverIssue, errorPrefix: 'onboarding-' + cardId,
      establishedOn: status?.view?.enterprise?.establishedOn,
      lastMonth: status?.view?.accounting?.history === 'previous' ? status.view.accounting.lastMonth : undefined,
      review: keys => setReviewed(previous => ({ ...previous, ...Object.fromEntries(keys.map(key => [key, true])) })),
    })
    function applyStatus(result) {
      statusVersion.current++
      if (result.card) currentRevision.current = result.card.revision
      setStatus(result)
      if (result.view) refreshOnboarding(sessionId, result.view)
    }
    useEffect(() => {
      let active = true
      const version = statusVersion.current
      void onboardingRequest(sessionId, 'card-status', { cardId }).then(result => {
        if (!active || version !== statusVersion.current) return
        applyStatus(result)
      }, error => {
        if (active && version === statusVersion.current) setError(shownError(error, '建档卡片暂时无法加载。'))
      })
      return () => { active = false }
    }, [sessionId, cardId, statusAttempt])
    useEffect(() => {
      return subscribeOnboarding?.((source, { view }) => {
        if (source === sessionId && view?.draftId === draftId && view.revision > currentRevision.current) setObsolete(true)
      })
    }, [sessionId, draftId])

    async function openDraft(options) {
      try {
        if (await openOnboarding(sessionId, options) === false)
          setError('暂时无法打开建档表单，请重试。')
      } catch {
        setError('暂时无法打开建档表单，请重试。')
      }
    }

    async function sendReply(message) {
      if (sending.current) return
      sending.current = true
      setSaving(true)
      setError('')
      try {
        await sendOnboardingReply(sessionId, message)
        setPendingReply('')
      } catch {
        setPendingReply(message)
        setError('资料已保存，但没有发到对话。您可重试发送。')
      } finally {
        setSaving(false)
        sending.current = false
      }
    }

    async function finishCard(result, input = {}) {
      applyStatus(result)
      if (result.incomplete && result.card) {
        setValues({})
        setDocumentPreview(null)
        return
      }
      if (!result.receipt) throw Error('未能确认资料已保存，请重试。')
      setValues({})
      if (card.maintenance) return
      if (card.kind === 'mode') void openDraft({ mode: result.receipt.mode ?? input.mode, view: result.view })
      await sendReply(replyFor(card, input, result))
    }

    async function reopenProfileCard() {
      if (submitting.current) return
      submitting.current = true
      setError('')
      setSaving(true)
      try {
        const result = await onboardingRequest(sessionId, 'reopen-profile-card', { cardId })
        const fresh = validCard(result.card)
        if (result.cardState !== 'active' || !fresh || fresh.draftId !== draftId ||
          fresh.maintenance?.field !== card.maintenance.field || fresh.id === cardId)
          throw Error('未能打开本次更正表单，请重试。')
        setReopenedCard(fresh)
        setValues({})
        setReviewed({})
        setServerIssue(null)
        setObsolete(false)
        applyStatus(result)
      } catch (error) {
        setError(shownError(error, '更正表单暂时无法打开，请重试。'))
      } finally {
        submitting.current = false
        setSaving(false)
      }
    }

    async function submit(input) {
      if (submitting.current || !status || status.receipt || status.stale || obsolete) return
      submitting.current = true
      setError('')
      setServerIssue(null)
      setSaving(true)
      try {
        const payload = { cardId, draftId, revision, ...input }
        const result = await onboardingRequest(sessionId, 'submit-card', payload)
        await finishCard(result, payload)
      } catch (error) {
        const message = shownError(error, '建档资料暂时无法保存，请重试。')
        if (Object.hasOwn(input.values ?? {}, error?.details?.field))
          setServerIssue({ field: error.details.field, message })
        else setError(message)
        if (['DRAFT_STALE', 'CARD_UNAVAILABLE', 'ONBOARDING_CHANGED'].includes(error?.code))
          setStatusAttempt(attempt => attempt + 1)
      } finally {
        submitting.current = false
        setSaving(false)
      }
    }

    async function loadDocument(file) {
      if (!file || submitting.current || !status || status.receipt || status.stale || obsolete) return
      submitting.current = true
      setError('')
      setSaving(true)
      setReadingDocument(file.name.slice(0, 120) || '所选文件')
      try {
        if (!file.size || file.size > 8 * 1024 * 1024) throw Error('请选择不超过 8 MB 的 PDF 或图片。')
        const result = await onboardingRequest(sessionId, 'recognize', {
          cardId, draftId, revision,
          file: { name: file.name, mimeType: file.type, base64: await readOnboardingFile(file) },
        })
        const current = { ...card.initialValues, ...values }
        const fields = card.kind === 'bank' ? bankFields : card.fields
        const held = fields.filter(({ key }) => current[key]?.trim() &&
          Object.hasOwn(result.fields, key) && current[key].trim() !== result.fields[key]).map(({ label }) => label)
        setDocumentPreview({ fields: result.fields, held })
      } catch (error) {
        setError(shownError(error, '这份资料暂时无法识别，可以继续填写。'))
      } finally {
        submitting.current = false
        setSaving(false)
        setReadingDocument('')
      }
    }

    function selectDocument(event) {
      const file = event.target.files?.[0]
      event.target.value = ''
      void loadDocument(file)
    }

    function loadSingleDocument(files) {
      if (files.length === 1) void loadDocument(files[0])
      else if (files.length > 1) setError('一次只能识别一份资料。请选择其中一份。')
    }

    function pasteDocument(event) {
      const transfer = event.clipboardData
      if (!transfer || event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      const files = transfer.files?.length ? transfer.files : Array.from(transfer.items ?? [])
        .filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean)
      if (!files.length) return
      event.preventDefault()
      event.stopPropagation()
      if (!submitting.current) loadSingleDocument(files)
    }

    function handleDocumentDrag(event, phase) {
      const transfer = event.dataTransfer
      if (!transfer?.types?.includes('Files') && !transfer?.files?.length) return
      event.stopPropagation()
      if (phase === 'leave') {
        if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) setDropActive(false)
        return
      }
      event.preventDefault()
      if (phase !== 'over') {
        // DSH's composer resets its drag overlay on window dragend. A card
        // intercepts the document drop, and dragging a file from the OS may
        // not emit its own dragend on this page.
        const view = event.currentTarget?.ownerDocument?.defaultView
        if (view) view.dispatchEvent(new view.Event('dragend'))
      }
      if (phase === 'drop') {
        setDropActive(false)
        loadSingleDocument(transfer.files)
        return
      }
      transfer.dropEffect = saving ? 'none' : 'copy'
      setDropActive(!saving)
    }

    function change(key, value) {
      setValues(previous => ({ ...previous, [key]: value, ...(key === 'province' ? { city: '' } : {}) }))
      if (serverIssue?.field === key) setServerIssue(null)
    }
    function saveFields(fields, values) {
      if (fields.some(field => field.type === 'multi' && !values[field.key]?.length)) {
        setError('请先选择一项。')
        return
      }
      void submit({ values })
    }
    const prefilled = card.initialValues ?? {}
    const wantsTax = card.documentKind === 'tax'
    const sourceTitle = wantsTax ? '选择税务资料填写方式' : '选择公司资料填写方式'
    const documentTitle = wantsTax ? '核对税务资料' : '核对公司资料'
    const title = viewOnly ? '继续建档' : card.title || (card.kind === 'source' ? sourceTitle : card.kind === 'document' ? documentTitle : titles[card.kind])
    const receipt = status?.receipt
    const documentCard = card.kind === 'source' || card.kind === 'upload'
    const bankCard = card.kind === 'bank'
    const documentForm = (card.kind === 'document' || bankCard) && status && !status.stale && !receipt && !obsolete
    const choices = {
      mode: [
        button(modes.manual, () => void submit({ mode: 'manual' }), saving),
        button(modes.scan, () => void submit({ mode: 'scan' }), saving, 'button', true),
      ],
      'bank-next': [
        button('再添加一个账户', () => void submit({ choice: 'add' }), saving),
        button('继续', () => void submit({ choice: 'continue' }), saving, 'button', true),
      ],
    }
    let body
    if (viewOnly) {
      body = jsx('div', { style: actions, children: button('打开建档表单', () => void openDraft()) })
    } else if (receipt) {
      const mode = Object.hasOwn(modes, receipt.mode) ? modes[receipt.mode] : undefined
      const labels = Array.isArray(receipt.labels) ? receipt.labels.filter(label => typeof label === 'string') : []
      const choice = documentCard ? {
        license: wantsTax ? '已选择上传税务资料' : '已选择上传营业执照',
        manual: '已选择自己填写',
      }[receipt.choice] ?? (labels.length ? sourceText(card.documentKind) + '已识别，资料已保存。' : undefined) : undefined
      body = [
        jsx('p', { role: 'status', style: { ...secondary, margin: '7px 0 0' },
          children: receipt.notice ?? (mode ? '已选择' + mode : choice ?? (labels.length ? '已保存 ' + labels.join('、') : '资料已保存。')) }),
        card.maintenance ? jsx('div', { style: actions, children: button('再次更正', () => void reopenProfileCard(), saving) }) : null,
        pendingReply ? jsx('div', { style: actions, children: button('重试发送到对话', () => void sendReply(pendingReply), saving) }) : null,
      ]
    } else if (status?.stale || obsolete) {
      body = [
        jsx('p', { role: 'status', style: { ...secondary, margin: '7px 0 0' }, children: card.maintenance
          ? '这张更正卡已失效，可以按最新资料重新打开。' : '建档资料已更新，可以按最新进度继续。' }),
        jsx('div', { style: actions, children: card.maintenance
          ? button('重新打开更正', () => void reopenProfileCard(), saving)
          : button('继续建档', () => void sendReply('请按最新资料继续建档。'), saving) }),
      ]
    } else if (!status) {
      body = error ? jsx('div', { style: actions, children: button('重试加载', () => {
        setError('')
        setStatusAttempt(previous => previous + 1)
      }) }) : jsx('p', { role: 'status', style: { ...secondary, margin: '7px 0 0' }, children: '正在加载建档进度…' })
    } else if (Object.hasOwn(choices, card.kind)) {
      body = jsx('div', { style: footerActions, children: choices[card.kind] })
    } else if (documentForm) {
      const documentName = sourceText(bankCard ? 'bank' : card.documentKind)
      const label = '选择' + documentName
      const uploadHintId = 'qianlai-document-upload-hint-' + cardId
      const defaults = bankCard ? { currency: 'CNY', holder: status.view?.enterprise?.companyName ?? '' } : {}
      const documentValues = { ...defaults, ...documentPreview?.fields, ...prefilled, ...values }
      const fields = bankCard ? bankFields.map(field => {
        if (field.key !== 'currency' || field.options.some(option => option.value === documentValues.currency)) return field
        return { ...field, options: [...field.options, { value: documentValues.currency, label: documentValues.currency }] }
      }) : card.fields
      const complete = !bankCard && fields.every(field => (field.requiredWhen && documentValues[field.requiredWhen] !== '其他') ||
        documentValues[field.key]?.trim())
      const confirm = complete ? (wantsTax ? '确认税务资料' : '确认公司资料') : '保存到草稿'
      const prefilledText = documentPreview?.held.length
        ? '保留了原先填写的' + documentPreview.held.join('、') + '。请对照资料核对后确认。'
        : '请核对预填内容，补齐缺项后确认。'
      body = [
        jsx('div', {
          role: 'group', tabIndex: 0, 'aria-label': '添加' + documentName, 'aria-describedby': uploadHintId,
          style: { ...actions, gap: '8px 12px', padding: '12px 14px', background: tintedSurface, border: '1px dashed color-mix(in srgb, ' + accent + ' 42%, transparent)', borderRadius: 10 },
          children: [
            button(label, () => documentInput.current?.click(), saving),
            jsx('span', { id: uploadHintId, style: secondary, children: '也可拖入文件，或点这里按 Ctrl+V（Mac 上按 ⌘V）粘贴。' }),
            jsx('input', {
              ref: documentInput, type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp',
              hidden: true, disabled: saving, onChange: selectDocument,
            }),
          ],
        }),
        jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }, children: [
          readingDocument ? jsx('progress', { 'aria-hidden': true, style: { width: '3rem', height: 8, accentColor: accent, flex: 'none' } }) : null,
          jsx('p', {
            role: readingDocument || documentPreview || Object.keys(prefilled).length ? 'status' : undefined,
            style: { ...secondary, margin: 0, overflowWrap: 'anywhere' },
            children: readingDocument ? '正在识别「' + readingDocument + '」…' : documentPreview || Object.keys(prefilled).length
              ? prefilledText : 'PDF 或图片，单份不超过 8 MB。',
          }),
        ] }),
        buildForm({ fields: bankCard ? fields : fields.map(field => ({ ...field, required: false })), values: documentValues,
          change, saving, label: confirm,
          secondaryAction: bankCard ? button('稍后补账户资料', () => void submit({ choice: 'skip' }), saving) : undefined,
          onSubmit: input => {
            if (bankCard) saveFields(fields, input)
            else void submit({ values: Object.fromEntries(
              fields.filter(({ key }) => typeof input[key] === 'string' && input[key].trim()).map(({ key }) => [key, input[key]]),
            ) })
          },
        }),
      ]
    } else if (documentCard) {
      body = jsx('div', { style: actions, children: button('继续建档', () => void sendReply('请按最新资料继续建档。'), saving) })
    } else if (card.kind === 'region') {
      const options = values => values.map(value => ({ value, label: value }))
      const fields = [
        { key: 'province', label: '省份', type: 'select', options: options(Object.keys(taxRegionCities)) },
        { key: 'city', label: '城市或地区', type: 'select', options: options(taxRegionCities[values.province] ?? []) },
      ]
      body = buildForm({ fields, values, change, saving, label: '确认地区并继续', onSubmit: input => saveFields(fields, input) })
    } else if (card.kind === 'tax-scan') {
      body = jsx(TaxStep, {
        sessionId, card, enterprise: status.view?.enterprise,
        onConfirm: async () => finishCard(await onboardingRequest(sessionId, 'card-status', { cardId })),
      })
    } else if (card.kind === 'blocked') {
      body = card.locked ? null : jsx('div', { style: actions, children: button('重新核对资料', () => void submit({ choice: 'edit' }), saving) })
    } else if (card.kind === 'confirm') {
      const replacesSample = card.replacesSampleBook ?? status.view?.replacesSampleBook
      body = [
        replacesSample ? jsx('label', {
          style: { display: 'block', marginTop: 8 }, children: [
            jsx('input', { type: 'checkbox', checked: Boolean(values.replaceSampleBook), disabled: saving,
              onChange: event => change('replaceSampleBook', event.target.checked) }),
            ' 同意替换演示用的样本账本',
          ],
        }) : null,
        jsx('div', { style: footerActions, children: [
          button('查看建档表单', () => void openDraft()),
          button('确认建档', () => void submit({ choice: 'confirm', replaceSampleBook: Boolean(values.replaceSampleBook) }),
            saving || Boolean(replacesSample && !values.replaceSampleBook), 'button', true),
        ] }),
        jsx('details', { style: { marginTop: 14, borderTop: controlBorder, paddingTop: 10 }, children: [
          jsx('summary', { style: { ...secondary, cursor: 'pointer', paddingBlock: 4, width: 'fit-content' }, children: '更正资料' }),
          buildForm({
            fields: [{ key: 'correction', label: '要更正的资料', type: 'select', options: corrections }],
            values, change, saving, label: '更正选中资料', onSubmit: input => void submit({ choice: input.correction }),
          }),
        ] }),
      ]
    } else {
      const fields = card.fields
      const formValues = { ...prefilled, ...values }
      body = buildForm({
        fields, values: formValues, change, saving, onSubmit: input => saveFields(fields, input),
        ...(card.maintenance || card.correction ? {
          label: fields[0]?.key === 'accountChoice' ? '确认账户' : '保存更正',
        } : {}),
      })
    }

    return jsx('section', {
      'aria-label': title, 'data-qianlai-onboarding-card': cardId,
      style: receipt ? receiptStyle : {
        ...cardStyle,
        ...(card.kind === 'confirm' ? { borderBlockStart: '3px solid ' + accent } : {}),
        ...(documentForm && dropActive ? { outline: '2px solid ' + accent, outlineOffset: 2, background: tintedSurface } : {}),
      },
      ...(documentForm ? {
        onPaste: pasteDocument,
        onDragEnter: event => handleDocumentDrag(event, 'enter'),
        onDragOver: event => handleDocumentDrag(event, 'over'),
        onDragLeave: event => handleDocumentDrag(event, 'leave'),
        onDrop: event => handleDocumentDrag(event, 'drop'),
      } : {}),
      children: [
        jsx('h3', { style: receipt ? { ...cardHeading, ...secondary } : cardHeading, children: title }),
        card.message ? jsx('p', {
          role: card.recheck || card.locked ? 'status' : undefined,
          style: card.recheck || card.locked
            ? { ...secondary, margin: '10px 0 0', padding: '8px 10px', borderRadius: 8, background: tintedSurface }
            : secondary,
          children: card.message,
        }) : null, body,
        error ? jsx('p', { role: 'alert', style: { ...secondary, margin: '12px 0 0', padding: '8px 10px',
          borderInlineStart: '2px solid currentColor', color: 'var(--dsw-alias-label-danger, #ad3939)',
          background: 'color-mix(in srgb, var(--dsw-alias-label-danger, #ad3939) 6%, transparent)' }, children: error }) : null,
      ],
    }, cardId)
  }

  function ZhangjieOnboardingCard({ node, sessionId, useSessions }) {
    if (usePreset(sessionId, useSessions) !== 'moneycome-zhangjie' || !node.data) return null
    return jsx(Card, { card: node.data, sessionId }, sessionId + ':' + node.data.id)
  }

  ctx.inject(['uiConversation'], scope => {
    scope.effect(() => scope.uiConversation.events.register(definition()), 'dsh-qianlai: onboarding chat card')
  })
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register({ name: 'conversation.chat.node', key: kind }, ZhangjieOnboardingCard),
  )
}
