/* global window, AbortController, setTimeout, clearTimeout, setInterval, clearInterval */
/**
 * 张姐会话的界面插件（浏览器端）。
 *
 * 当前会话的模式是「钱来张姐」时：
 * - 会话头部加张姐头像；会话头部和新会话页提供微信连接及财务附件入口。
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
    const PDF_LIMIT = 8 * 1024 * 1024
    const buttonStyle = { font: 'inherit', fontSize: 14, border: '1px solid #c4eacf', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', background: '#edf8f1', color: '#1b6f4a' }
    let connection
    let financeUploads

    function WechatPanel({ sessionId }) {
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
          const result = await connection.rpc.call('/api', 'qianlai/wechat', { action, ...(sessionId ? { sessionId } : {}) }, abort.signal)
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
        // Opening "connect" is explicit intent. If already connected, start
        // only attaches this conversation for handoff; it does not reset login.
        void request('start')
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

    function financeUploadSession(services, sessionId) {
      if (!services || services.sessions.subagentAddress(sessionId)) return undefined
      const { byId } = services.sessions.list.getSnapshot()
      if (byId[sessionId]?.projectionValues?.agentPreset !== PRESET) return undefined
      return services.sessions.binding(sessionId)?.session
    }

    function FinanceUploadPanel({ sessionId }) {
      const titleId = useId()
      const helpId = useId()
      const inputId = useId()
      const noteId = useId()
      const dialog = useRef(null)
      const picker = useRef(null)
      const current = useRef(null)
      const [open, setOpen] = useState(false)
      const [file, setFile] = useState(null)
      const [note, setNote] = useState('')
      const [phase, setPhase] = useState('idle')
      const [error, setError] = useState('')

      useEffect(() => {
        if (open) dialog.current?.showModal()
      }, [open])
      useEffect(() => () => {
        current.current?.controller.abort()
        current.current = null
      }, [])

      function close() {
        if (current.current?.submitted) return
        current.current?.controller.abort()
        current.current = null
        dialog.current?.close()
        setOpen(false)
        setFile(null)
        setNote('')
        setPhase('idle')
        setError('')
      }

      function select(files) {
        if (current.current || files.length === 0) return
        const selected = files[0]
        if (files.length !== 1 || !/\.pdf$/i.test(selected.name)) {
          setFile(null)
          setError('请选择一份 PDF 文件。')
          return
        }
        if (selected.size === 0 || selected.size > PDF_LIMIT) {
          setFile(null)
          setError(selected.size === 0 ? '这份 PDF 是空文件，请重新选择。' : '这份 PDF 超过 8 MB，请拆分后再发送。')
          return
        }
        setFile(selected)
        setError('')
      }

      function claimDrop(event) {
        event.preventDefault()
        event.stopPropagation()
      }

      async function send() {
        if (!file || current.current) return
        const services = financeUploads
        const session = financeUploadSession(services, sessionId)
        if (!session) {
          setError('当前张姐会话无法接收附件，请打开或新建一个张姐会话。')
          return
        }
        const attempt = { controller: new AbortController(), submitted: false }
        current.current = attempt
        setPhase('uploading')
        setError('')
        try {
          const header = await file.slice(0, 1024).text()
          if (current.current !== attempt) return
          if (!header.includes('%PDF-')) {
            setError('文件内容不是有效的 PDF，请检查文件后再选择。')
            return
          }
          const uploaded = await services.fileUpload.upload(sessionId, file, file.name, attempt.controller.signal)
          if (current.current !== attempt) return
          if (!uploaded.ok) {
            setError('上传失败，请检查 DSH 连接并重试。')
            return
          }
          if (services !== financeUploads || financeUploadSession(services, sessionId) !== session) {
            setError('会话已变化，请在当前张姐会话中重新选择文件。')
            return
          }
          attempt.submitted = true
          setPhase('sending')
          // A first prompt can unmount the new-session hero before admission returns.
          // Once dispatched, let the host finish the explicitly requested send.
          const result = await session.prompt([
            { type: 'file', receiptId: uploaded.value.receiptId },
            { type: 'text', text: note.trim() || '请读取并核对这份财务材料。' },
          ], 'queue')
          if (current.current !== attempt) return
          if (!result.ok) {
            setError('发送未确认，请先查看会话中是否已收到附件。')
            return
          }
          dialog.current?.close()
          setOpen(false)
          setFile(null)
          setNote('')
        } catch {
          if (current.current === attempt) {
            setError(attempt.submitted ? '发送未确认，请先查看会话中是否已收到附件。' : '无法读取或上传 PDF，请检查文件和连接后重试。')
          }
        } finally {
          if (current.current === attempt) {
            current.current = null
            setPhase('idle')
          }
        }
      }

      const busy = phase !== 'idle'
      return jsx('span', { children: [
        jsx('button', { type: 'button', style: buttonStyle, onClick: () => setOpen(true), children: '上传财务资料' }),
        open ? jsx('dialog', {
          ref: dialog,
          'aria-labelledby': titleId,
          'aria-describedby': helpId,
          onCancel: event => { event.preventDefault(); close() },
          onDragEnter: claimDrop,
          onDragLeave: claimDrop,
          onDragOver: claimDrop,
          onDrop: claimDrop,
          style: { boxSizing: 'border-box', border: '1px solid #c4eacf', borderRadius: 16, padding: 24, width: 'min(420px, calc(100vw - 48px))', color: '#24433a', background: '#fff' },
          children: [
            jsx('h2', { id: titleId, style: { margin: '0 0 12px', fontSize: 20 }, children: '上传财务资料' }),
            jsx('p', { id: helpId, children: '每次发送一份 PDF，最大 8 MB。' }),
            jsx('div', {
              role: 'group',
              'aria-label': 'PDF 拖放区',
              onDragOver: event => {
                claimDrop(event)
                event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
              },
              onDrop: event => {
                claimDrop(event)
                select(event.dataTransfer.files)
              },
              style: { border: '1px dashed #87bfa0', borderRadius: 8, padding: 12 },
              children: [
                jsx('p', { style: { marginTop: 0 }, children: '拖入 PDF 到这里，或选择文件。' }),
                jsx('button', { type: 'button', style: buttonStyle, disabled: busy, 'aria-controls': inputId, onClick: () => picker.current?.click(), children: '选择 PDF' }),
                jsx('input', {
                  ref: picker,
                  id: inputId,
                  type: 'file',
                  accept: '.pdf,application/pdf',
                  'aria-label': '选择 PDF 文件',
                  hidden: true,
                  disabled: busy,
                  onChange: event => {
                    select(event.currentTarget.files)
                    event.currentTarget.value = ''
                  },
                }),
              ],
            }),
            jsx('label', {
              htmlFor: noteId,
              style: { display: 'block', marginTop: 12 },
              children: '给张姐的说明（可选）',
            }),
            jsx('textarea', {
              id: noteId,
              value: note,
              disabled: busy,
              onChange: event => setNote(event.currentTarget.value),
              rows: 2,
              style: { width: '100%', boxSizing: 'border-box', font: 'inherit', resize: 'vertical' },
            }),
            jsx('p', { role: 'status', style: { overflowWrap: 'anywhere' }, children: phase === 'uploading' ? '正在上传…' : phase === 'sending' ? '正在发送…' : file ? `已选：${file.name}` : '' }),
            error ? jsx('p', { role: 'alert', children: error }) : null,
            jsx('div', { style: { display: 'flex', gap: 12 }, children: [
              jsx('button', { type: 'button', style: buttonStyle, disabled: !file || busy, onClick: () => void send(), children: '发送给张姐' }),
              jsx('button', { type: 'button', style: buttonStyle, disabled: phase === 'sending', onClick: close, children: phase === 'uploading' ? '取消上传' : '关闭' }),
            ] }),
          ],
        }) : null,
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
      return active ? jsx(ZhangjieActions, { sessionId, showAvatar: true }) : null
    }

    function ZhangjieTheme({ sessionId, useSessions }) {
      const active = usePreset(sessionId, useSessions) === PRESET
      useQianlaiTheme(active)
      return active ? jsx(ZhangjieActions, { sessionId }) : null
    }

    function ZhangjieActions({ sessionId, showAvatar }) {
      return jsx('span', { style: { display: 'inline-flex', gap: 10, alignItems: 'center' }, children: [
        showAvatar ? jsx(Avatar, {}) : null,
        jsx(WechatPanel, { sessionId }),
        jsx(FinanceUploadPanel, { sessionId }, sessionId),
      ] })
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.inject(['connection'], scope => {
        connection = scope.connection
        scope.effect(() => () => { connection = undefined }, 'dsh-qianlai: connection')
      })
      ctx.inject(['fileUpload', 'sessions'], scope => {
        financeUploads = { fileUpload: scope.fileUpload, sessions: scope.sessions }
        scope.effect(() => () => { financeUploads = undefined }, 'dsh-qianlai: finance upload')
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
