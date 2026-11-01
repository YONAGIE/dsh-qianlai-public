import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type * as QRCodeType from 'qrcode'

import { downloadMedia, getBotQrcode, IlinkConnection, imageMediaType, pollQrStatus, type IlinkMessage } from './ilink.js'
import { registerLoginControl, registerLoginRpc, type LoginControl, type LoginView, type RpcConnection } from './control.js'

// Windows 受限安装可能生成 Node 未识别的 Global junction；先取得原生真实路径，
// 让 qrcode 的间接依赖从实际包目录解析。正常目录和其他系统沿用同一个库。
const require = createRequire(import.meta.url)
const QRCode = require(realpathSync.native(require.resolve('qrcode'))) as typeof QRCodeType

/**
 * 微信薄通道：把一个扫码绑定的微信 bot 接到张姐会话上。
 *
 * 只做三件事：扫码登录；老板发来的文字、图片、文件原样交给张姐会话；张姐这一轮说完的最后一段话
 * 转成纯文本发回微信。账怎么记、票怎么核全在张姐会话里，和网页里是同一本账、同一套工具。
 *
 * 宿主层插件，预设默认按需扫码；`MONEYCOME_WECHAT=1` 保留启动时自动扫码。
 */
export const inject = ['sessionController']

export interface Config {
  /** 状态文件目录，默认 `$DSH_HOME/moneycome`。 */
  readonly stateDir?: string
  readonly agentPreset?: string
  readonly autoStart?: boolean
}

interface State {
  botToken?: string
  cursor?: string
  /** 扫码登录的那个微信就是老板；服务端没给扫码人时，第一个发消息的人是老板。重新扫码登录时保留。 */
  ownerUserId?: string
  contextToken?: string
  sessionId?: string
  welcomePending?: boolean
  welcomeProgress?: number
  welcomeId?: string
}

type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'file'; receiptId: string }

/** 从微信消息里取出来、还没交给会话的内容。文件要先上传到会话才拿得到 receiptId。 */
type Incoming = Exclude<PromptPart, { type: 'file' }> | { type: 'fileBytes'; name: string; bytes: Buffer }

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** DSH 的 RemoteError 按 `code` 区分；会话被删了是 `session/not-found`。 */
const sessionGone = (error: unknown) => (error as { code?: unknown } | null)?.code === 'session/not-found'

interface SessionEventLike {
  readonly type: string
  readonly data?: {
    readonly turn?: number
    readonly source?: { readonly rpcId?: unknown }
    readonly message?: { readonly content?: readonly { readonly type: string; readonly text?: string }[] }
    readonly reason?: { readonly kind?: string }
  }
}

interface Context {
  effect(fn: () => () => void): void
  on(event: 'session/event', listener: (session: { id: string }, event: SessionEventLike) => void): () => void
  get(name: string): unknown
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
  sessionController: {
    create(request: { agentPreset: string; cwd: string }): Promise<{ sessionId: string }>
    prompt(
      request: { sessionId: string; requestId: string; mode: 'queue'; content: PromptPart[]; clientTimeZone?: string },
      signal: AbortSignal,
    ): Promise<unknown>
  }
}

interface FileUploads {
  uploadStream(request: { sessionId: string; data: AsyncIterable<Uint8Array>; name?: string }): Promise<{ receiptId: string }>
}

/** 单条微信消息的字数上限取保守值，超了按段落拆成几条发。 */
const MAX_WECHAT_CHARS = 1500

/**
 * Markdown 转微信纯文本：去掉粗体、标题号、行内代码，表格改成一行一条、格子用「｜」隔开。
 * 微信不渲染 Markdown，原样发过去满屏是星号和竖线。
 */
export function toWechatText(markdown: string): string {
  const lines: string[] = []
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd()
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue
    if (/^\s*\|.*\|\s*$/.test(line)) {
      lines.push(
        line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
          .join('｜'),
      )
      continue
    }
    lines.push(line.replace(/^#{1,6}\s+/, ''))
  }
  return lines
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按段落拆成不超过上限的几段。 */
export function splitForWechat(text: string, limit = MAX_WECHAT_CHARS): string[] {
  const chunks: string[] = []
  let current = ''
  for (const paragraph of text.split('\n\n')) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph
    if (next.length <= limit) {
      current = next
      continue
    }
    if (current) chunks.push(current)
    current = paragraph
    while (current.length > limit) {
      chunks.push(current.slice(0, limit))
      current = current.slice(limit)
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export function apply(ctx: Context, config: Config = {}): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const stateDir = config.stateDir ?? join(home, 'moneycome')
  const statePath = join(stateDir, 'wechat.json')
  const workspace = join(stateDir, 'wechat-workspace')
  const agentPreset = config.agentPreset ?? 'moneycome-zhangjie'
  // 收发都记一行到 wechat.log（只记事件与条数，不记消息内容），同时交给 DSH 的 logger。
  const logPath = join(stateDir, 'wechat.log')
  const line = (level: string, message: string) => {
    try {
      mkdirSync(stateDir, { recursive: true })
      appendFileSync(logPath, `${new Date().toISOString()} ${level} ${message}\n`)
    } catch {
      // 日志写不进去不影响收发；DSH 的 logger 仍有一份。
    }
  }
  const log = {
    info: (m: string) => (line('info', m), ctx.logger.info(m)),
    warn: (m: string) => (line('warn', m), ctx.logger.warn(m)),
    error: (m: string) => (line('error', m), ctx.logger.error(m)),
  }

  const load = (): State => (existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as State) : {})
  let state = load()
  // 状态里有 bot token，只给本机用户读写。
  const save = () => {
    mkdirSync(stateDir, { recursive: true })
    const temporary = `${statePath}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(temporary, statePath)
    chmodSync(statePath, 0o600)
  }

  ctx.effect(() => {
    let stopped = false
    let connection: IlinkConnection | undefined
    const abort = new AbortController()
    let loginAbort: AbortController | undefined
    let generation = 0
    let view: LoginView = { status: state.botToken ? 'connected' : 'disconnected' }
    let welcomeRunning = false
    /** 等回复的 turn：turn 号 → 这一轮里收集到的最后一段话。 */
    const turns = new Map<number, { text: string; typing: NodeJS.Timeout }>()
    const pendingRequests = new Set<string>()
    let lastTurnStart = 0

    const welcome = async () => {
      if (!state.welcomePending || welcomeRunning || !connection || !state.ownerUserId || stopped) return
      welcomeRunning = true
      const target = connection
      const owner = state.ownerUserId
      try {
        if ((state.welcomeProgress ?? 0) === 0) {
          let summary = ''
          const book = join(stateDir, 'book.sqlite')
          if (existsSync(book)) {
            const { BookStore } = await import('../store.js')
            const store = new BookStore(book)
            try {
              const recent = store.workEvents(undefined, 5).filter(event => Date.now() - Date.parse(event.createdAt) < 7 * 86400_000)
              const labels: Record<string, string> = { material: '读取业务材料', note: '保存待核实的业务笔记', moneycome_check_invoice: '核对发票', moneycome_record_entry: '处理凭证', moneycome_import_statement: '导入银行流水', moneycome_close_period: '结账', moneycome_open_book: '建立账本', moneycome_set_opening_balances: '录入期初余额' }
              if (recent.length) {
                const latest = recent[0]!
                const action = latest.request.preview === true ? '凭证预演（尚未记账）' : labels[latest.operation] ?? '更新业务记录'
                summary = `\n这台电脑的账本近期有业务记录，最近一项是${action}，时间为 ${latest.createdAt}。您可以说“继续刚才的事”，我会先核对同一本账的当前进度和待确认事项。`
              }
            } finally { store.close() }
          }
          await target.sendText(owner, state.contextToken,
            '您好，我是钱来张姐，AI 财务助手。您可以发票据、Excel/PDF 流水，或询问本机账本；记账前会请您确认。\n可在这个机器人的聊天资料中查看是否有备注和头像设置项；若有，可把机器人备注为“钱来张姐”，长按下面图片保存后选用。不同微信版本支持情况不同，请勿修改您本人的头像或昵称；我不能代改微信资料。' + summary, `mc-welcome-${state.welcomeId}-intro`)
          if (stopped || connection !== target) return
          state.welcomeProgress = 1
          save()
        }
        const assets = ['avatar.png', 'welcome.png', 'reassure.png']
        for (let i = (state.welcomeProgress ?? 1) - 1; i < assets.length; i++) {
          if (stopped || connection !== target) return
          const bytes = readFileSync(fileURLToPath(new URL(`../../assets/zhangjie/${assets[i]}`, import.meta.url)))
          await target.sendImage(owner, state.contextToken, bytes, `mc-welcome-${state.welcomeId}-${i}`)
          if (stopped || connection !== target) return
          state.welcomeProgress = i + 2
          save()
        }
        state.welcomePending = false
        save()
      } catch {
        // Some iLink deployments need an inbound context token. Retry the unsent step after the owner's first message.
        log.warn('moneycome-wechat: welcome delivery incomplete; will resume on the next owner message')
      } finally { welcomeRunning = false }
    }

    const reply = async (text: string) => {
      if (!connection || !state.ownerUserId) return
      for (const chunk of splitForWechat(toWechatText(text))) {
        try {
          await connection.sendText(state.ownerUserId, state.contextToken, chunk)
        } catch (error) {
          log.error(`moneycome-wechat: send failed: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }
      log.info(`moneycome-wechat: replied ${text.length} chars`)
    }

    const offEvents = ctx.on('session/event', (session, event) => {
      if (session.id !== state.sessionId) return
      const data = event.data ?? {}
      if (event.type === 'turn/start' && typeof data.turn === 'number') lastTurnStart = data.turn
      if (event.type === 'user/message' && typeof data.source?.rpcId === 'string' && pendingRequests.delete(data.source.rpcId)) {
        if (!turns.has(lastTurnStart)) {
          const typing = setInterval(() => void connection?.sendTyping(state.ownerUserId!, state.contextToken), 15_000)
          turns.set(lastTurnStart, { text: '', typing })
        }
      }
      const pending = typeof data.turn === 'number' ? turns.get(data.turn) : undefined
      if (!pending) return
      if (event.type === 'assistant/message') {
        const text = (data.message?.content ?? [])
          .filter((c) => c.type === 'text' && c.text?.trim())
          .map((c) => c.text!)
          .join('\n')
        if (text) pending.text = text
      }
      if (event.type === 'turn/end') {
        clearInterval(pending.typing)
        turns.delete(data.turn!)
        const completed = data.reason?.kind === 'completed'
        void reply(
          pending.text && completed
            ? pending.text
            : pending.text || '刚才这一步没做完，您再说一次，或者换个说法试试。',
        )
      }
    })

    const ensureSession = async (fresh = false): Promise<string> => {
      if (state.sessionId && !fresh) return state.sessionId
      mkdirSync(workspace, { recursive: true })
      const created = await ctx.sessionController.create({ agentPreset, cwd: workspace })
      state.sessionId = created.sessionId
      save()
      log.info(`moneycome-wechat: session ${created.sessionId}`)
      return created.sessionId
    }

    /**
     * 先把消息里的东西都取下来，再碰会话：图片、文件下载失败是网络问题，和会话无关，
     * 告诉老板重发就行，不能因此换一个新会话。
     */
    const collect = async (message: IlinkMessage) => {
      const items: Incoming[] = []
      const notReceived = new Set<string>()
      let voiceWithoutText = false
      let unsupported = false
      for (const item of message.item_list ?? []) {
        if (item.text_item?.text?.trim()) items.push({ type: 'text', text: item.text_item.text.trim() })
        else if (item.voice_item) {
          const text = item.voice_item.text?.trim()
          if (text) items.push({ type: 'text', text: `（老板发的语音，微信转成的文字）${text}` })
          else voiceWithoutText = true
        } else if (item.image_item?.media) {
          try {
            const bytes = await downloadMedia(item.image_item.media, item.image_item.hd_size)
            const mediaType = imageMediaType(bytes)
            if (mediaType) items.push({ type: 'image', mediaType, data: bytes.toString('base64') })
            else items.push({ type: 'text', text: '（老板发来一张图片，但格式认不出来。）' })
          } catch (error) {
            log.warn(`moneycome-wechat: image download failed: ${errorMessage(error)}`)
            notReceived.add('图片')
          }
        } else if (item.file_item?.media) {
          const name = item.file_item.file_name ?? 'file'
          try {
            items.push({ type: 'fileBytes', name, bytes: await downloadMedia(item.file_item.media, Number(item.file_item.len ?? 0)) })
          } catch (error) {
            log.warn(`moneycome-wechat: file download failed: ${errorMessage(error)}`)
            notReceived.add(`文件「${name}」`)
          }
        } else unsupported = true
      }
      const notes: string[] = []
      if (notReceived.size) notes.push(`刚才的${[...notReceived].join('和')}没收到，可能是网络断了一下，麻烦再发一次。`)
      if (voiceWithoutText) notes.push('这条语音微信没转出文字，麻烦打字说，或者发截图。')
      if (unsupported) notes.push('视频这类消息我看不了，麻烦打字，或者发截图、文件。')
      return { items, notes }
    }

    const toParts = async (items: readonly Incoming[], sessionId: string): Promise<PromptPart[]> => {
      const parts: PromptPart[] = []
      for (const item of items) {
        if (item.type !== 'fileBytes') {
          parts.push(item)
          continue
        }
        const uploads = ctx.get('fileUploads') as FileUploads | undefined
        if (!uploads) {
          parts.push({ type: 'text', text: `（老板发来文件「${item.name}」，但这里收不了文件。）` })
          continue
        }
        const receipt = await uploads.uploadStream({
          sessionId,
          name: item.name,
          data: (async function* () {
            yield new Uint8Array(item.bytes)
          })(),
        })
        parts.push({ type: 'file', receiptId: receipt.receiptId })
      }
      return parts
    }

    const onMessage = async (message: IlinkMessage) => {
      const from = message.from_user_id
      if (!from) return
      if (!state.ownerUserId) {
        state.ownerUserId = from
        log.info('moneycome-wechat: bound owner')
      }
      if (from !== state.ownerUserId) {
        log.warn('moneycome-wechat: ignored a message from someone other than the bound owner')
        return
      }
      if (message.context_token) state.contextToken = message.context_token
      save()
      void welcome()
      void connection?.sendTyping(from, state.contextToken)
      const { items, notes } = await collect(message)
      if (notes.length) await reply(notes.join('\n'))
      if (!items.length) return
      const send = async (sessionId: string) => {
        const content = await toParts(items, sessionId)
        const requestId = randomUUID()
        pendingRequests.add(requestId)
        await ctx.sessionController.prompt(
          { sessionId, requestId, mode: 'queue', content, clientTimeZone: 'Asia/Shanghai' },
          abort.signal,
        )
        log.info(`moneycome-wechat: prompt ${content.map((p) => p.type).join('+')}`)
      }
      try {
        try {
          await send(await ensureSession())
        } catch (error) {
          // 只有存着的会话被删了才开新会话；别的错误换会话也没用，还会把之前的对话丢掉。
          if (!sessionGone(error)) throw error
          log.warn(`moneycome-wechat: session gone, starting a new one: ${errorMessage(error)}`)
          await send(await ensureSession(true))
        }
      } catch (error) {
        log.error(`moneycome-wechat: prompt failed: ${errorMessage(error)}`)
        await reply('我这边出了点问题，这条没收到，您稍后再发一次。')
      }
    }

    const connect = (botToken: string) => {
      connection?.stop()
      view = { status: 'connected', message: '微信已连接。若微信还没有欢迎消息，请先发一句“你好”，取得消息上下文后会补发。' }
      connection = new IlinkConnection(botToken, onMessage, {
        ...(state.cursor ? { initialCursor: state.cursor } : {}),
        onCursor(cursor) {
          state.cursor = cursor
          save()
        },
        onExpired() {
          log.warn('moneycome-wechat: login expired, scan again')
          // 登录凭据作废，老板和会话留着：重新扫码后还是同一个老板、接着同一段对话。
          state = {
            ...(state.ownerUserId ? { ownerUserId: state.ownerUserId } : {}),
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
            ...(state.welcomePending !== undefined ? { welcomePending: state.welcomePending, welcomeProgress: state.welcomeProgress, welcomeId: state.welcomeId } : {}),
          }
          save()
          view = { status: 'expired', message: '微信登录已过期，请重新获取二维码。' }
          if (config.autoStart !== false) void login()
        },
        onError(message, consecutive) {
          log.warn(`moneycome-wechat: ${message} (consecutive ${consecutive})`)
        },
      })
      connection.start()
      log.info('moneycome-wechat: connected')
      void welcome()
    }

    const login = async () => {
      const current = ++generation
      loginAbort?.abort()
      const controller = new AbortController()
      loginAbort = controller
      view = { status: 'loading' }
      try {
        const { qrcode, imgUrl } = await getBotQrcode(controller.signal)
        const qrDataUrl = await QRCode.toDataURL(imgUrl, { width: 360, margin: 1 })
        if (stopped || current !== generation) return
        view = { status: 'waiting', qrDataUrl, requestedAt: new Date().toISOString(), message: '请用本人微信扫描并确认。有效期以微信返回状态为准。' }
        const png = join(stateDir, 'wechat-login.png')
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(png, Buffer.from(qrDataUrl.split(',')[1]!, 'base64'), { mode: 0o600 })
        const terminal = await QRCode.toString(imgUrl, { type: 'terminal', small: true })
        process.stdout.write(`\n用微信扫下面的二维码，把张姐接到微信上（二维码图片也存在 ${png}）：\n${terminal}\n`)
        while (!stopped && current === generation) {
          const status = await pollQrStatus(qrcode, controller.signal)
          if (stopped || current !== generation) return
          if (status.status === 'confirmed') {
            if (state.ownerUserId && status.userId && state.ownerUserId !== status.userId) {
              view = { status: 'error', message: '扫码微信与已绑定账户不一致。为保护原账本，请使用原微信重新扫码。' }
              return
            }
            const firstBinding = !state.ownerUserId
            state.botToken = status.botToken
            delete state.cursor
            delete state.contextToken
            if (status.userId) state.ownerUserId = status.userId
            if (firstBinding && !state.welcomeId) {
              state.welcomeId = randomUUID()
              state.welcomePending = true
              state.welcomeProgress = 0
            }
            save()
            process.stdout.write('微信已接上。用这个微信给张姐发一句话，她就能回你。\n')
            connect(status.botToken)
            return
          }
          if (status.status === 'expired') {
            view = { status: 'expired', message: '二维码已过期，请重新获取。' }
            return
          }
          view = { ...view, status: status.status === 'scanned' ? 'scanned' : 'waiting' }
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }
            const timer = setTimeout(done, 1000)
            controller.signal.addEventListener('abort', done, { once: true })
            if (controller.signal.aborted) done()
          })
        }
      } catch {
        if (!stopped && current === generation) view = { status: 'error', message: '微信二维码获取失败，请重试。' }
      }
    }
    const control: LoginControl = {
      async run(action) {
        if (stopped) return { status: 'error', message: '微信服务已停止，请重新加载插件。' }
        if (action !== 'status' && view.status !== 'connected') {
          if (action === 'refresh' || !['loading', 'waiting', 'scanned'].includes(view.status)) void login()
        }
        return { ...view }
      },
    }
    const offControl = registerLoginControl(stateDir, control)
    const rpc = ctx.get('connection') as RpcConnection | undefined
    let offRpc: ReturnType<typeof registerLoginRpc> | undefined
    try { offRpc = rpc ? registerLoginRpc(rpc, control) : undefined }
    catch (error) { offControl(); offEvents(); throw error }
    if (state.botToken) connect(state.botToken)
    else if (config.autoStart !== false) void login()

    return () => {
      stopped = true
      generation++
      loginAbort?.abort()
      offControl()
      void offRpc?.()
      abort.abort()
      connection?.stop()
      offEvents()
      for (const pending of turns.values()) clearInterval(pending.typing)
    }
  })
}
