import { extname, isAbsolute } from 'node:path'

import { type Refusal, refuse } from './period.js'

const PDF_LIMIT = 8 * 1024 * 1024
const USER_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FILE_MENTION = /(?:^|\s)@(?:"([^"\r\n]+)"(?=\s|$)|([^\s"]+))/gu

export interface PdfReferenceSession {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

export interface PdfReferenceEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

export interface PdfReferenceExecution {
  readonly signal: AbortSignal
  readonly callId?: string
  readonly agent?: { readonly session: PdfReferenceSession }
}

export interface PdfReferenceApproval {
  request(request: {
    agent: NonNullable<PdfReferenceExecution['agent']>
    toolName: string
    callId: string
    reason: string
    signal: AbortSignal
  }): Promise<string>
}

interface Target {
  readonly targetKey: string
  readonly displayPath: string
}

interface TargetInfo {
  readonly version: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

export interface PdfReferenceFileSystem {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<Target>
  processPath(target: Target): string
  contains(parent: Target, target: Target): boolean
  stat(target: Target, signal?: AbortSignal): Promise<TargetInfo | undefined>
  readBytes(target: Target, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
}

interface ReferencedPdf {
  readonly accepted: true
  readonly bytes: Uint8Array
}

interface Claim {
  readonly paths: readonly string[]
  attempted: boolean
  pdf?: ReferencedPdf
}

interface Turn {
  readonly number: number
  seq: number
  claim: Claim | undefined
}

interface UserMessage {
  readonly role?: string
  readonly source?: { readonly kind?: string; readonly rpcId?: string }
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
}

function mentionedPdfs(content: UserMessage['content']): string[] {
  const paths = new Set<string>()
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    for (const match of part.text.matchAll(FILE_MENTION)) {
      const path = match[1] ?? match[2]
      if (path && extname(path).toLowerCase() === '.pdf') paths.add(path)
    }
  }
  return [...paths]
}

function isLocalPath(path: string): boolean {
  if (!path || path.includes('"') || /^[\\/]{2}/u.test(path)) return false
  const hasControlCharacter = [...path].some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || (code >= 127 && code <= 159)
  })
  if (hasControlCharacter) return false
  if (process.platform !== 'win32') return !/^[a-z][a-z0-9+.-]*:/iu.test(path)
  // Reject drive-relative paths, device paths, alternate streams and paths relative to the drive root.
  if (/^[\\/]/u.test(path)) return false
  const drive = /^[a-z]:[\\/]/iu.test(path)
  return !path.slice(drive ? 2 : 0).includes(':')
}

function canonicalPath(fs: PdfReferenceFileSystem, target: Target): string | undefined {
  const path = fs.processPath(target)
  return isAbsolute(path) && isLocalPath(path) ? path : undefined
}

async function locatePdf(fs: PdfReferenceFileSystem, cwd: string, path: string, signal: AbortSignal) {
  const workspace = await fs.resolve(cwd, { cwd, signal })
  const target = await fs.resolve(path, { cwd, signal })
  const workspacePath = canonicalPath(fs, workspace)
  const actualPath = canonicalPath(fs, target)
  if (!workspacePath || !actualPath || extname(actualPath).toLowerCase() !== '.pdf')
    return refuse('PDF_REFERENCE_INVALID', '这次只读取本机上的 PDF 文件，请重新选择。')
  const info = await fs.stat(target, signal)
  if (info?.type !== 'file' || info.size === 0)
    return refuse('PDF_REFERENCE_NOT_FOUND', '找不到可读的 PDF，请重新选择文件。')
  if (info.size !== undefined && info.size > PDF_LIMIT)
    return refuse('FILE_TOO_LARGE', '这份 PDF 超过 8 MB，请拆分后再发送。')
  return {
    accepted: true as const, target, workspaceKey: workspace.targetKey, actualPath, workspacePath,
    version: info.version, size: info.size,
    inside: fs.contains(workspace, target),
  }
}

type LocatedPdf = Extract<Awaited<ReturnType<typeof locatePdf>>, { accepted: true }>

function samePdf(before: LocatedPdf, after: Awaited<ReturnType<typeof locatePdf>>): after is LocatedPdf {
  return after.accepted && before.target.targetKey === after.target.targetKey &&
    before.actualPath === after.actualPath && before.version === after.version &&
    before.size === after.size && before.workspaceKey === after.workspaceKey &&
    before.workspacePath === after.workspacePath && before.inside === after.inside
}

/** Borrow a reference only from direct user input observed in this live Session and turn. */
export function createPdfReferences(getFs: () => PdfReferenceFileSystem | undefined) {
  const turns = new WeakMap<PdfReferenceSession, Turn>()

  function observe(session: PdfReferenceSession, event: PdfReferenceEvent): void {
    const turn = turns.get(session)
    if (turn && event.seq <= turn.seq) return
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      const number = (event.data as { turn?: number } | null)?.turn
      if (number === undefined || !Number.isSafeInteger(number)) return
      if (event.type === 'turn/start') turns.set(session, { number, seq: event.seq, claim: undefined })
      else if (turn?.number === number) turns.delete(session)
      return
    }
    if (!turn || event.type !== 'user/message') return
    const user = event.data as UserMessage | null
    if (user?.role !== 'user' || user.source?.kind !== 'user') return
    turn.seq = event.seq
    const rpcId = user.source.rpcId
    turn.claim = !Object.hasOwn(user.source, 'principal') && typeof rpcId === 'string' && USER_REQUEST_ID.test(rpcId)
      ? { paths: mentionedPdfs(user.content), attempted: false }
      : undefined
  }

  async function read(exec: PdfReferenceExecution | undefined, approval: PdfReferenceApproval | undefined): Promise<Refusal | ReferencedPdf> {
    const agent = exec?.agent
    const callId = exec?.callId
    if (!agent || !exec || !callId) return refuse('PDF_REFERENCE_REQUIRED', '请先在当前张姐会话里发送要读取的 PDF。')
    const { session } = agent
    const claim = turns.get(session)?.claim
    const cancelled = () => refuse('PDF_REFERENCE_CANCELLED', '本次 PDF 读取已取消，请重新发送文件。')
    const current = () => !exec.signal.aborted && turns.get(session)?.claim === claim
    if (exec.signal.aborted) return cancelled()
    if (!claim || claim.paths.length === 0) return refuse('PDF_REFERENCE_REQUIRED', '请先在当前对话里添加并发送要读取的 PDF。')
    if (claim.paths.length !== 1) return refuse('PDF_REFERENCE_AMBIGUOUS', '本条消息有多份 PDF，请一次发送一份。')
    if (claim.pdf) return { ...claim.pdf, bytes: claim.pdf.bytes.slice() }
    if (claim.attempted) return refuse('PDF_REFERENCE_ALREADY_CHECKED', '本条 PDF 引用已处理或正在读取，若需重试请重新发送文件。')

    const path = claim.paths[0]!
    const cwd = session.header?.cwd
    if (!cwd || !isAbsolute(cwd) || !isLocalPath(cwd) || !isLocalPath(path))
      return refuse('PDF_REFERENCE_INVALID', '这次只读取本机上的 PDF 文件，请重新选择。')
    const fs = getFs()
    if (!fs) return refuse('PDF_REFERENCE_UNAVAILABLE', '当前 DSH 无法读取路径引用，请在桌面会话重试。')

    claim.attempted = true
    try {
      const selected = await locatePdf(fs, cwd, path, exec.signal)
      if (!current()) return cancelled()
      if (!selected.accepted) return selected
      if (!selected.inside) {
        if (!approval) return refuse('APPROVAL_UNAVAILABLE', '当前 DSH 无法批准读取工作区外的 PDF。')
        const decision = await approval.request({
          agent, callId, toolName: 'moneycome_read_referenced_pdf', signal: exec.signal,
          reason: `读取这份工作区外的 PDF：\n${selected.actualPath}\n批准后，张姐可核对这份文件的内容。`,
        })
        if (!current() || decision === 'cancelled') return cancelled()
        if (decision !== 'allowed-once') return refuse('APPROVAL_REQUIRED', '本次未获准读取工作区外的 PDF。')
      }

      // Recheck path identity on both sides of the bounded host read before releasing any content.
      const beforeRead = await locatePdf(fs, cwd, path, exec.signal)
      if (!current()) return cancelled()
      if (!samePdf(selected, beforeRead))
        return refuse('PDF_REFERENCE_CHANGED', '文件或工作区在读取前发生变化，请重新发送 PDF。')
      const bytes = await fs.readBytes(beforeRead.target, exec.signal, PDF_LIMIT)
      const afterRead = await locatePdf(fs, cwd, path, exec.signal)
      if (!current()) return cancelled()
      if (!samePdf(beforeRead, afterRead) || (afterRead.size !== undefined && bytes.length !== afterRead.size))
        return refuse('PDF_REFERENCE_CHANGED', '文件在读取时发生变化，请重新发送 PDF。')
      if (bytes.length > PDF_LIMIT) return refuse('FILE_TOO_LARGE', '这份 PDF 超过 8 MB，请拆分后再发送。')
      const pdf: ReferencedPdf = { accepted: true, bytes: Uint8Array.from(bytes) }
      claim.pdf = pdf
      return { ...pdf, bytes: pdf.bytes.slice() }
    } catch (error) {
      if (!current()) return cancelled()
      if ((error as { code?: string } | null)?.code === 'FS_TOO_LARGE')
        return refuse('FILE_TOO_LARGE', '这份 PDF 超过 8 MB，请拆分后再发送。')
      return refuse('PDF_REFERENCE_READ_FAILED', '无法读取这份 PDF，请检查文件位置和读取权限。')
    }
  }

  return { observe, read }
}
