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
    const AVATAR = '__AVATAR_DATA_URL__'
    const buttonStyle = { font: 'inherit', fontSize: 14, border: '1px solid #c4eacf', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', background: '#edf8f1', color: '#1b6f4a' }
    let connection

    function WechatPanel({ sessionId }) {
      const titleId = useId()
      const [open, setOpen] = useState(false)
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
        } catch (error) {
          if (version === sequence.current) {
            if (action === 'status' && latestState.current.status === 'connected' && ++statusFailures.current < 3) return
            setState({ status: 'error', message: error.message || '请求失败，请重试。' })
          }
        } finally { clearTimeout(timer); if (version === sequence.current) control.current = null }
      }
      useEffect(() => {
        if (open) {
          dialog.current?.showModal()
          // Opening "connect" is explicit intent. If already connected, start
          // only attaches this conversation for handoff; it does not reset login.
          void request('start')
        } else {
          void request('status')
        }
        const timer = setInterval(() => void request('status'), 2000)
        return () => { clearInterval(timer); sequence.current++; control.current?.abort(); control.current = null }
      }, [open, sessionId])
      return jsx('span', { children: [
        jsx('button', { type: 'button', onClick: () => setOpen(true), style: { border: '1px solid #c4eacf', borderRadius: 8, padding: '5px 10px', color: '#1b6f4a', background: '#edf8f1', cursor: 'pointer' }, children: buttonLabels[state.status] || '连接微信' }),
        open ? jsx('dialog', { ref: dialog, 'aria-labelledby': titleId, onCancel: () => setOpen(false), style: { border: '1px solid #c4eacf', borderRadius: 16, padding: 24, width: 'min(420px, calc(100vw - 48px))', color: '#24433a', background: '#fff' }, children: [
          jsx('h2', { id: titleId, style: { margin: '0 0 12px', fontSize: 20 }, children: '把张姐接到微信' }),
          jsx('p', { children: '用本人微信扫码后，可以发票据、查账，并继续这台电脑上的财务事项。' }),
          jsx('p', { role: 'status', 'aria-live': 'polite', children: labels[state.status] || state.status }),
          state.qrDataUrl ? jsx('img', { src: state.qrDataUrl, alt: '当前微信登录二维码', style: { display: 'block', width: '100%', maxWidth: 300, margin: '0 auto' } }) : null,
          state.message ? jsx('p', { style: { fontSize: 14, lineHeight: 1.6 }, children: state.message }) : null,
          jsx('div', { style: { display: 'flex', gap: 12, marginTop: 16 }, children: [
            state.status !== 'connected' ? jsx('button', { type: 'button', style: buttonStyle, disabled: state.status === 'loading', onClick: () => void request(state.status === 'disconnected' ? 'start' : 'refresh'), children: state.status === 'disconnected' ? '获取二维码' : '刷新二维码' }) : null,
            jsx('button', { type: 'button', style: { ...buttonStyle, background: '#fff', color: '#24433a' }, onClick: () => setOpen(false), children: '关闭' }),
          ] }),
        ] }) : null,
      ] })
    }


    async function taxRequest(action, id, extra = {}) {
      if (!connection) throw Error('建档服务还没就绪，请稍后重试。')
      const result = await connection.rpc.call('/api', 'qianlai/tax-onboarding', { action, id, ...extra }, AbortSignal.timeout(10000))
      if (!result.ok) throw Error(result.error.message)
      return result.value
    }

    function TaxOnboarding({ sessionId }) {
      const titleId = useId()
      const dialog = useRef(null)
      const flow = useRef(null)
      const pending = useRef(false)
      const [open, setOpen] = useState(false)
      const [companyName, setCompanyName] = useState('')
      const [taxId, setTaxId] = useState('')
      const [province, setProvince] = useState('')
      const [city, setCity] = useState('')
      const [view, setView] = useState({ phase: 'idle' })
      const [message, setMessage] = useState('')
      const busy = ['opening', 'reading', 'submitting'].includes(view.phase)
      const supported = province === '浙江省' && city && city !== '宁波市'
      const inputStyle = { display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 5, padding: 8, font: 'inherit', color: '#24433a', border: '1px solid #a3cdb6', borderRadius: 6 }
      const labelStyle = { display: 'block', margin: '12px 0' }

      const request = async (action, extra) => {
        if (pending.current || !flow.current) return
        const id = flow.current
        pending.current = true
        if (action !== 'status') setMessage('')
        try {
          const result = await taxRequest(action, id, extra)
          if (flow.current === id) setView(result)
          else if (action === 'start') void taxRequest('cancel', id).catch(() => {})
        } catch (error) {
          if (flow.current === id && action !== 'status') setMessage(error.message || '建档操作失败，请重试。')
        } finally {
          if (flow.current === id) pending.current = false
        }
      }

      useEffect(() => {
        if (!open) return
        dialog.current?.showModal()
        const timer = setInterval(() => { if (flow.current) void request('status') }, 1200)
        return () => {
          clearInterval(timer)
          const id = flow.current
          flow.current = null
          pending.current = false
          if (id) void taxRequest('cancel', id).catch(() => {})
        }
      }, [open])

      const start = event => {
        event.preventDefault()
        flow.current ??= window.crypto.randomUUID()
        void request('start', { province, city, companyName, taxId: taxId.trim().toUpperCase(), ...(sessionId ? { sessionId } : {}) })
      }
      const begin = () => {
        setView({ phase: 'idle' })
        setMessage('')
        setOpen(true)
      }
      const profile = view.profile
      const busyText = { opening: '正在打开官方企业登录页，缺少可用浏览器时会先下载 Chromium。', reading: '正在核对企业并读取税务资料。', submitting: '正在把你确认的资料交给当前对话。' }
      return jsx('span', { children: [
        jsx('button', { type: 'button', style: buttonStyle, onClick: begin, children: '开始建档' }),
        open ? jsx('dialog', { ref: dialog, 'aria-labelledby': titleId, onCancel: () => setOpen(false), style: {
          width: 'min(480px, calc(100vw - 48px))', maxHeight: '85vh', overflow: 'auto', padding: 24, border: '1px solid #c4eacf',
          borderRadius: 16, background: '#fff', color: '#24433a',
        }, children: [
          jsx('h2', { id: titleId, style: { margin: 0, fontSize: 20 }, children: '扫码读取企业税务资料' }),
          ['idle', 'failed'].includes(view.phase) ? jsx('form', { onSubmit: start, children: [
            jsx('label', { style: labelStyle, children: ['省份', jsx('select', {
              style: inputStyle, required: true, value: province, onChange: event => { setProvince(event.target.value); setCity('') },
              children: [jsx('option', { value: '', children: '选择省、自治区或直辖市' }),
                ...Object.keys(TAX_REGION_CITIES).map(name => jsx('option', { value: name, children: name }, name))],
            })] }),
            jsx('label', { style: labelStyle, children: ['城市或地区', jsx('select', {
              style: inputStyle, required: true, disabled: !province, value: city, onChange: event => setCity(event.target.value),
              children: [jsx('option', { value: '', children: '选择城市或地区' }),
                ...(TAX_REGION_CITIES[province] ?? []).map(name => jsx('option', { value: name, children: name }, name))],
            })] }),
            city && !supported ? jsx('p', { role: 'status', children: '所选地区暂未接入扫码取数。可把电子税务局的官方导出或截图发给张姐继续建档。' }) : null,
            supported ? jsx('label', { style: labelStyle, children: ['企业全称', jsx('input', {
              style: inputStyle, required: true, maxLength: 200, value: companyName, onChange: event => setCompanyName(event.target.value),
            })] }) : null,
            supported ? jsx('label', { style: labelStyle, children: ['统一社会信用代码', jsx('input', {
              style: inputStyle, required: true, pattern: '[0-9A-Za-z]{18}', value: taxId, onChange: event => setTaxId(event.target.value),
            })] }) : null,
            supported ? jsx('button', { type: 'submit', style: buttonStyle, children: '打开官方扫码页' }) : null,
          ] }) : null,
          busy ? jsx('p', { role: 'status', children: busyText[view.phase] }) : null,
          view.phase === 'waiting' ? jsx('p', { children: '请在打开的官方窗口使用电子税务局 APP 扫码，确认企业后回来读取。' }) : null,
          view.phase === 'waiting' ? jsx('button', { type: 'button', style: buttonStyle, onClick: () => void request('read'), children: '已登录，读取税务资料' }) : null,
          profile ? jsx('section', { 'aria-label': '读取到的企业税务资料', children: [
            jsx('h3', { children: '核对建档资料' }),
            jsx('p', { children: profile.companyName + ' · ' + profile.taxId }),
            jsx('p', { children: '主管税务机关 ' + profile.authority }),
            profile.registrationStatus ? jsx('p', { children: '登记状态 ' + profile.registrationStatus }) : null,
            profile.registrationDate ? jsx('p', { children: '登记日期 ' + profile.registrationDate }) : null,
            profile.taxpayerStatus ? jsx('p', { children: '纳税人状态 ' + profile.taxpayerStatus }) : null,
            profile.taxpayerQualification ? jsx('p', { children: '纳税人资格 ' + profile.taxpayerQualification }) : null,
            profile.obligations.length ? jsx('ul', { children: profile.obligations.map((tax, i) => jsx('li', {
              children: [tax.taxCategory, tax.taxItem, tax.filingCycle, [tax.effectiveFrom, tax.effectiveTo].filter(Boolean).join(' 至 ')].filter(Boolean).join(' · '),
            }, i)) }) : jsx('p', { children: '当前页面没有税费种认定记录。' }),
            jsx('p', { children: '来源 ' + profile.sourceUrl + ' · ' + new Date(profile.observedAt).toLocaleString('zh-CN') }),
            sessionId && view.phase === 'ready' ? jsx('button', { type: 'button', style: buttonStyle, onClick: () => void request('submit'), children: '用这些资料继续建档' }) : null,
            jsx('button', { type: 'button', style: { ...buttonStyle, marginLeft: sessionId ? 8 : 0 }, onClick: () => {
              void Promise.resolve().then(() => window.navigator.clipboard.writeText(JSON.stringify(profile, null, 2)))
                .then(() => setMessage('已复制建档资料。'), () => setMessage('复制失败，请选中资料后手动复制。'))
            }, children: '复制资料' }),
          ] }) : null,
          view.phase === 'submitted' ? jsx('p', { role: 'status', children: '已把核对过的税务资料交给当前对话。' }) : null,
          message || view.message ? jsx('p', { role: 'status', children: message || view.message }) : null,
          jsx('button', { type: 'button', style: { ...buttonStyle, marginTop: 16, background: '#fff' }, onClick: () => setOpen(false), children: '关闭' }),
        ] }) : null,
      ] })
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
      return active ? jsx('span', { style: { display: 'inline-flex', gap: 10, alignItems: 'center' }, children: [jsx(Avatar, {}), jsx(WechatPanel, { sessionId }), jsx(TaxOnboarding, { sessionId })] }) : null
    }

    /** 新会话页也提供微信入口。 */
    function ZhangjieTheme({ sessionId, useSessions }) {
      const active = usePreset(sessionId, useSessions) === PRESET
      useQianlaiTheme(active)
      return active ? jsx('span', { style: { display: 'inline-flex', gap: 10 }, children: [jsx(WechatPanel, { sessionId }), jsx(TaxOnboarding, { sessionId })] }) : null
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
