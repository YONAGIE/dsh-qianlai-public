/* global window, AbortController, setTimeout, clearTimeout, setInterval, clearInterval */
/**
 * 张姐会话的界面插件（浏览器端）。
 *
 * 当前会话的模式是「钱来张姐」时：
 * - 会话头部加一个张姐头像和微信连接入口；新会话页也可以直接扫码接入。
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
    const AVATAR = '__AVATAR_DATA_URL__'
    const buttonStyle = { font: 'inherit', fontSize: 14, border: '1px solid #c4eacf', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', background: '#edf8f1', color: '#1b6f4a' }
    let connection

    function WechatPanel() {
      const titleId = useId()
      const [open, setOpen] = useState(false)
      const [state, setState] = useState({ status: 'disconnected' })
      const dialog = useRef(null)
      const control = useRef(null)
      const sequence = useRef(0)
      const labels = { disconnected: '微信尚未连接', loading: '正在获取二维码…', waiting: '等待微信扫码', scanned: '已扫码，请在微信确认', connected: '微信已连接', expired: '二维码已过期', error: '连接未完成' }
      const request = async action => {
        if (action === 'status' && control.current) return
        const version = ++sequence.current
        control.current?.abort()
        const abort = new AbortController()
        control.current = abort
        const timer = setTimeout(() => abort.abort(), 15000)
        try {
          if (!connection) throw Error('微信接入服务尚未就绪，请稍后重试。')
          const result = await connection.rpc.call('/api', 'qianlai/wechat', { action }, abort.signal)
          if (version !== sequence.current || abort.signal.aborted) return
          if (!result.ok) throw Error(result.error.message)
          setState(result.value)
        } catch (error) {
          if (version === sequence.current) setState({ status: 'error', message: error.message || '请求失败，请重试。' })
        } finally { clearTimeout(timer); if (version === sequence.current) control.current = null }
      }
      useEffect(() => {
        if (!open) return undefined
        dialog.current?.showModal()
        void request('status')
        const timer = setInterval(() => void request('status'), 2000)
        return () => { clearInterval(timer); sequence.current++; control.current?.abort(); control.current = null }
      }, [open])
      return jsx('span', { children: [
        jsx('button', { type: 'button', onClick: () => setOpen(true), style: { border: '1px solid #c4eacf', borderRadius: 8, padding: '5px 10px', color: '#1b6f4a', background: '#edf8f1', cursor: 'pointer' }, children: '连接微信' }),
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
      return active ? jsx('span', { style: { display: 'inline-flex', gap: 10, alignItems: 'center' }, children: [jsx(Avatar, {}), jsx(WechatPanel, {})] }) : null
    }

    /** 新会话页也提供微信入口。 */
    function ZhangjieTheme({ sessionId, useSessions }) {
      const active = usePreset(sessionId, useSessions) === PRESET
      useQianlaiTheme(active)
      return active ? jsx(WechatPanel, {}) : null
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
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
