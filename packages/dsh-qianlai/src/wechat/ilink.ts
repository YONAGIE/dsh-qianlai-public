import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

/**
 * 微信 iLink（ClawBot）协议的最小客户端：扫码登录、长轮询收消息、发文本、下载并解密媒体。
 *
 * 官方只公开了扫码三接口，消息结构与媒体加密是 2026-08 抓真实流量得出的；
 * 保活做法沿用钱来内部 demo：客户端超时（40s）长于服务端 hold，超时中断立即重发不算错，
 * 真错误指数退避、不永久放弃，只有 -14 才判 token 失效要重扫。
 */
const ILINK = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = '2.0.1'
const POLL_TIMEOUT_MS = 40_000
const QR_POLL_TIMEOUT_MS = 5_000
const MIN_CYCLE_MS = 1_000
const MESSAGE_TYPE_USER = 1
const ITEM_TYPE_TEXT = 1
const MAX_MEDIA_BYTES = 20 * 1024 * 1024
const mediaTooLarge = () => Object.assign(new Error('微信媒体超过20 MB，请压缩或拆分后再发。'), { code: 'MEDIA_TOO_LARGE' })

export interface IlinkMedia {
  readonly full_url?: string
  readonly aes_key?: string
}

export interface IlinkItem {
  readonly type?: number
  readonly text_item?: { readonly text?: string }
  readonly image_item?: { readonly media?: IlinkMedia; readonly hd_size?: number }
  readonly file_item?: { readonly media?: IlinkMedia; readonly file_name?: string; readonly len?: string | number }
  /** 语音。`text` 是微信给的语音转文字，没转出来时为空（字段名见腾讯 openclaw-weixin 的 VoiceItem）。 */
  readonly voice_item?: { readonly text?: string }
}

export interface IlinkMessage {
  readonly message_type?: number
  readonly from_user_id?: string
  readonly context_token?: string
  readonly msg_id?: string
  readonly item_list?: readonly IlinkItem[]
}

interface IlinkResponse {
  readonly ret?: number
  readonly errcode?: number
  readonly errmsg?: string
  readonly [key: string]: unknown
}

/** 防重放头：随机 uint32 的十进制字符串再 base64，每次请求重新生成。 */
function uin(): string {
  return Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64')
}

function headers(token = ''): Record<string, string> {
  return {
    Authorization: token ? `Bearer ${token}` : '',
    AuthorizationType: 'ilink_bot_token',
    'Content-Type': 'application/json',
    'X-WECHAT-UIN': uin(),
  }
}

/** sendmessage 成功时只回 `{message_id}`，没有 ret；所以只有带了非零码才算失败。 */
const failed = (d: IlinkResponse) => (d.ret !== undefined && d.ret !== 0) || (d.errcode !== undefined && d.errcode !== 0)

type SendOperation = 'sendmessage' | 'getuploadurl' | 'cdn-upload'
type SendFailure = 'http' | 'api' | 'timeout' | 'aborted' | 'network' | 'invalid-response' | 'untrusted-destination'

// Keep only protocol fields that can be logged without exposing credentials or message data.
export class IlinkSendError extends Error {
  constructor(operation: SendOperation, reason: SendFailure, httpStatus?: number, response?: IlinkResponse) {
    const codes = (['ret', 'errcode'] as const).flatMap(key => {
      const value = response?.[key]
      return Number.isSafeInteger(value) ? [`${key}=${value}`] : []
    })
    super([`operation=${operation}`, `reason=${reason}`, ...(httpStatus === undefined ? [] : [`http=${httpStatus}`]), ...codes].join(' '))
  }
}

function sendFailure(error: unknown): SendFailure {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  if (error instanceof SyntaxError) return 'invalid-response'
  return 'network'
}

async function sendRequest(operation: SendOperation, url: string | URL, init: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new IlinkSendError(operation, sendFailure(error))
  }
  if (!response.ok) {
    // iLink can return business codes alongside a failed HTTP status. CDN responses
    // are not part of that JSON protocol.
    const data = operation !== 'cdn-upload' && response.headers.get('content-type')?.includes('json')
      ? await response.json().catch(() => undefined) as IlinkResponse | undefined
      : undefined
    throw new IlinkSendError(operation, 'http', response.status, data)
  }
  return response
}

async function sendResult<T extends IlinkResponse>(operation: SendOperation, response: Response): Promise<T> {
  let data: T
  try {
    data = await response.json() as T
  } catch (error) {
    throw new IlinkSendError(operation, sendFailure(error), response.status)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new IlinkSendError(operation, 'invalid-response', response.status)
  if (failed(data)) throw new IlinkSendError(operation, 'api', response.status, data)
  return data
}

/** 出码：不需要任何凭据，每调一次是一个全新的 bot。`imgUrl` 要自己画成二维码。 */
export async function getBotQrcode(signal?: AbortSignal): Promise<{ qrcode: string; imgUrl: string }> {
  const r = await fetch(`${ILINK}/ilink/bot/get_bot_qrcode?bot_type=3`, { headers: headers(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`get_bot_qrcode HTTP ${r.status}`)
  const d = (await r.json()) as IlinkResponse & { qrcode?: string; qrcode_img_content?: string }
  if (d.ret !== 0 || !d.qrcode || !d.qrcode_img_content) throw new Error(`get_bot_qrcode ret=${d.ret} errmsg=${d.errmsg ?? ''}`)
  return { qrcode: d.qrcode, imgUrl: d.qrcode_img_content }
}

/** `userId` 是扫码那个微信的用户号，和收消息时的 `from_user_id` 是同一套号；旧版服务端可能不给。 */
export type QrStatus = { status: 'wait' | 'scanned' | 'expired' } | { status: 'confirmed'; botToken: string; botId: string; userId?: string }

export async function pollQrStatus(qrcode: string, signal?: AbortSignal): Promise<QrStatus> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), QR_POLL_TIMEOUT_MS)
  try {
    const r = await fetch(`${ILINK}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      headers: { ...headers(), 'iLink-App-ClientVersion': '1' },
      signal: signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal,
    })
    if (!r.ok) throw new Error(`get_qrcode_status HTTP ${r.status}`)
    const d = (await r.json()) as IlinkResponse & { status?: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string }
    if (d.status === 'confirmed' && d.bot_token)
      return {
        status: 'confirmed',
        botToken: d.bot_token,
        botId: d.ilink_bot_id ?? '',
        ...(d.ilink_user_id ? { userId: d.ilink_user_id } : {}),
      }
    return { status: d.status === 'expired' ? 'expired' : d.status === 'scanned' ? 'scanned' : 'wait' }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { status: 'wait' }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export interface ConnectionHooks {
  readonly initialCursor?: string
  /** 整批消息处理完才回调，崩溃重启从未确认的 cursor 重收，不丢消息。 */
  onCursor?(cursor: string): void
  onExpired?(): void
  /** Long-poll failures that are not the normal client-side timeout. */
  onPollError?(message: string, consecutive: number): void
  /** Called when a valid long-poll response recovers after poll failures. */
  onPollRecovered?(): void
  onError?(message: string, consecutive: number): void
}

/** 一个已绑定 bot 的长连接。 */
export class IlinkConnection {
  private polling = false
  private ctl: AbortController | undefined
  private cursor: string | undefined
  private wake: (() => void) | undefined

  constructor(
    private readonly botToken: string,
    private readonly handler: (message: IlinkMessage) => Promise<void>,
    private readonly hooks: ConnectionHooks = {},
  ) {
    this.cursor = hooks.initialCursor
  }

  start(): void {
    if (this.polling) return
    this.polling = true
    void this.loop()
  }

  stop(): void {
    this.polling = false
    this.ctl?.abort()
    this.wake?.()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  private async loop(): Promise<void> {
    let errors = 0
    let pollErrors = 0
    while (this.polling) {
      const ctl = new AbortController()
      this.ctl = ctl
      const timer = setTimeout(() => ctl.abort(), POLL_TIMEOUT_MS)
      const start = Date.now()
      let pollSucceeded = false
      try {
        const r = await fetch(`${ILINK}/ilink/bot/getupdates`, {
          method: 'POST',
          headers: headers(this.botToken),
          body: JSON.stringify({
            base_info: { channel_version: CHANNEL_VERSION },
            ...(this.cursor ? { get_updates_buf: this.cursor } : {}),
          }),
          signal: ctl.signal,
        })
        if (!r.ok) throw new Error(`getupdates HTTP ${r.status}`)
        const d = (await r.json()) as IlinkResponse & { msgs?: IlinkMessage[]; get_updates_buf?: string }
        clearTimeout(timer)
        if (d.ret === -14 || d.errcode === -14) {
          this.polling = false
          this.hooks.onExpired?.()
          break
        }
        if (failed(d)) throw new Error(`getupdates ret=${d.ret} errcode=${d.errcode} ${d.errmsg ?? ''}`)
        pollSucceeded = true
        if (pollErrors > 0) this.hooks.onPollRecovered?.()
        pollErrors = 0
        const msgs = d.msgs ?? []
        for (const m of msgs) {
          if (!this.polling) break
          if (m.message_type !== MESSAGE_TYPE_USER) continue
          // A failed message leaves the entire batch unacknowledged. The channel
          // uses message identity to skip successfully admitted replays.
          await this.handler(m)
        }
        if (!this.polling) break
        if (d.get_updates_buf) {
          this.hooks.onCursor?.(d.get_updates_buf)
          this.cursor = d.get_updates_buf
        }
        errors = 0
        const elapsed = Date.now() - start
        if (!msgs.length && elapsed < MIN_CYCLE_MS && this.polling) await this.sleep(MIN_CYCLE_MS - elapsed)
      } catch (error) {
        clearTimeout(timer)
        if (!this.polling) break
        // 超时中断是长轮询的正常现象，立即重发。
        if (error instanceof Error && error.name === 'AbortError') continue
        errors += 1
        const message = error instanceof Error ? error.message : String(error)
        this.hooks.onError?.(message, errors)
        if (!pollSucceeded) {
          pollErrors += 1
          this.hooks.onPollError?.(message, pollErrors)
        }
        if (!this.polling) break
        await this.sleep(Math.min(3000 * 2 ** (errors - 1), 60_000))
      }
    }
  }

  async sendText(toUserId: string, contextToken: string | undefined, text: string, clientId = `mc-${randomUUID()}`): Promise<void> {
    const r = await sendRequest('sendmessage', `${ILINK}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: headers(this.botToken),
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          ...(contextToken ? { context_token: contextToken } : {}),
          item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
    })
    await sendResult('sendmessage', r)
  }

  /** Sends only a caller-selected bundled image; no remote URL or arbitrary file access. */
  async sendImage(toUserId: string, contextToken: string | undefined, bytes: Buffer, clientId: string): Promise<void> {
    const key = randomBytes(16)
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
    const filekey = randomBytes(16).toString('hex')
    const response = await sendRequest('getuploadurl', `${ILINK}/ilink/bot/getuploadurl`, {
      method: 'POST', headers: headers(this.botToken), signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ filekey, media_type: 1, to_user_id: toUserId, rawsize: bytes.length,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'), filesize: encrypted.length,
        no_need_thumb: true, aeskey: key.toString('hex'), base_info: { channel_version: CHANNEL_VERSION } }),
    })
    const data = await sendResult<IlinkResponse & { upload_full_url?: string; upload_param?: string }>('getuploadurl', response)
    if (!data.upload_full_url && !data.upload_param) throw new IlinkSendError('getuploadurl', 'invalid-response', response.status)
    const uploadUrl = data.upload_full_url || `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(data.upload_param!)}&filekey=${filekey}`
    const url = URL.parse(uploadUrl)
    if (!url) throw new IlinkSendError('getuploadurl', 'invalid-response', response.status)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password)
      throw new IlinkSendError('getuploadurl', 'untrusted-destination', response.status)
    const uploaded = await sendRequest('cdn-upload', url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(encrypted), signal: AbortSignal.timeout(30_000) })
    const parameter = uploaded.headers.get('x-encrypted-param')
    if (uploaded.status !== 200 || !parameter) throw new IlinkSendError('cdn-upload', 'invalid-response', uploaded.status)
    const sent = await sendRequest('sendmessage', `${ILINK}/ilink/bot/sendmessage`, {
      method: 'POST', headers: headers(this.botToken), signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ msg: { from_user_id: '', to_user_id: toUserId, client_id: clientId,
        message_type: 2, message_state: 2, ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: parameter,
          aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, mid_size: encrypted.length } }],
      }, base_info: { channel_version: CHANNEL_VERSION } }),
    })
    await sendResult('sendmessage', sent)
  }

  /** 「对方正在输入」，尽力而为，失败不影响回复。 */
  async sendTyping(toUserId: string, contextToken: string | undefined): Promise<void> {
    await fetch(`${ILINK}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: headers(this.botToken),
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ to_user_id: toUserId, context_token: contextToken, base_info: { channel_version: CHANNEL_VERSION } }),
    }).catch(() => undefined)
  }
}

/**
 * 下载并解密一份媒体。CDN 下发的是 AES-128-ECB 密文：`aes_key` base64 解出 32 个十六进制字符，
 * 再按 hex 解成 16 字节做密钥。下载不需要 bot token。
 */
export async function downloadMedia(media: IlinkMedia, declaredLength?: number): Promise<Buffer> {
  if (!media.full_url || !media.aes_key) throw new Error('media has no url or key')
  if (declaredLength !== undefined && declaredLength > MAX_MEDIA_BYTES) throw mediaTooLarge()
  const r = await fetch(media.full_url, { signal: AbortSignal.timeout(30_000) })
  if (!r.ok) {
    await r.body?.cancel().catch(() => undefined)
    throw new Error(`media download HTTP ${r.status}`)
  }
  // AES-ECB with PKCS#7 adds at most one 16-byte block. Neither a missing
  // Content-Length nor an understated one may bypass the actual byte budget.
  const cipherLimit = MAX_MEDIA_BYTES + 16
  if (Number(r.headers.get('content-length')) > cipherLimit) {
    await r.body?.cancel().catch(() => undefined)
    throw mediaTooLarge()
  }
  const reader = r.body?.getReader()
  if (!reader) throw new Error('media download has no body')
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cipherLimit) throw mediaTooLarge()
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
  const cipher = Buffer.concat(chunks, total)
  const key = Buffer.from(Buffer.from(media.aes_key, 'base64').toString('latin1'), 'hex')
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()])
  if (plain.length > MAX_MEDIA_BYTES) throw mediaTooLarge()
  return declaredLength && declaredLength > 0 && declaredLength <= plain.length ? plain.subarray(0, declaredLength) : plain
}

/** 按文件头认图片格式；认不出返回 undefined。 */
export function imageMediaType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png'
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}
