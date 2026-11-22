/* global window, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, registerOnboardingChat, onboardingFieldError, createOnboardingDateInput */
/* global registerCompanyReportChat */
/**
 * 张姐会话的界面插件（浏览器端）。
 *
 * 当前会话的模式是「钱来张姐」时：
 * - 会话头部加一个张姐头像和微信连接入口；新会话页也可以直接扫码接入。
 * - 旧版 DSH 的对话补充已经提交的选择卡问答。
 * - 通过 DSH 主题服务的 `overrideTokens` 叠一层钱来配色：DeepSeek 蓝色色阶换成钱来绿，侧栏换浅绿灰底。
 *   离开张姐会话、切回别的模式，这层配色撤掉，DSH 恢复原样；用户的明暗偏好不动。
 * 其他模式的会话什么都不渲染。
 *
 * 这个文件按 DSH 浏览器模块的格式手写（`window.__ModuleLoader__.load`），不经打包工具。
 * 构建时 `scripts/build-client.mjs` 把头像图片内联进来，产物是 `lib/client.js`。
 * 头像 © 钱来，保留所有权利，仅随本插件展示使用，见 `assets/zhangjie/NOTICE.md`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qianlai',
  factory: (require) => {
    const module = { exports: {} }
    const { useEffect, useId, useRef, useState } = require('react')
    const { jsx } = require('react/jsx-runtime')

    const PRESET = 'moneycome-zhangjie'
    const QUESTION_HISTORY = 'moneycome-question-history'
    const TAX_REGION_CITIES = /* tax-region-catalogue */ {}
    const TAX_FIELDS = /* tax-fields */ []
    const TAX_SCAN_CITIES = /* tax-scan-cities */ {}
    const AVATAR = '__AVATAR_DATA_URL__'
    const buttonStyle = { font: 'inherit', fontSize: 14, border: '1px solid #c4eacf', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', background: '#edf8f1', color: '#1b6f4a' }
    let connection
    let sessions

    function WechatPanel({ sessionId }) {
      const titleId = useId()
      const [open, setOpen] = useState(false)
      const [disconnecting, setDisconnecting] = useState(false)
      const [state, setState] = useState({ status: 'disconnected' })
      const latestState = useRef(state)
      latestState.current = state
      const statusFailures = useRef(0)
      const dialog = useRef(null)
      const control = useRef(null)
      const sequence = useRef(0)
      const labels = { disconnected: '微信尚未连接', loading: '正在获取二维码…', waiting: '等待微信扫码', scanned: '已扫码，请在微信确认', connected: '微信已连接', expired: '二维码已过期', error: '连接未完成' }
      const buttonLabels = { disconnected: '连接微信', loading: '正在连接微信…', waiting: '等待微信扫码', scanned: '已扫码，待确认', connected: '微信已连接', expired: '重新连接微信', error: '微信连接异常，点击查看' }
      const request = async action => {
        if (action === 'status' && control.current) return
        const version = ++sequence.current
        control.current?.abort()
        const abort = new AbortController()
        control.current = abort
        const timer = setTimeout(() => abort.abort(), 15000)
        try {
          if (!connection) throw Error('微信接入服务尚未就绪，请稍后重试。')
          const result = await connection.rpc.call('/api', 'qianlai/wechat', { action, ...(sessionId ? { sessionId } : {}) }, abort.signal)
          if (version !== sequence.current || abort.signal.aborted) return
          if (!result.ok) throw Error(result.error.message)
          if (action === 'status') statusFailures.current = 0
          setState(result.value)
          return result.value
        } catch (error) {
          if (version === sequence.current) {
            if (action === 'status' && latestState.current.status === 'connected' && ++statusFailures.current < 3) return
            const previous = action === 'disconnect' ? latestState.current : { status: 'error' }
            setState({ ...previous, message: error.message || '请求失败，请重试。' })
          }
        } finally { clearTimeout(timer); if (version === sequence.current) control.current = null }
      }
      const disconnect = async () => {
        setDisconnecting(true)
        try {
          const result = await request('disconnect')
          if (result?.status === 'disconnected') setOpen(false)
        } finally { setDisconnecting(false) }
      }
      useEffect(() => {
        if (open) dialog.current?.showModal()
        // Viewing the existing binding must not start a desktop handoff.
        void request('status').then(result => {
          if (open && result && !result.canDisconnect && ['disconnected', 'expired', 'error'].includes(result.status))
            void request('start')
        })
        const timer = setInterval(() => void request('status'), 2000)
        return () => { clearInterval(timer); sequence.current++; control.current?.abort(); control.current = null }
      }, [open, sessionId])
      const canDisconnect = state.status === 'connected' || state.canDisconnect
      return jsx('span', { children: [
        jsx('button', { type: 'button', onClick: () => setOpen(true), style: { border: '1px solid #c4eacf', borderRadius: 8, padding: '5px 10px', color: '#1b6f4a', background: '#edf8f1', cursor: 'pointer' }, children: buttonLabels[state.status] || '连接微信' }),
        open ? jsx('dialog', { ref: dialog, 'aria-labelledby': titleId, onCancel: () => setOpen(false), style: { border: '1px solid #c4eacf', borderRadius: 16, padding: 24, width: 'min(420px, calc(100vw - 48px))', color: '#24433a', background: '#fff' }, children: [
          jsx('h2', { id: titleId, style: { margin: '0 0 12px', fontSize: 20 }, children: '把张姐接到微信' }),
          jsx('p', { children: '用本人微信扫码后，可以发票据、查账，并继续这台电脑上的财务事项。' }),
          jsx('p', { role: 'status', 'aria-live': 'polite', children: labels[state.status] || state.status }),
          state.qrDataUrl ? jsx('img', { src: state.qrDataUrl, alt: '当前微信登录二维码', style: { display: 'block', width: '100%', maxWidth: 300, margin: '0 auto' } }) : null,
          state.message ? jsx('p', { style: { fontSize: 14, lineHeight: 1.6 }, children: state.message }) : null,
          jsx('div', { style: { display: 'flex', gap: 12, marginTop: 16 }, children: [
            canDisconnect
              ? jsx('button', { type: 'button', style: buttonStyle, disabled: disconnecting, onClick: () => void disconnect(), children: disconnecting ? '正在断开…' : '断开连接' })
              : jsx('button', { type: 'button', style: buttonStyle, disabled: state.status === 'loading', onClick: () => void request(state.status === 'disconnected' ? 'start' : 'refresh'), children: state.status === 'disconnected' ? '获取二维码' : '刷新二维码' }),
            jsx('button', { type: 'button', style: { ...buttonStyle, background: '#fff', color: '#24433a' }, onClick: () => setOpen(false), children: '关闭' }),
          ] }),
        ] }) : null,
      ] })
    }


    const ONBOARDING_TAB = 'moneycome-onboarding'
    let sidebarRight
    const onboardingListeners = new Set()
    const onboardingTaxPreviews = new Map()
    const steps = ['企业信息', '记账准备', '工资社保', '确认建档']
    const taxpayerTypes = { 'small-scale': '小规模纳税人', general: '一般纳税人', unknown: '待核实' }
    const businessTypes = { goods: '买卖商品或有库存', production: '生产或加工', 'cross-border': '有境外往来或外币收付款', 'multiple-entities': '有多个经营主体', none: '以上都没有' }
    const bankStates = { provided: '有银行账户', none: '没有银行账户', pending: '账户资料待补' }
    const histories = { previous: '已有旧账', unrecorded: '成立后未记账', new: '刚成立' }
    const payrollStates = { scheduled: '定期发工资', none: '暂时不发工资' }
    const socialStates = { all: '所有人都交', partial: '部分人交', none: '都没交', unknown: '待核实' }
    const currencies = { CNY: '人民币 (CNY)', USD: '美元 (USD)', HKD: '港元 (HKD)', EUR: '欧元 (EUR)', JPY: '日元 (JPY)', GBP: '英镑 (GBP)', SGD: '新加坡元 (SGD)', AUD: '澳元 (AUD)', CAD: '加拿大元 (CAD)' }
    const readoutGrid = {
      display: 'grid', gap: '8px 16px', margin: 0,
      gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, max(11rem, 45%)), 1fr))',
    }
    const muted = 'var(--dsw-alias-label-secondary, #616b65)'
    const readoutBorder = '1px solid color-mix(in srgb, currentColor 14%, transparent)'
    const panelAccent = 'var(--dsw-static-deepseek-600, #1b6f4a)'
    const panelSectionStyle = {
      border: readoutBorder, borderRadius: 12, margin: '0 0 12px', padding: '14px clamp(10px, 4%, 18px)', minWidth: 0,
      background: 'color-mix(in srgb, ' + panelAccent + ' 2%, var(--dsw-alias-fill-primary, transparent))',
    }
    const panelSectionHeading = { margin: '0 0 12px', fontSize: 14, fontWeight: 680 }
    const panelAction = {
      background: 'var(--dsw-alias-fill-primary, transparent)', color: 'inherit', border: readoutBorder, borderRadius: 9,
      minHeight: 36, padding: '6px 12px', font: 'inherit', fontWeight: 520, cursor: 'pointer',
    }
    const panelInput = {
      background: 'var(--dsw-alias-fill-primary, transparent)', color: 'inherit', border: readoutBorder,
      borderRadius: 9, width: '100%', boxSizing: 'border-box', minWidth: 0, minHeight: 38,
      padding: '6px 10px', font: 'inherit',
    }
    const sectionLabels = {
      company: '公司资料', tax: '税务资料', bank: '银行账户', accounting: '记账准备', payroll: '工资社保',
    }
    const paydays = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [index + 1, (index + 1) + ' 日']))
    const blankAccount = () => ({ holder: '', number: '', bank: '', currency: 'CNY', openedOn: '' })

    function refreshOnboarding(sessionId, view) {
      if (!view) return
      const preview = onboardingTaxPreviews.get(sessionId)
      if (preview && (view.completed || view.mode === 'manual' || (preview.draftId && preview.draftId !== view.draftId))) {
        onboardingTaxPreviews.delete(sessionId)
      }
      for (const update of onboardingListeners) update(sessionId, { view })
    }

    function subscribeOnboarding(listener) {
      onboardingListeners.add(listener)
      return () => onboardingListeners.delete(listener)
    }

    function previewOnboardingTax(sessionId, profile, draftId) {
      if (profile) onboardingTaxPreviews.set(sessionId, { profile, draftId })
      else onboardingTaxPreviews.delete(sessionId)
      for (const update of onboardingListeners) update(sessionId, {})
    }

    function openOnboarding(sessionId, { view } = {}) {
      refreshOnboarding(sessionId, view)
      const target = sidebarRight?.commandTarget(null)
      if (!target || target.sessionId !== sessionId) return false
      if (sidebarRight.isExpanded() && sidebarRight.active()?.kind === ONBOARDING_TAB) return true
      sidebarRight.openTabFromTarget(ONBOARDING_TAB, target)
      return true
    }

    function watchOnboardingStart(sessionId) {
      const source = sessions?.binding(sessionId)?.eventSource
      if (!source) return
      let revision = source.getSnapshot().revision
      const starts = new Set()
      return source.subscribe(() => {
        const next = source.getSnapshot()
        if (next.revision === revision) return
        const incremental = next.revision === revision + 1
        revision = next.revision
        // Loading conversation history must not reopen a manually closed panel.
        if (!incremental || next.change.kind === 'replace') starts.clear()
        if (!incremental || next.change.kind !== 'append') return
        for (const { event } of next.change.entries) {
          if (event.type === 'turn/end') starts.clear()
          if (event.type === 'tool/call' && event.data.name === 'moneycome_onboarding'
            && parseJson(event.data.arguments)?.action === 'start') {
            starts.add(event.data.callId)
          }
          if (event.type !== 'tool/result' || !starts.delete(event.data.message?.source?.callId)) continue
          const result = parseJson(toolResultText(event))
          if (result?.accepted === true && result.card) openOnboarding(sessionId)
        }
      })
    }

    function sendOnboardingReply(sessionId, text) {
      const conversation = sessions?.scope(sessionId)?.get('conversation')
      if (!conversation) throw Error('当前对话暂时无法发送消息。')
      return conversation.send(text)
    }

    async function onboardingRequest(sessionId, action, extra = {}, signal = AbortSignal.timeout(action === 'recognize' ? 120000 : 10000)) {
      if (!connection) throw Error('建档服务还没就绪，请稍后重试。')
      const result = await connection.rpc.call('/api', 'qianlai/company-onboarding', { action, sessionId, ...extra }, signal)
      if (!result.ok) throw Error(result.error.message)
      if (result.value?.accepted !== true) throw Object.assign(Error(result.value?.message || '建档操作未完成，请重试。'), {
        code: result.value?.code, details: result.value?.details,
      })
      return result.value
    }

    function readOnboardingFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new window.FileReader()
        reader.onload = () => resolve(String(reader.result).split(',', 2)[1])
        reader.onerror = () => reject(Error('未能读取这份文件。'))
        reader.onabort = () => reject(Error('文件读取已取消。'))
        reader.readAsDataURL(file)
      })
    }

    async function taxRequest(action, id, sessionId, draftId, extra = {}, signal = AbortSignal.timeout(10000)) {
      if (!connection) throw Error('建档服务还没就绪，请稍后重试。')
      const result = await connection.rpc.call('/api', 'qianlai/tax-onboarding', { action, id, sessionId, draftId, ...extra }, signal)
      if (!result.ok) throw Error(result.error.message)
      return result.value
    }

    function readoutRow(label, value) {
      return jsx('div', { children: [
        jsx('dt', { style: { color: muted, fontSize: 12 }, children: label }),
        jsx('dd', { style: { margin: '2px 0 0', overflowWrap: 'anywhere' }, children: value || '待补' }),
      ] }, label)
    }

    function readoutGroup(title, rows) {
      return jsx('section', { style: panelSectionStyle, children: [
        jsx('h3', { style: panelSectionHeading, children: title }),
        jsx('dl', { style: readoutGrid, children: rows }),
      ] })
    }

    function sectionValues(view, section) {
      const { enterprise, accounting, payroll } = view
      const accountValues = account => ({ ...blankAccount(), ...account, number: '' })
      switch (section) {
        case 'company':
          return { companyName: enterprise?.companyName ?? '', taxId: enterprise?.taxId ?? '',
            establishedOn: enterprise?.establishedOn ?? '', business: enterprise?.business ?? [] }
        case 'tax':
          return Object.fromEntries(TAX_FIELDS.map(({ key }) => [key,
            key === 'taxpayerIdentity' && enterprise?.[key] === 'unknown' ? '' : enterprise?.[key] ?? '']))
        case 'bank':
          return { bankStatus: enterprise?.bankStatus ?? '', accounts: (enterprise?.accounts ?? []).map(accountValues) }
        case 'accounting':
          return { history: accounting?.history ?? '', lastMonth: accounting?.lastMonth ?? '', startMonth: accounting?.startMonth ?? '' }
        case 'payroll':
          return { payroll: payroll?.payroll ?? '', payday: payroll?.payday ?? '', social: payroll?.social ?? '' }
        default:
          return {}
      }
    }

    const sameDraftValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)

    function serializeSectionPatch(changed) {
      if (!changed.accounts) return changed
      return { ...changed, accounts: changed.accounts.map(({ id, holder, bank, currency, openedOn, number }) => ({
        ...(id ? { id } : {}), holder, bank, currency, openedOn, ...(number ? { number } : {}),
      })) }
    }

    function OnboardingEditor({ sessionId, view, section }) {
      const errorPrefix = useId()
      const [edits, setEdits] = useState({})
      const [error, setError] = useState('')
      const [reviewed, setReviewed] = useState({})
      const [serverIssue, setServerIssue] = useState(null)
      const [notice, setNotice] = useState('')
      const [saving, setSaving] = useState(false)
      const pendingSave = useRef(false)
      const officialTax = view.enterprise?.officialTax
      const current = sectionValues(view, section)
      const changed = Object.entries(edits).filter(([key, edit]) => !sameDraftValue(current[key], edit.value))
      const patch = Object.fromEntries(changed.map(([key, { value }]) => [key, value]))
      const input = { ...current, ...patch }
      const conflicts = new Set(changed.filter(([key, edit]) => !sameDraftValue(current[key], edit.initial)).map(([key]) => key))
      const title = sectionLabels[section]

      function inputErrors() {
        const candidates = {}
        if (section === 'bank' && input.bankStatus === 'provided') {
          for (const [index, account] of input.accounts.entries()) {
            for (const key of ['holder', 'bank', 'number', 'currency', 'openedOn']) {
              const message = onboardingFieldError(key, account[key], { savedNumber: Boolean(account.id && account.maskedNumber) })
              if (message) candidates['account-' + index + '-' + key] = message
            }
          }
        } else {
          for (const key of ['taxId', 'establishedOn', 'startMonth']) {
            const message = onboardingFieldError(key, input[key], {
              lastMonth: input.history === 'previous' ? input.lastMonth : undefined,
            })
            if (message) candidates[key] = message
          }
        }
        return candidates
      }

      const errors = inputErrors()

      function change(key, value) {
        const changes = typeof key === 'string' ? { [key]: value } : key
        setError('')
        setServerIssue(null)
        setNotice('')
        setEdits(previous => {
          const next = { ...previous }
          for (const [name, proposed] of Object.entries(changes)) {
            if (sameDraftValue(current[name], proposed)) delete next[name]
            else next[name] = { value: proposed, initial: previous[name]?.initial ?? current[name] }
          }
          return next
        })
      }

      async function save(form) {
        if (pendingSave.current || !changed.length) return
        if (section === 'tax') {
          const detail = TAX_FIELDS.find(field => field.requiredWhen && input[field.requiredWhen] === '其他' && !input[field.key]?.trim())
          if (detail) {
            setError('请填写' + detail.label + '。')
            form?.elements.namedItem(detail.key)?.focus()
            return
          }
        }
        const invalid = Object.keys(errors).filter(key => !key.startsWith('account-') || Object.hasOwn(patch, 'accounts'))
        if (invalid.length) {
          setReviewed(previous => ({ ...previous, ...Object.fromEntries(invalid.map(key => [key, true])) }))
          form?.elements.namedItem(invalid[0])?.focus()
          return
        }
        pendingSave.current = true
        setSaving(true)
        setError('')
        setServerIssue(null)
        setNotice('')
        try {
          const draft = await onboardingRequest(sessionId, 'edit-section', {
            draftId: view.draftId, revision: view.revision, section, input: serializeSectionPatch(patch),
          })
          onboardingTaxPreviews.delete(sessionId)
          refreshOnboarding(sessionId, draft)
          setEdits({})
          setNotice('已保存到建档草稿')
        } catch (error) {
          const { field, index } = error.details ?? {}
          if (section === 'bank' && Number.isInteger(index) && ['holder', 'number', 'bank', 'currency', 'openedOn'].includes(field)) {
            const name = 'account-' + index + '-' + field
            setServerIssue({ name, message: error.message })
            form?.elements.namedItem(name)?.focus()
          } else setError(error.message)
          if (['DRAFT_STALE', 'ONBOARDING_CHANGED'].includes(error.code)) {
            try { refreshOnboarding(sessionId, await onboardingRequest(sessionId, 'status')) } catch { /* Keep the input for retry. */ }
          }
        } finally {
          pendingSave.current = false
          setSaving(false)
        }
      }

      const field = (label, name, options = {}) => {
        const { type = 'text', list, locked, fullWidth, placeholder, maxLength, required = false,
          value = locked ? current[name] : input[name], set = next => change(name, next) } = options
        const fieldError = !locked && ((reviewed[name] && errors[name]) || (serverIssue?.name === name && serverIssue.message))
        const errorId = errorPrefix + '-' + name + '-error'
        const fieldId = errorPrefix + '-' + name
        const isDate = type === 'date' || type === 'month'
        const props = { id: fieldId, name, value: value ?? '', 'aria-required': required || undefined,
          disabled: saving || Boolean(list && !Object.keys(list).length),
          onChange: event => set(event.target.value), onBlur: () => setReviewed(previous => ({ ...previous, [name]: true })),
          'aria-invalid': fieldError ? true : undefined, 'aria-describedby': fieldError ? errorId : undefined,
          style: fieldError ? { ...panelInput, borderColor: 'var(--dsw-alias-label-danger, #ad3939)' } : panelInput }
        return jsx(isDate ? 'div' : 'label', { style: { display: 'grid', alignContent: 'start', gap: 4, minWidth: 0,
          ...(fullWidth ? { gridColumn: '1 / -1' } : {}) }, children: [
          jsx(isDate && !locked ? 'label' : 'span', { htmlFor: isDate && !locked ? fieldId : undefined,
            style: { color: muted, fontSize: 12 }, children: label }),
          locked ? jsx('span', { title: '来自已核对的税务资料', style: { overflowWrap: 'anywhere' }, children: value || '待补' }) : list ? jsx('select', { ...props, children: [
            jsx('option', { value: '', disabled: required, children: placeholder || '请选择' }),
            ...Object.entries(list).map(([key, text]) => jsx('option', { value: key, children: text }, key)),
          ] }) : isDate
            ? jsx(OnboardingDateInput, { ...props, type, label, establishedOn: view.enterprise?.establishedOn,
              lastMonth: input.history === 'previous' ? input.lastMonth : undefined })
            : jsx('input', { ...props, type, placeholder, maxLength, autoComplete: 'off',
              inputMode: name.endsWith('-number') ? 'numeric' : undefined }),
          fieldError ? jsx('span', { id: errorId, role: 'alert', style: { color: 'var(--dsw-alias-label-danger, #ad3939)', fontSize: 12 }, children: fieldError }) : null,
          !locked && conflicts.has(name) ? jsx('span', { style: { color: muted, fontSize: 12, overflowWrap: 'anywhere' },
            children: '草稿当前值 · ' + (list?.[current[name]] || current[name] || '待补') }) : null,
        ] }, name)
      }

      const updateAccount = (index, key, value) =>
        change('accounts', input.accounts.map((account, row) => row === index ? { ...account, [key]: value } : account))
      let fields
      switch (section) {
        case 'company':
          fields = [
            field('企业全称', 'companyName', { maxLength: 200, fullWidth: true, locked: Boolean(officialTax) }),
            field('统一社会信用代码', 'taxId', { maxLength: 18, locked: Boolean(officialTax) }),
            field('成立日期', 'establishedOn', { type: 'date' }),
            jsx('fieldset', { style: { gridColumn: '1 / -1', border: 0, margin: 0, padding: 0, minWidth: 0 }, children: [
              jsx('legend', { style: { color: muted, fontSize: 12, marginBottom: 6 }, children: '实际经营' }),
              jsx('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }, children: Object.entries(businessTypes).map(([key, label]) => jsx('label', {
                style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 },
                children: [jsx('input', {
                  type: 'checkbox', name: 'business', value: key, checked: input.business.includes(key), disabled: saving,
                  onChange: event => {
                    const business = input.business.filter(item => item !== key && item !== 'none')
                    change('business', event.target.checked ? key === 'none' ? ['none'] : [...business, key] : input.business.filter(item => item !== key))
                  },
                }), label],
              }, key)) }),
            ] }),
          ]
          break
        case 'tax': {
          const lockedFields = {
            taxpayerIdentity: officialTax?.taxpayerIdentity && officialTax.taxpayerIdentity !== 'unknown',
            taxAuthority: officialTax?.taxAuthority, taxStatus: officialTax?.taxStatus,
            incomeMethod: officialTax?.incomeMethod, accountingSystem: officialTax?.accountingSystem,
          }
          fields = [
            ...TAX_FIELDS.filter(item => !item.requiredWhen || input[item.requiredWhen] === '其他').map(item => {
              const list = item.options && Object.fromEntries(item.options.map(({ value, label }) => [value, label]))
              const locked = !!lockedFields[item.key]
              return field(item.label, item.key, {
                list, locked, required: true, maxLength: item.maxLength,
                fullWidth: item.key === 'taxAuthority' || Boolean(item.requiredWhen),
                ...(item.requiredWhen ? { placeholder: '请按税务登记资料填写' } : {}),
                ...(locked && list ? { value: list[current[item.key]] ?? current[item.key] } : {}),
              })
            }),
            officialTax ? jsx('dl', { style: { gridColumn: '1 / -1', margin: 0 }, children:
              readoutRow('当前页税费种', summarizeObligations(officialTax.obligations) || '本次未读取到'),
            }) : null,
          ]
          break
        }
        case 'bank':
          fields = [
            field('账户情况', 'bankStatus', { list: bankStates }),
            ...(input.bankStatus === 'provided' ? [
              ...input.accounts.map((account, index) => jsx('fieldset', {
                style: { gridColumn: '1 / -1', border: readoutBorder, borderRadius: 10, margin: 0, padding: '10px 12px', minWidth: 0 },
                children: [
                  jsx('legend', { style: { fontSize: 12, color: muted }, children: account.maskedNumber || '银行账户 ' + (index + 1) }),
                  jsx('div', { style: readoutGrid, children: [
                    ['账户户名', 'holder', { maxLength: 200 }], ['开户行', 'bank', { maxLength: 200 }],
                    ['银行账号', 'number', { maxLength: 48, placeholder: account.maskedNumber ? '留空保留 ' + account.maskedNumber : undefined }],
                    ['币种', 'currency', { maxLength: 3 }], ['开户日期', 'openedOn', { type: 'date' }],
                  ].map(([label, key, options]) => field(label, 'account-' + index + '-' + key,
                    { ...options, value: account[key], set: value => updateAccount(index, key, value) })) }),
                  jsx('button', { type: 'button', style: { ...panelAction, marginTop: 8 }, disabled: saving,
                    onClick: () => change('accounts', input.accounts.filter((_, row) => row !== index)), children: '移除账户' }),
                ],
              }, account.id ?? index)),
              jsx('div', { style: { gridColumn: '1 / -1' }, children: jsx('button', {
                type: 'button', style: panelAction, disabled: saving || input.accounts.length >= 20,
                onClick: () => change('accounts', [...input.accounts, blankAccount()]), children: '新增账户',
              }) }),
            ] : []),
          ]
          break
        case 'accounting':
          fields = [
            field('旧账情况', 'history', { list: histories }),
            input.history === 'previous' ? field('旧账做到的月份', 'lastMonth', { type: 'month' }) : null,
            field('开始记账的月份', 'startMonth', { type: 'month' }),
          ]
          break
        case 'payroll':
          fields = [field('发薪安排', 'payroll', { list: payrollStates }),
            input.payroll === 'scheduled' ? field('每月发薪日', 'payday', { list: paydays }) : null,
            field('社保情况', 'social', { list: socialStates })]
          break
      }
      return jsx('form', {
        'aria-label': title, style: panelSectionStyle,
        onSubmit: event => { event.preventDefault(); void save(event.currentTarget) },
        children: [
          jsx('h3', { style: panelSectionHeading, children: title }),
          jsx('div', { style: { ...readoutGrid, gap: '12px 16px' }, children: fields }),
          error ? jsx('p', { role: 'alert', style: { margin: '10px 0 0', color: 'var(--dsw-alias-label-danger, #ad3939)' }, children: error }) : null,
          notice ? jsx('p', { role: 'status', style: { color: muted, margin: '10px 0 0' }, children: notice }) : null,
          changed.length ? jsx('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }, children: [
            jsx('span', { role: 'status', style: { marginInlineEnd: 'auto', color: muted, fontSize: 12 },
              children: conflicts.size ? '资料有更新，已保留你的输入。保存前请核对。' : '有未保存的修改' }),
            jsx('button', { type: 'button', style: panelAction, disabled: saving, onClick: () => {
              setEdits({})
              setReviewed({})
              setServerIssue(null)
              setError('')
            }, children: '放弃修改' }),
            jsx('button', { type: 'submit', style: { ...panelAction, background: 'var(--dsw-static-deepseek-600, #1b6f4a)', color: '#fff' },
              disabled: saving, children: saving ? '保存中…' : conflicts.size ? '保存我的修改' : '保存' }),
          ] }) : null,
        ],
      })
    }

    function summarizeObligations(items) {
      return items?.map(item => [item.taxItem, item.filingCycle].filter(Boolean).join(' · ')).filter(Boolean).join('；')
    }

    function OnboardingReadout({ sessionId, view, profile }) {
      const { enterprise, accounting, payroll } = view
      const section = (name, rows) => !view.completed
        ? jsx(OnboardingEditor, { sessionId, view, section: name }, view.draftId + ':' + name)
        : readoutGroup(sectionLabels[name], rows)
      const accountText = enterprise?.accounts?.map(account =>
        [account.holder, account.bank, account.maskedNumber, currencies[account.currency] ?? account.currency, account.openedOn]
          .filter(Boolean).join(' · '),
      ).filter(Boolean).join('；')
      return [
        profile && !view.completed ? readoutGroup('已读取的税务资料 · 待核对', [
          readoutRow('企业全称', profile.companyName),
          readoutRow('统一社会信用代码', profile.taxId),
          ...(profile.establishedOn ? [readoutRow('成立日期', profile.establishedOn)] : []),
          readoutRow('主管税务机关', profile.authority),
          readoutRow('纳税人身份', profile.taxpayerQualification),
          ...(profile.incomeMethod ? [readoutRow('企业所得税征收方式', profile.incomeMethod)] : []),
          ...(profile.accountingSystem ? [readoutRow('会计制度', profile.accountingSystem)] : []),
          ...(profile.registrationStatus ? [readoutRow('登记状态', profile.registrationStatus)] : []),
          ...(profile.taxpayerStatus ? [readoutRow('纳税人状态', profile.taxpayerStatus)] : []),
          readoutRow('当前页税费种', summarizeObligations(profile.obligations) || '本次未读取到'),
        ]) : null,
        section('company', [
          readoutRow('企业全称', enterprise?.companyName),
          readoutRow('统一社会信用代码', enterprise?.taxId),
          readoutRow('成立日期', enterprise?.establishedOn),
          readoutRow('实际经营', (enterprise?.business ?? []).map(key => businessTypes[key]).filter(Boolean).join('、')),
        ]),
        section('tax', [
          ...TAX_FIELDS.filter(item => !item.requiredWhen || enterprise?.[item.requiredWhen] === '其他').map(item =>
            readoutRow(item.label, item.key === 'taxpayerIdentity' ? taxpayerTypes[enterprise?.taxpayerIdentity] : enterprise?.[item.key])),
          ...(enterprise?.officialTax ? [readoutRow('当前页税费种', summarizeObligations(enterprise.officialTax.obligations) || '本次未读取到')] : []),
        ]),
        section('bank', [
          readoutRow('账户情况', bankStates[enterprise?.bankStatus]),
          ...(enterprise?.bankStatus === 'provided' ? [readoutRow('账户资料', accountText)] : []),
        ]),
        section('accounting', [
          readoutRow('旧账情况', histories[accounting?.history]),
          ...(accounting?.history === 'previous' ? [readoutRow('旧账做到', accounting.lastMonth)] : []),
          readoutRow('开始记账', accounting?.startMonth),
        ]),
        section('payroll', [
          readoutRow('发薪安排', payrollStates[payroll?.payroll]),
          ...(payroll?.payroll === 'scheduled' ? [readoutRow('发薪日', payroll.payday ? '每月 ' + payroll.payday + ' 日' : '')] : []),
          readoutRow('社保情况', socialStates[payroll?.social]),
        ]),
      ]
    }

    function CompanyOnboardingReadout({ sessionId }) {
      const [view, setView] = useState(null)
      const [preview, setPreview] = useState(() => onboardingTaxPreviews.get(sessionId))
      const [message, setMessage] = useState('')
      useEffect(() => {
        const abort = new AbortController()
        let changed = false
        const sync = (source, { view: draft }) => {
          if (source !== sessionId) return
          setPreview(onboardingTaxPreviews.get(sessionId))
          if (!draft) return
          changed = true
          setView(previous =>
            draft.draftId === previous?.draftId && draft.revision < previous.revision ? previous : draft,
          )
        }
        const unsubscribe = subscribeOnboarding(sync)
        void onboardingRequest(sessionId, 'status', {}, AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]))
          .then(draft => { if (!abort.signal.aborted && !changed) sync(sessionId, { view: draft }) })
          .catch(error => { if (!abort.signal.aborted && !changed) setMessage(error.message) })
        return () => {
          abort.abort()
          unsubscribe()
        }
      }, [sessionId])
      const profile = !preview?.draftId || preview.draftId === view?.draftId ? preview?.profile : undefined
      return jsx('section', { 'aria-label': '建档资料', 'data-qianlai-onboarding': true, style: {
        height: '100%', minHeight: 0, overflowY: 'auto', padding: '16px clamp(10px, 3.5%, 22px)',
        boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary, #26372f)', fontSize: 14,
      }, children: [
        jsx('header', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
          gap: '6px 12px', padding: '0 2px 12px', marginBottom: 12, borderBottom: readoutBorder }, children: [
          jsx('h2', { style: { margin: 0, fontSize: 18, fontWeight: 680 }, children: '建档资料' }),
          jsx('p', { role: 'status', style: { margin: 0, color: muted, fontSize: 12, lineHeight: 1.6,
            padding: '3px 8px', borderRadius: 8, background: 'color-mix(in srgb, ' + panelAccent + ' 7%, transparent)' },
            children: view?.completed ? '建档完成' : view ? view.step + '/4 · ' + steps[view.step - 1] : message || '正在读取建档进度…',
          }),
        ] }),
        view?.handoffWarning ? jsx('p', { children: view.handoffWarning }) : null,
        view ? jsx(OnboardingReadout, { sessionId, view, profile }) : null,
      ] })
    }

    function ZhangjieOnboardingTab({ sessionId, useSessions }) {
      const active = usePreset(sessionId, useSessions) === PRESET
      return active && sessionId ? jsx(CompanyOnboardingReadout, { sessionId }, sessionId) : null
    }

    // 钱来配色层。DSH 的主色、气泡、选中态、焦点环都引用 deepseek 色阶，整组换成绿色即可跟着变；
    // 色阶本身不分明暗（明暗两套各取不同档），所以 light/dark 同值。
    const SCALE = {
      50: '#edf8f1',
      100: '#dcf2e4',
      200: '#c4eacf',
      300: '#9fdcb4',
      400: '#5fcf8e',
      450: '#2fb46e',
      500: '#1f8a5b',
      600: '#1b6f4a',
      800: '#24433a',
      900: '#1d332b',
    }
    const TOKENS = {
      ...Object.fromEntries(Object.entries(SCALE).map(([step, value]) => [`--dsw-static-deepseek-${step}`, { light: value, dark: value }])),
      '--dsw-specific-sidebar-fill': { light: '#f4f8f5', dark: 'var(--dsw-static-neutral-bluish-900)' },
      '--dsw-alias-label-primary-bluish': { light: '#1b5e40', dark: 'var(--dsw-static-neutral-bluish-50)' },
    }

    // 新会话页和会话头部可能同时挂着张姐组件，按引用计数叠一次、最后一个离开时撤掉。
    let theme
    let holders = 0
    let release
    const applyLayer = () => {
      if (theme && holders > 0 && !release) release = theme.overrideTokens('dsh-qianlai', TOKENS)
    }
    const dropLayer = () => {
      release?.()
      release = undefined
    }
    function useQianlaiTheme(active) {
      useEffect(() => {
        if (!active) return undefined
        holders += 1
        applyLayer()
        return () => {
          holders -= 1
          if (holders === 0) dropLayer()
        }
      }, [active])
    }

    function usePreset(sessionId, useSessions) {
      return useSessions((state) => {
        const value = state.byId[sessionId]?.projectionValues?.agentPreset
        return typeof value === 'string' ? value : undefined
      })
    }

    function Avatar() {
      return jsx('img', {
        src: AVATAR,
        alt: '张姐',
        title: '钱来张姐：小企业财务助手',
        width: 24,
        height: 24,
        style: { borderRadius: '50%', objectFit: 'cover', display: 'block' },
      })
    }

    function ZhangjieAvatar({ sessionId, useSessions }) {
      const active = usePreset(sessionId, useSessions) === PRESET
      useQianlaiTheme(active)
      useEffect(() => active ? watchOnboardingStart(sessionId) : undefined, [active, sessionId])
      return active ? jsx('span', { style: { display: 'inline-flex', gap: 10, alignItems: 'center' }, children: [jsx(Avatar, {}), jsx(WechatPanel, { sessionId })] }) : null
    }

    /** 新会话页也提供微信入口。 */
    function ZhangjieTheme({ sessionId, useSessions }) {
      const active = usePreset(sessionId, useSessions) === PRESET
      useQianlaiTheme(active)
      return active ? jsx(WechatPanel, { sessionId }) : null
    }

    function parseJson(text) {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }

    function toolResultText(event) {
      const message = event.data.message
      const content = message?.content
      if (event.surfaceOp !== 'append' || message?.isError || message?.source?.kind !== 'tool'
        || content?.length !== 1 || content[0]?.type !== 'text') return null
      return typeof content[0].text === 'string' ? content[0].text : null
    }

    function questionHistoryDefinition(events) {
      return {
        kind: QUESTION_HISTORY,
        target: 'chat',
        match: {
          'tool/call': event => event.data.name === 'ask_user_question'
            ? { id: event.data.callId, role: 'start' }
            : null,
          'tool/result': event => {
            const text = toolResultText(event)
            // Only ask-user results can add a row. Keep matches when history
            // loads the result before its call, without retaining unrelated results.
            return text?.includes('"answers"')
              ? { id: event.data.message.source.callId, role: 'update' }
              : null
          },
        },
        start: (_context, { event }) => {
          const questions = parseJson(event.data.arguments)?.questions
          if (!Array.isArray(questions) || questions.length === 0
            || !questions.every(item => typeof item?.id === 'string' && typeof item.question === 'string')) return null
          return { questions, pairs: null }
        },
        update: ({ state }, { event }) => {
          if (state === null) return state
          const result = parseJson(toolResultText(event))
          if (result?.pending || !Array.isArray(result?.answers) || result.answers.length !== state.questions.length) return state
          const answers = new Map(result.answers.map(item => [item?.id, item]))
          const pairs = []
          for (const { id, question } of state.questions) {
            const answer = answers.get(id)
            if (!Array.isArray(answer?.selected) || !answer.selected.every(value => typeof value === 'string')
              || (answer.custom !== undefined && typeof answer.custom !== 'string')) return state
            const values = [...answer.selected]
            if (answer.custom?.trim()) values.push(answer.custom)
            pairs.push({ id, question, answer: values.length ? values.join('、') : null })
          }
          return { ...state, pairs, anchorSeq: event.seq }
        },
        buildViewNode: ({ key, id, state, start }) => {
          if (!state?.pairs) return null
          // DSH 0.2.2 projects settled answers itself. Follow the installed
          // client capability so a host update cannot produce a duplicate.
          if (events.entries().some(definition => definition.kind === 'answered-user-question')) return null
          return {
            key, id, kind: QUESTION_HISTORY, target: 'chat', anchorSeq: state.anchorSeq,
            location: start.location, groupTree: 'turn', visibility: 'visible', data: state.pairs,
          }
        },
      }
    }

    function ZhangjieQuestionHistory({ node, sessionId, useSessions }) {
      if (usePreset(sessionId, useSessions) !== PRESET) return null
      return jsx('div', {
        role: 'group',
        'aria-label': '选择卡问答记录',
        'data-qianlai-question-answer': node.id,
        style: { display: 'flex', justifyContent: 'flex-end', padding: '4px 0' },
        children: jsx('dl', {
          style: {
            display: 'grid', gap: 8, maxWidth: 'min(85%, 44rem)', margin: 0, padding: '10px 16px',
            borderRadius: 'var(--dsw-radius-xl)', background: 'var(--dsw-specific-bubble)',
            color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          },
          children: node.data.map(({ id, question, answer }) => jsx('div', {
            children: [
              jsx('dt', { style: { color: 'var(--dsw-alias-label-secondary)' }, children: question }),
              jsx('dd', {
                style: { margin: '3px 0 0' },
                children: answer === null ? '已跳过' : [
                  jsx('span', { style: { color: 'var(--dsw-alias-label-secondary)', marginInlineEnd: 8 }, children: '你的回答' }),
                  answer,
                ],
              }),
            ],
          }, id)),
        }),
      })
    }

    /* onboarding-date-client */
    /* onboarding-chat-client */
    /* report-chat-client */

    const OnboardingDateInput = createOnboardingDateInput({ jsx, useState, useRef, useEffect },
      typeof window.HTMLElement?.prototype.showPopover === 'function')

    const inject = ['slots']

    function apply(ctx) {
      ctx.inject(['connection'], scope => {
        connection = scope.connection
        scope.effect(() => () => { connection = undefined }, 'dsh-qianlai: connection')
      })
      ctx.inject(['sessions', 'conversation'], scope => {
        sessions = scope.sessions
        scope.effect(() => () => { sessions = undefined }, 'dsh-qianlai: onboarding turns')
      })
      ctx.inject(['theme'], (scope) => {
        theme = scope.theme
        applyLayer()
        scope.effect(() => () => {
          dropLayer()
          theme = undefined
        }, 'dsh-qianlai: theme layer')
      })
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'moneycome-zhangjie', order: -20 },
          ZhangjieAvatar,
        ),
      )
      ctx.slots.inject('conversation.hero.options', () =>
        ctx.slots.register(
          { name: 'conversation.hero.options', id: 'moneycome-zhangjie', order: -20 },
          ZhangjieTheme,
        ),
      )
      ctx.inject(['sidebarRight', 'sidebarRightTabs'], scope => {
        sidebarRight = scope.sidebarRight
        scope.effect(() => () => { sidebarRight = undefined; onboardingTaxPreviews.clear() }, 'dsh-qianlai: onboarding sidebar')
        scope.effect(() => scope.sidebarRightTabs.register({
          id: ONBOARDING_TAB, kind: ONBOARDING_TAB, title: () => '企业建档', keepMounted: true,
        }), 'dsh-qianlai: onboarding tab type')
        scope.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ONBOARDING_TAB }, ZhangjieOnboardingTab),
        ), 'dsh-qianlai: onboarding tab body')
      })
      registerOnboardingChat(ctx, {
        jsx, useEffect, useRef, useState, usePreset, OnboardingDateInput, openOnboarding, refreshOnboarding, onboardingRequest,
        sendOnboardingReply, subscribeOnboarding, previewOnboardingTax, readOnboardingFile, taxRequest,
        taxRegionCities: TAX_REGION_CITIES, taxScanCities: TAX_SCAN_CITIES,
      })
      registerCompanyReportChat(ctx, { jsx, useState, useRef, usePreset, toolResultText, buttonStyle, panelSectionStyle })
      ctx.inject(['uiConversation'], scope => {
        const { events } = scope.uiConversation
        events.register(questionHistoryDefinition(events))
      })
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register(
          { name: 'conversation.chat.node', key: QUESTION_HISTORY },
          ZhangjieQuestionHistory,
        ),
      )
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
