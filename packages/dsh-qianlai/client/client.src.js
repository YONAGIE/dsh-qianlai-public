/* global window, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval */
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
    const TAX_SCAN_CITIES = /* tax-scan-cities */ {}
    const AVATAR = '__AVATAR_DATA_URL__'
    const buttonStyle = { font: 'inherit', fontSize: 14, border: '1px solid #c4eacf', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', background: '#edf8f1', color: '#1b6f4a' }
    let connection

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


    let onboardingSession
    const onboardingListeners = new Set()
    const steps = ['企业信息', '记账准备', '工资社保', '确认建档']
    const taxpayerTypes = { 'small-scale': '小规模纳税人', general: '一般纳税人', unknown: '待核实' }
    const businessTypes = { goods: '买卖商品或有库存', production: '生产或加工', 'cross-border': '有境外往来或外币收付款', 'multiple-entities': '有多个经营主体', none: '以上都没有' }
    const bankStates = { provided: '有银行账户', none: '没有银行账户', pending: '账户资料待补' }
    const histories = { previous: '已有旧账', unrecorded: '成立后未记账', new: '刚成立' }
    const payrollStates = { scheduled: '定期发工资', none: '暂时不发工资' }
    const socialStates = { all: '所有人都交', partial: '部分人交', none: '都没交', unknown: '待核实' }
    const currencies = { CNY: '人民币 (CNY)', USD: '美元 (USD)', HKD: '港元 (HKD)', EUR: '欧元 (EUR)', JPY: '日元 (JPY)', GBP: '英镑 (GBP)', SGD: '新加坡元 (SGD)', AUD: '澳元 (AUD)', CAD: '加拿大元 (CAD)' }
    const layout = { display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(min(12rem, 100%), 1fr))' }
    const actions = { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }
    const fieldStyle = { display: 'block', width: '100%', minWidth: 0, boxSizing: 'border-box', marginTop: 4, padding: '6px 8px', font: 'inherit', background: 'transparent', color: 'inherit', border: '1px solid #a3cdb6', borderRadius: 6 }

    function selectOnboarding(sessionId) {
      onboardingSession = sessionId
      for (const update of onboardingListeners) update(sessionId)
    }

    function onboardingButton(label, onClick, disabled = false) {
      return jsx('button', { type: 'button', style: { ...buttonStyle, opacity: disabled ? .55 : 1 }, onClick, disabled, children: label })
    }

    function onboardingField(label, value, change, { options, ...props } = {}) {
      const input = { ...props, value: value ?? '', onChange: event => change(event.target.value), style: fieldStyle }
      return jsx('label', { children: [label, options
        ? jsx('select', { ...input, children: [
          jsx('option', { value: '', children: '请选择' }),
          ...Object.entries(options).map(([key, name]) => jsx('option', { value: key, children: name }, key)),
        ] })
        : jsx('input', input),
      ] })
    }

    function onboardingGroup(label, children) {
      return jsx('fieldset', { style: { minWidth: 0, border: '1px solid #c4eacf', borderRadius: 8, margin: '9px 0', padding: 10 }, children: [
        jsx('legend', { style: { fontWeight: 600 }, children: label }),
        ...children,
      ] })
    }

    async function onboardingRequest(sessionId, action, extra = {}, signal = AbortSignal.timeout(action === 'recognize' ? 120000 : 10000)) {
      if (!connection) throw Error('建档服务还没就绪，请稍后重试。')
      const result = await connection.rpc.call('/api', 'qianlai/company-onboarding', { action, sessionId, ...extra }, signal)
      if (!result.ok) throw Error(result.error.message)
      if (result.value?.accepted !== true) throw Error(result.value?.message || '建档操作未完成，请重试。')
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

    function OnboardingUpload({ children, onFile, disabled }) {
      const input = useRef(null)
      return jsx('span', { children: [
        onboardingButton(children, () => input.current?.click(), disabled),
        jsx('input', {
          type: 'file', ref: input, hidden: true, accept: '.pdf,.png,.jpg,.jpeg,.webp',
          'aria-label': children, disabled,
          onChange: event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) onFile(file)
          },
        }),
      ] })
    }

    async function taxRequest(action, id, sessionId, draftId, extra = {}) {
      if (!connection) throw Error('建档服务还没就绪，请稍后重试。')
      const result = await connection.rpc.call('/api', 'qianlai/tax-onboarding', { action, id, sessionId, draftId, ...extra }, AbortSignal.timeout(10000))
      if (!result.ok) throw Error(result.error.message)
      return result.value
    }

    function TaxOnboarding({ sessionId, draftId, enterprise, onSave, onConfirmed, onActive, disabled }) {
      const flow = useRef(null)
      const pending = useRef(false)
      const refreshed = useRef(false)
      const [active, setActive] = useState(false)
      const [view, setView] = useState({ phase: 'idle' })
      const [message, setMessage] = useState('')
      const supported = Object.hasOwn(TAX_SCAN_CITIES, enterprise.province)
        && TAX_SCAN_CITIES[enterprise.province].includes(enterprise.city)

      const request = async action => {
        if (pending.current || !flow.current) return
        const id = flow.current
        pending.current = true
        if (action !== 'status') setMessage('')
        try {
          const result = await taxRequest(action, id, sessionId, draftId)
          if (flow.current !== id) return
          setView(result)
          if (result.phase === 'submitted' && !refreshed.current) {
            refreshed.current = true
            await onConfirmed()
            setActive(false)
            onActive(false)
          }
        } catch (error) {
          if (flow.current === id) {
            refreshed.current = false
            setMessage(error.message || '扫码操作失败，请重试。')
          }
        } finally {
          if (flow.current === id) pending.current = false
        }
      }

      useEffect(() => {
        if (!active) return
        const timer = setInterval(() => { void request('status') }, 1200)
        return () => {
          clearInterval(timer)
          const id = flow.current
          flow.current = null
          pending.current = false
          if (id) void taxRequest('cancel', id, sessionId, draftId).catch(() => {})
        }
      }, [active, draftId, sessionId])

      const start = async () => {
        if (pending.current) return
        pending.current = true
        setMessage('')
        setView({ phase: 'opening' })
        onActive(true)
        try {
          const current = await onSave()
          if (!current) throw Error('请先保存企业信息再扫码。')
          const id = flow.current ?? window.crypto.randomUUID()
          flow.current = id
          refreshed.current = false
          setActive(true)
          const result = await taxRequest('start', id, sessionId, draftId, {
            province: enterprise.province, city: enterprise.city, companyName: enterprise.companyName?.trim(),
            taxId: enterprise.taxId?.trim().toUpperCase(),
          })
          if (flow.current === id) setView(result)
          else await taxRequest('cancel', id, sessionId, draftId)
        } catch (error) {
          setView({ phase: 'failed' })
          setMessage(error.message || '未能打开扫码页。')
          onActive(false)
        } finally {
          pending.current = false
        }
      }
      const close = () => {
        setActive(false)
        setView({ phase: 'idle' })
        setMessage('')
        onActive(false)
      }
      const ready = Boolean(supported && enterprise.companyName?.trim() && /^[A-Za-z0-9]{18}$/.test(enterprise.taxId?.trim() ?? ''))
      const profile = view.profile
      const busyText = { opening: '正在打开官方税务网页…', reading: '正在读取税务资料…', submitting: '正在回填建档资料…' }
      return jsx('div', { children: [
        ['idle', 'failed'].includes(view.phase) ? onboardingButton('打开官方扫码页', () => void start(), disabled || !ready) : null,
        enterprise.city && !supported ? jsx('p', { children: '该地区暂未接入扫码，可以上传官方资料或手填。' }) : null,
        supported && !ready && view.phase === 'idle' ? jsx('p', { children: '填好企业全称和统一社会信用代码后可以扫码。' }) : null,
        busyText[view.phase] ? jsx('p', { role: 'status', children: busyText[view.phase] }) : null,
        view.phase === 'waiting' ? jsx('p', { children: '用电子税务局 App 扫码，确认企业后回来读取。' }) : null,
        view.phase === 'waiting' ? onboardingButton('已登录，读取税务资料', () => void request('read')) : null,
        profile && view.phase !== 'submitted' ? jsx('section', { 'aria-label': '读取到的企业税务资料', children: [
          jsx('p', { children: profile.companyName + ' · ' + profile.taxId }),
          jsx('p', { children: [profile.authority, profile.taxpayerQualification, profile.taxpayerStatus].filter(Boolean).join(' · ') }),
          profile.registrationDate ? jsx('p', { children: '登记日期 ' + profile.registrationDate }) : null,
          profile.obligations?.length ? jsx('ul', { children: profile.obligations.map((tax, index) => jsx('li', {
            children: [tax.taxCategory, tax.taxItem, tax.filingCycle].filter(Boolean).join(' · '),
          }, index)) }) : null,
          jsx('p', { children: '来源 ' + profile.sourceUrl }),
          onboardingButton('核对无误，回填税务资料', () => void request('submit'), view.phase !== 'ready'),
        ] }) : null,
        message || view.message ? jsx('p', { role: 'status', children: message || view.message }) : null,
        active ? onboardingButton('关闭扫码', close, view.phase === 'submitting') : null,
      ] })
    }

    function EnterpriseFields({ input, change, sessionId, view, busy, scanActive, setScanActive, save, refresh, recognize }) {
      const bind = key => value => change({ [key]: value })
      const field = (label, key, props) => onboardingField(label, input[key], bind(key), props)
      const options = values => Object.fromEntries(values.map(value => [value, value]))
      const accounts = input.accounts ?? []
      const business = input.business ?? []
      const official = input.officialTax
      const types = { ...taxpayerTypes }
      const taxStates = options(['正常', '待核实', '非正常', '注销', '非正常注销', '停业', '清算'])
      if (input.taxStatus && !Object.hasOwn(taxStates, input.taxStatus)) taxStates[input.taxStatus] = input.taxStatus
      const editing = Boolean(busy || scanActive)
      const blankAccount = () => ({ holder: input.companyName ?? '', bank: '', number: '', currency: 'CNY', openedOn: '' })
      const accountField = (account, index, label, key, props) => onboardingField(label, account[key], value => bind('accounts')(
        accounts.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row),
      ), { ...props, disabled: editing })

      return [
        onboardingGroup('公司资料', [
          jsx('div', { style: layout, children: [
            field('企业全称', 'companyName', { maxLength: 200, disabled: editing }),
            field('统一社会信用代码', 'taxId', { maxLength: 18, disabled: editing }),
            field('成立日期', 'establishedOn', { type: 'date', disabled: editing }),
          ] }),
          jsx('div', { style: actions, children: jsx(OnboardingUpload, {
            onFile: file => void recognize('license', file), disabled: editing, children: '上传并识别营业执照',
          }) }),
        ]),
        onboardingGroup('税务资料', [
          jsx('div', { style: layout, children: [
            onboardingField('省份', input.province, province => change({ province, city: '' }), { options: options(Object.keys(TAX_REGION_CITIES)), disabled: editing }),
            field('城市或地区', 'city', { options: options(TAX_REGION_CITIES[input.province] ?? []), disabled: editing || !input.province }),
            field('主管税务机关', 'taxAuthority', { maxLength: 200, disabled: editing || Boolean(official?.taxAuthority) }),
            field('纳税人类型', 'taxpayerIdentity', { options: types, disabled: editing || ['small-scale', 'general'].includes(official?.taxpayerIdentity) }),
            field('税务状态', 'taxStatus', { options: taxStates, disabled: editing || Boolean(official?.taxStatus && official.taxStatus !== '待核实') }),
          ] }),
          official ? jsx('p', { children: '已从税务网页回填。来源 ' + official.sourceUrl }) : null,
          jsx('div', { style: actions, children: jsx(OnboardingUpload, {
            onFile: file => void recognize('tax', file), disabled: editing, children: '上传并识别税务资料',
          }) }),
          jsx(TaxOnboarding, {
            sessionId, draftId: view.draftId, enterprise: input, onSave: () => save(false), onConfirmed: refresh,
            onActive: setScanActive, disabled: Boolean(busy),
          }),
        ]),
        onboardingGroup('实际经营', [
          jsx('div', { style: layout, children: Object.entries(businessTypes).map(([key, label]) => jsx('label', { children: [
            jsx('input', { type: 'checkbox', checked: business.includes(key), disabled: editing, onChange: event => {
              if (!event.target.checked) bind('business')(business.filter(item => item !== key))
              else bind('business')(key === 'none' ? ['none'] : [...business.filter(item => item !== 'none'), key])
            } }),
            ' ' + label,
          ] }, key)) }),
        ]),
        onboardingGroup('银行账户', [
          onboardingField('账户情况', input.bankStatus, bankStatus => change({
            bankStatus, accounts: bankStatus === 'provided' && !accounts.length ? [blankAccount()] : accounts,
          }), { options: bankStates, disabled: editing }),
          ...(input.bankStatus === 'provided' ? [
            ...accounts.map((account, index) => jsx('div', { style: { marginTop: 8 }, children: [
              jsx('div', { style: layout, children: [
                accountField(account, index, '户名', 'holder', { maxLength: 200 }),
                accountField(account, index, '银行账号', 'number', { inputMode: 'numeric', maxLength: 48, placeholder: account.maskedNumber }),
                accountField(account, index, '开户行', 'bank', { maxLength: 200 }),
                accountField(account, index, '币种', 'currency', { options: currencies }),
                accountField(account, index, '开户日期', 'openedOn', { type: 'date' }),
              ] }),
              jsx('div', { style: actions, children: onboardingButton('移除此账户', () => bind('accounts')(accounts.filter((_, i) => i !== index)), editing) }),
            ] }, account.id ?? index)),
            jsx('div', { style: actions, children: onboardingButton('添加银行账户', () => bind('accounts')([...accounts, blankAccount()]), editing || accounts.length >= 20) }),
          ] : []),
        ]),
      ]
    }

    function OnboardingReview({ view, edit, busy }) {
      const { enterprise, accounting, payroll } = view
      const row = (label, value) => jsx('div', { children: [
        jsx('dt', { style: { color: 'var(--dsw-alias-label-secondary)' }, children: label }),
        jsx('dd', { style: { margin: '0 0 6px', overflowWrap: 'anywhere' }, children: value || '未提供' }),
      ] }, label)
      const section = (step, rows) => onboardingGroup(steps[step - 1], [
        jsx('dl', { style: { ...layout, margin: 0 }, children: rows }),
        !view.completed ? onboardingButton('修改' + steps[step - 1], () => edit(step), Boolean(busy)) : null,
      ])
      return [
        section(1, [
          row('企业全称', enterprise?.companyName),
          row('统一社会信用代码', enterprise?.taxId),
          row('成立日期', enterprise?.establishedOn),
          row('税务地区', [enterprise?.province, enterprise?.city].filter(Boolean).join(' ')),
          row('主管税务机关', enterprise?.taxAuthority),
          row('纳税人类型', taxpayerTypes[enterprise?.taxpayerIdentity]),
          row('税务状态', enterprise?.taxStatus),
          row('实际经营', (enterprise?.business ?? []).map(key => businessTypes[key]).join('、')),
          row('银行账户', enterprise?.bankStatus === 'provided'
            ? (enterprise.accounts ?? []).map(account => [account.holder, account.bank, account.maskedNumber, currencies[account.currency] ?? account.currency, account.openedOn].filter(Boolean).join(' · ')).join('；')
            : bankStates[enterprise?.bankStatus]),
        ]),
        section(2, [row('旧账情况', histories[accounting?.history]), ...(accounting?.history === 'previous' ? [row('旧账做到', accounting.lastMonth)] : []), row('开始记账', accounting?.startMonth)]),
        section(3, [row('发薪安排', payrollStates[payroll?.payroll]), ...(payroll?.payroll === 'scheduled' ? [row('发薪日', '每月 ' + payroll.payday + ' 日')] : []), row('社保情况', socialStates[payroll?.social])]),
      ]
    }

    function CompanyOnboarding({ sessionId }) {
      const [view, setView] = useState(null)
      const [step, setStep] = useState(1)
      const [input, setInput] = useState({})
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState('')
      const [scanActive, setScanActive] = useState(false)
      const [replaceSampleBook, setReplaceSampleBook] = useState(false)
      const pending = useRef(false)
      const applyView = (state, next = state.step) => {
        setView(state)
        setStep(next)
        setInput(state[['enterprise', 'accounting', 'payroll'][next - 1]] ?? {})
        setReplaceSampleBook(false)
      }
      useEffect(() => {
        const abort = new AbortController()
        void onboardingRequest(sessionId, 'status', {}, AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]))
          .then(state => { if (!abort.signal.aborted) applyView(state) })
          .catch(error => { if (!abort.signal.aborted) setMessage(error.message) })
        return () => abort.abort()
      }, [sessionId])

      const run = async (notice, task) => {
        if (pending.current) return
        pending.current = true
        setBusy(notice)
        setMessage('')
        try { return await task() }
        catch (error) { setMessage(error.message || '建档操作未完成，请重试。') }
        finally { setBusy(''); pending.current = false }
      }
      const save = (advance, hide = false) => run('正在保存…', async () => {
        const patch = step === 1 ? {
          ...input,
          accounts: (input.accounts ?? []).map(({ maskedNumber: _maskedNumber, ...account }) => account),
        } : input
        delete patch.officialTax
        const result = await onboardingRequest(sessionId, 'save', { draftId: view.draftId, step, revision: view.revision, input: patch, advance })
        applyView(result, advance ? result.step : step)
        if (hide) selectOnboarding(undefined)
        return result
      })
      const refresh = async () => {
        applyView(await onboardingRequest(sessionId, 'status'), 1)
        setMessage('已回填税务资料，请核对并补齐其余信息。')
      }
      const change = patch => setInput(previous => ({ ...previous, ...patch }))
      const recognize = (kind, file) => run('正在识别资料…', async () => {
        if (!file.size || file.size > 8 * 1024 * 1024) throw Error('请选择不超过 8 MB 的 PDF 或图片。')
        const base64 = await readOnboardingFile(file)
        const result = await onboardingRequest(sessionId, 'recognize', {
          draftId: view.draftId, revision: view.revision, kind,
          file: { name: file.name, mimeType: file.type, base64 },
        })
        const recognized = result.fields ?? {}
        const different = (key, normalize) => input[key] && recognized[key] && normalize(input[key]) !== normalize(recognized[key])
        if (different('companyName', value => value.normalize('NFKC').replace(/\s+/g, ''))
          || different('taxId', value => value.trim().toUpperCase())) {
          throw Error('资料上的企业名称或信用代码与已填写的信息不一致。请核对企业后再识别。')
        }
        const fields = Object.fromEntries(Object.entries(recognized).filter(([key, value]) =>
          ['companyName', 'taxId', 'establishedOn', 'province', 'city', 'taxpayerIdentity', 'taxStatus', 'taxAuthority'].includes(key)
          && typeof value === 'string' && value && (!input[key] || input[key] === '待核实' || input[key] === 'unknown'),
        ))
        if (fields.province && fields.province !== input.province && input.city) delete fields.province
        if (fields.city && !TAX_REGION_CITIES[fields.province || input.province]?.includes(fields.city)) delete fields.city
        if (Object.keys(fields).length) change(fields)
        const coverage = result.totalPages > result.pagesRead ? '本次识别了 PDF 的第一页。其他页面可截取后上传。' : ''
        setMessage((Object.keys(fields).length ? '已识别并填入空白项，请核对。' : '没有可补填的资料。请核对已有内容，缺项可手填。') + coverage)
      })
      const field = (label, key, props) => onboardingField(label, input[key], value => change({ [key]: value }), { ...props, disabled: Boolean(busy) })
      const edit = next => {
        applyView(view, next)
        setMessage('')
      }
      const confirm = () => run('正在确认建档…', async () => {
        applyView(await onboardingRequest(sessionId, 'confirm', { draftId: view.draftId, revision: view.revision, replaceSampleBook }))
      })
      const help = [
        '请补齐企业、税务和银行资料。上传识别会使用当前模型。',
        '原来的账做到哪了？我按你确认的月份接着记。',
        '请确认发薪安排和社保情况。',
        '请核对信息，确认后我会按这些资料建档。',
      ]
      return jsx('section', { 'aria-label': '张姐建档', 'data-qianlai-onboarding': true, style: {
        maxHeight: 'min(54vh, 36rem)', overflowY: 'auto', padding: 12, marginBottom: 8,
        boxSizing: 'border-box', border: '1px solid #c4eacf', borderRadius: 12,
        background: 'var(--dsw-specific-bubble, #edf8f1)', color: 'var(--dsw-alias-label-primary, #24433a)', fontSize: 14,
      }, children: [
        jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
          jsx(Avatar, {}), jsx('strong', { children: view?.completed ? '建档完成' : view ? step + '/4 ' + steps[step - 1] : '张姐建档' }),
        ] }),
        !view ? jsx('p', { role: 'status', children: message || '正在读取建档进度…' }) : null,
        view && !view.completed ? jsx('p', { children: help[step - 1] }) : null,
        view && !view.completed && step === 1 ? jsx(EnterpriseFields, {
          input, change, sessionId, view, busy, scanActive, setScanActive, save, refresh, recognize,
        }) : null,
        view && step === 2 ? jsx('div', { style: layout, children: [
          field('原有账务', 'history', { options: histories }),
          input.history === 'previous' ? field('旧账做到', 'lastMonth', { type: 'month' }) : null,
          field('开始记账', 'startMonth', { type: 'month' }),
        ] }) : null,
        view && step === 3 ? jsx('div', { style: layout, children: [
          field('发薪安排', 'payroll', { options: payrollStates }),
          input.payroll === 'scheduled' ? onboardingField('每月发薪日', input.payday, value => change({ payday: value ? Number(value) : undefined }), {
            options: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [i + 1, (i + 1) + ' 日'])), disabled: Boolean(busy),
          }) : null,
          field('社保情况', 'social', { options: socialStates }),
        ] }) : null,
        view && step === 4 ? jsx(OnboardingReview, { view, edit, busy }) : null,
        view && !view.completed && step === 4 && view.handoffWarning
          ? jsx('p', { role: 'status', children: view.handoffWarning }) : null,
        view?.completed ? jsx('p', { role: 'status', children: view.nextAction === 'review-book-periods'
          ? '请先核对旧账截止月份和开始记账月份，再提供期初资料。'
          : view.nextAction === 'bookkeeping' ? '可以开始记账了。'
          : view.accounting?.history === 'previous' ? '接下来可以发上期科目余额表，录入期初。'
          : '接下来先确认期初余额，再开始记账。' }) : null,
        view && step === 4 && !view.completed && view.replacesSampleBook ? jsx('label', { children: [
          jsx('input', {
            type: 'checkbox', checked: replaceSampleBook, onChange: event => setReplaceSampleBook(event.target.checked), disabled: Boolean(busy),
          }),
          ' 我确认清除样本账，建立这家企业的账本。',
        ] }) : null,
        view && (busy || message) ? jsx('p', { role: 'status', children: busy || message }) : null,
        jsx('div', { style: actions, children: [
          view && !view.completed && step < 4 ? onboardingButton('继续', () => void save(true), Boolean(busy || scanActive)) : null,
          view && !view.completed && step === 4 ? onboardingButton('确认建档', () => void confirm(), Boolean(busy || view.replacesSampleBook && !replaceSampleBook)) : null,
          view && !view.completed && step < 4 ? onboardingButton('保存并收起', () => void save(false, true), Boolean(busy || scanActive)) : null,
          !view || step === 4 || view.completed ? onboardingButton('收起', () => selectOnboarding(undefined), Boolean(busy)) : null,
        ] }),
      ] })
    }

    function ZhangjieOnboardingDock({ sessionId, useSessions }) {
      const active = usePreset(sessionId, useSessions) === PRESET
      const [selected, setSelected] = useState(onboardingSession)
      useEffect(() => {
        onboardingListeners.add(setSelected)
        return () => { onboardingListeners.delete(setSelected) }
      }, [])
      return active && sessionId && sessionId === selected ? jsx(CompanyOnboarding, { sessionId }, sessionId) : null
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
      return active ? jsx('span', { style: { display: 'inline-flex', gap: 10, alignItems: 'center' }, children: [jsx(Avatar, {}), jsx(WechatPanel, { sessionId }), onboardingButton('开始建档', () => selectOnboarding(sessionId), !sessionId)] }) : null
    }

    /** 新会话页也提供微信入口。 */
    function ZhangjieTheme({ sessionId, useSessions }) {
      const active = usePreset(sessionId, useSessions) === PRESET
      useQianlaiTheme(active)
      return active ? jsx('span', { style: { display: 'inline-flex', gap: 10 }, children: [jsx(WechatPanel, { sessionId }), onboardingButton('开始建档', () => selectOnboarding(sessionId), !sessionId)] }) : null
    }

    function parseJson(text) {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }

    function questionResultText(event) {
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
            const text = questionResultText(event)
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
          const result = parseJson(questionResultText(event))
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

    const inject = ['slots']

    function apply(ctx) {
      ctx.inject(['connection'], scope => {
        connection = scope.connection
        scope.effect(() => () => { connection = undefined }, 'dsh-qianlai: connection')
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
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          { name: 'conversation.input.dock', id: 'moneycome-onboarding', order: 0 },
          ZhangjieOnboardingDock,
        ),
      )
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
