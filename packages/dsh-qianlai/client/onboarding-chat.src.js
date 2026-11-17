/* global FormData, setInterval, clearInterval */

export function registerOnboardingChat(ctx, {
  jsx, useEffect, useRef, useState, usePreset,
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
  const cardStyle = {
    border: controlBorder, borderRadius: 14, padding: '16px 18px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'color-mix(in srgb, var(--dsw-specific-bubble, #edf8f1) 34%, transparent)',
    boxSizing: 'border-box', width: 'min(100%, 38rem)', marginBlock: 10,
  }
  const controlStyle = {
    border: controlBorder, borderRadius: 8, padding: '8px 12px', minHeight: 38,
    font: 'inherit', color: 'inherit', boxSizing: 'border-box',
  }
  const secondary = { color: 'var(--dsw-alias-label-secondary)', fontSize: '0.875em', lineHeight: 1.55 }
  const actions = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }
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
      return result?.accepted === true ? validCard(result.card) : undefined
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
      start: (_context, { location }, reader) => {
        const turn = location.turn
        const previous = reader?.previous(kind)?.state
        if (turn === undefined || previous?.turn !== turn) return { turn, earlierCardIds: [] }
        const { earlierCardIds, card } = previous
        // Distinct tool calls can return the same active card. DSH replays this
        // dependency when an earlier call's result arrives or history is paged in.
        return {
          turn,
          earlierCardIds: card && !earlierCardIds.includes(card.id) ? [...earlierCardIds, card.id] : earlierCardIds,
        }
      },
      update: ({ state }, { event }) => {
        const card = cardOf(event)
        return card ? { ...state, card, anchorSeq: event.seq } : state
      },
      buildViewNode: ({ key, id, state, start }) => state?.card ? {
        key, id, kind, target: 'chat', anchorSeq: state.anchorSeq,
        location: start.location, groupTree: 'turn',
        // A materialized node can become a duplicate on replay and must keep its key.
        visibility: state.earlierCardIds?.includes(state.card.id) ? 'hidden' : 'visible',
        data: state.card,
      } : null,
    }
  }

  function button(label, onClick, disabled = false, type = 'button', primary = false) {
    return jsx('button', {
      type, disabled, onClick,
      style: {
        ...controlStyle,
        ...(primary ? {
          background: 'color-mix(in srgb, ' + accent + ' 16%, transparent)',
          borderColor: 'color-mix(in srgb, ' + accent + ' 58%, transparent)', fontWeight: 600,
        } : { background: 'transparent' }),
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
    return documentKind === 'tax' ? '税务资料' : '营业执照'
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
        const labels = card.fields.filter(field => Object.hasOwn(input.values ?? {}, field.key) &&
          input.values[field.key]?.length).map(field => field.label)
        return labels.length ? '我已填写' + labels.join('、') + '，请继续建档。' : '资料已填写，请继续建档。'
      }
    }
  }

  function form({ fields, values, change, saving, onSubmit, label = '保存到草稿' }) {
    const inputStyle = {
      ...controlStyle,
      background: 'var(--dsw-alias-fill-primary, transparent)',
      width: '100%',
      minWidth: 0,
    }
    return jsx('form', {
      style: { display: 'grid', gridTemplateColumns: formColumns, gap: '12px 16px', marginTop: 12 },
      onSubmit: event => {
        event.preventDefault()
        if (!event.currentTarget) { onSubmit(values); return }
        const formValues = new FormData(event.currentTarget)
        onSubmit(Object.fromEntries(fields.map(({ key, type }) => [
          key, type === 'multi' ? formValues.getAll(key) : formValues.get(key),
        ])))
      },
      children: [...fields.map(field => {
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
        const input = {
          name: field.key, required: field.required !== false, disabled: saving, value: values[field.key] ?? '',
          onChange: event => change(field.key, event.target.value),
          style: inputStyle,
        }
        return jsx('label', {
          style: { display: 'grid', alignContent: 'start', gap: 5, minWidth: 0,
            ...(['companyName', 'taxAuthority'].includes(field.key) ? { gridColumn: '1 / -1' } : {}) }, children: [
            field.label,
            field.type === 'select'
              ? jsx('select', { ...input, disabled: saving || !field.options.length, children: [
                jsx('option', { value: '', children: '请选择' }),
                ...field.options.map(({ value, label }) => jsx('option', { value, children: label }, value)),
              ] })
              : jsx('input', { ...input, type: field.type, maxLength: field.maxLength }),
          ],
        }, field.key)
      }), jsx('div', { style: { ...actions, gridColumn: '1 / -1', marginTop: 0 }, children: button(label, undefined, saving, 'submit', true) })],
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
      jsx('div', { style: actions, children: [
        phase === 'idle' || phase === 'failed'
          ? button('重新打开扫码页', () => void request('start')) : null,
        phase === 'ready' ? button('核对无误，回填税务资料', () => void request('submit')) : null,
        active || phase === 'ready' ? button('取消扫码', () => void request('cancel')) : null,
        phase === 'waiting' && flow.retryRead ? button('重试读取', () => void request('read')) : null,
        phase === 'submitted' && error ? button('继续建档', () => void request('status')) : null,
      ] }),
    ]
  }

  function Card({ sessionId, card }) {
    const [values, setValues] = useState({})
    const [status, setStatus] = useState(null)
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
    const { id: cardId, draftId, revision } = card
    const viewOnly = card.kind === 'fields' && card.fields.length === 0
    function applyStatus(result) {
      setStatus(result)
      if (result.view) refreshOnboarding(sessionId, result.view)
    }
    useEffect(() => {
      let active = true
      void onboardingRequest(sessionId, 'card-status', { cardId }).then(result => {
        if (!active) return
        applyStatus(result)
      }, error => {
        if (active) setError(shownError(error, '建档卡片暂时无法加载。'))
      })
      return () => { active = false }
    }, [sessionId, cardId, statusAttempt])
    useEffect(() => {
      return subscribeOnboarding?.((source, { view }) => {
        if (source === sessionId && view?.draftId === draftId && view.revision > revision) setObsolete(true)
      })
    }, [sessionId, draftId, revision])

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
      if (!result.receipt) throw Error('未能确认资料已保存，请重试。')
      setValues({})
      if (card.kind === 'mode') void openDraft({ mode: result.receipt.mode ?? input.mode, view: result.view })
      await sendReply(replyFor(card, input, result))
    }

    async function submit(input) {
      if (submitting.current || !status || status.receipt || status.stale || obsolete) return
      submitting.current = true
      setError('')
      setSaving(true)
      try {
        const payload = { cardId, draftId, revision, ...input }
        const result = await onboardingRequest(sessionId, 'submit-card', payload)
        await finishCard(result, payload)
      } catch (error) {
        setError(shownError(error, '建档资料暂时无法保存，请重试。'))
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
      setReadingDocument(file.name.slice(0, 120))
      try {
        if (!file.size || file.size > 8 * 1024 * 1024) throw Error('请选择不超过 8 MB 的 PDF 或图片。')
        const result = await onboardingRequest(sessionId, 'recognize', {
          cardId, draftId, revision,
          file: { name: file.name, mimeType: file.type, base64: await readOnboardingFile(file) },
        })
        const current = { ...card.initialValues, ...values }
        const held = card.fields.filter(({ key }) => current[key]?.trim() &&
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

    function handleDocumentDrag(event, drop = false) {
      if (!event.dataTransfer?.types?.includes('Files') && !event.dataTransfer?.files?.length) return
      event.preventDefault()
      event.stopPropagation()
      if (drop) {
        setDropActive(false)
        const files = event.dataTransfer.files
        if (files.length === 1) void loadDocument(files[0])
        else if (files.length > 1) setError('一次只能识别一份资料。请选择其中一份。')
        return
      }
      event.dataTransfer.dropEffect = saving ? 'none' : 'copy'
      if (!saving) setDropActive(true)
    }

    function change(key, value) {
      setValues(previous => ({ ...previous, [key]: value, ...(key === 'province' ? { city: '' } : {}) }))
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
    const documentForm = card.kind === 'document' && status && !status.stale && !receipt && !obsolete
    const choices = {
      mode: Object.entries(modes).map(([mode, label]) => button(label, () => void submit({ mode }), saving, 'button', mode === 'scan')),
      'bank-next': [
        button('再添加一个账户', () => void submit({ choice: 'add' }), saving),
        button('继续', () => void submit({ choice: 'continue' }), saving),
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
        pendingReply ? jsx('div', { style: actions, children: button('重试发送到对话', () => void sendReply(pendingReply), saving) }) : null,
      ]
    } else if (status?.stale || obsolete) {
      body = [
        jsx('p', { style: { ...secondary, margin: '7px 0 0' }, children: '建档资料已更新，可以按最新进度继续。' }),
        jsx('div', { style: actions, children: button('继续建档', () => void sendReply('请按最新资料继续建档。'), saving) }),
      ]
    } else if (!status) {
      body = error ? jsx('div', { style: actions, children: button('重试加载', () => {
        setError('')
        setStatusAttempt(previous => previous + 1)
      }) }) : jsx('p', { role: 'status', style: { ...secondary, margin: '7px 0 0' }, children: '正在加载建档进度…' })
    } else if (Object.hasOwn(choices, card.kind)) {
      body = jsx('div', { style: actions, children: choices[card.kind] })
    } else if (documentForm) {
      const label = '选择' + sourceText(card.documentKind)
      const confirm = wantsTax ? '确认税务资料' : '确认公司资料'
      const prefilledText = documentPreview?.held.length
        ? '保留了原先填写的' + documentPreview.held.join('、') + '。请对照资料核对后确认。'
        : '请核对预填内容，补齐缺项后确认。'
      body = [
        jsx('div', { style: { ...actions, padding: '10px 12px', border: '1px dashed color-mix(in srgb, currentColor 24%, transparent)', borderRadius: 8 }, children: [
          button(label, () => documentInput.current?.click(), saving),
          jsx('span', { style: secondary, children: '也可拖一份文件到此卡片，或直接填写。' }),
          jsx('input', {
            ref: documentInput, type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp',
            hidden: true, disabled: saving, onChange: selectDocument,
          }),
        ] }),
        jsx('p', {
          role: readingDocument || documentPreview || Object.keys(prefilled).length ? 'status' : undefined,
          style: { ...secondary, margin: '8px 0 0', overflowWrap: 'anywhere' },
          children: readingDocument ? '正在识别「' + readingDocument + '」…' : documentPreview || Object.keys(prefilled).length
            ? prefilledText : 'PDF 或图片，单份不超过 8 MB。',
        }),
        form({ fields: card.fields.map(field => ({ ...field, required: false })), values: { ...documentPreview?.fields, ...prefilled, ...values },
          change, saving, label: confirm, onSubmit: input => void submit({ values: Object.fromEntries(
            card.fields.filter(({ key }) => typeof input[key] === 'string' && input[key].trim()).map(({ key }) => [key, input[key]]),
          ) }) }),
      ]
    } else if (documentCard) {
      body = jsx('div', { style: actions, children: button('继续建档', () => void sendReply('请按最新资料继续建档。'), saving) })
    } else if (card.kind === 'region') {
      const options = values => values.map(value => ({ value, label: value }))
      const fields = [
        { key: 'province', label: '省份', type: 'select', options: options(Object.keys(taxRegionCities)) },
        { key: 'city', label: '城市或地区', type: 'select', options: options(taxRegionCities[values.province] ?? []) },
      ]
      body = form({ fields, values, change, saving, label: '确认地区并继续', onSubmit: input => saveFields(fields, input) })
    } else if (card.kind === 'tax-scan') {
      body = jsx(TaxStep, {
        sessionId, card, enterprise: status.view?.enterprise,
        onConfirm: async () => finishCard(await onboardingRequest(sessionId, 'card-status', { cardId })),
      })
    } else if (card.kind === 'blocked') {
      body = jsx('div', { style: actions, children: button('重新核对资料', () => void submit({ choice: 'edit' }), saving) })
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
        jsx('div', { style: actions, children: [
          button('查看建档表单', () => void openDraft()),
          button('确认建档', () => void submit({ choice: 'confirm', replaceSampleBook: Boolean(values.replaceSampleBook) }),
            saving || Boolean(replacesSample && !values.replaceSampleBook)),
        ] }),
        jsx('details', { style: { marginTop: 10 }, children: [
          jsx('summary', { children: '更正资料' }),
          form({
            fields: [{ key: 'correction', label: '要更正的资料', type: 'select', options: corrections }],
            values, change, saving, label: '更正选中资料', onSubmit: input => void submit({ choice: input.correction }),
          }),
        ] }),
      ]
    } else {
      const fields = card.kind === 'bank' ? bankFields : card.fields
      const formValues = card.kind === 'bank'
        ? { currency: 'CNY', holder: status.view?.enterprise?.companyName ?? '', ...prefilled, ...values }
        : { ...prefilled, ...values }
      body = [
        form({ fields, values: formValues, change, saving, onSubmit: input => saveFields(fields, input) }),
        card.kind === 'bank' ? jsx('div', { style: actions,
          children: button('稍后补账户资料', () => void submit({ choice: 'skip' }), saving) }) : null,
      ]
    }

    return jsx('section', {
      'aria-label': title, 'data-qianlai-onboarding-card': cardId,
      style: documentForm && dropActive ? { ...cardStyle, outline: '2px solid ' + accent, outlineOffset: 2 } : cardStyle,
      ...(documentForm ? {
        onDragOver: handleDocumentDrag,
        onDragLeave: () => setDropActive(false),
        onDrop: event => handleDocumentDrag(event, true),
      } : {}),
      children: [
        jsx('h3', { style: { fontSize: '1em', lineHeight: 1.45, fontWeight: 650, margin: 0 }, children: title }),
        card.message ? jsx('p', { style: secondary, children: card.message }) : null, body,
        error ? jsx('p', { role: 'alert', style: { margin: '8px 0 0' }, children: error }) : null,
      ],
    }, cardId)
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
