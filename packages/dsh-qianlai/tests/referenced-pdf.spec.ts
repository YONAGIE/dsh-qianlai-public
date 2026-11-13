import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { PermissionPresets } from '../src/permissions.js'
import {
  createPdfReferences,
  type PdfReferenceApproval,
  type PdfReferenceEvent,
  type PdfReferenceFileSystem,
  type PdfReferenceSession,
} from '../src/referenced-pdf.js'

const CWD = resolve('finance-workspace')
const PDF = Uint8Array.from(Buffer.from('%PDF-1.7\nsynthetic'))
const RPC_ID = 'd4383afc-d384-4b09-9d8b-663d9ae7b3fc'
const PDF_LIMIT = 8 * 1024 * 1024
const OUTSIDE = resolve('synthetic-external', '合成 材料.PDF')

const fullAccess: PermissionPresets = {
  current: () => 'danger-full-access',
  resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }),
}

function setup() {
  let sequence = 0
  const session: PdfReferenceSession = { id: 'session-1', header: { cwd: CWD } }
  const signal = new AbortController()
  const execution = { agent: { session }, callId: 'call-1', signal: signal.signal }
  const file = { bytes: PDF, version: '1', path: undefined as string | undefined }
  const fs = {
    resolve: vi.fn(async (path: string, options?: { cwd?: string }) => {
      const targetKey = path === CWD ? CWD : file.path ?? resolve(options?.cwd ?? CWD, path)
      return { targetKey, displayPath: targetKey }
    }),
    processPath: (target) => target.targetKey,
    contains: (root, target) => {
      const path = relative(root.targetKey, target.targetKey)
      return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
    },
    stat: vi.fn<PdfReferenceFileSystem['stat']>(async () => ({ type: 'file', version: file.version, size: file.bytes.length })),
    readBytes: vi.fn<PdfReferenceFileSystem['readBytes']>(async () => file.bytes),
  } satisfies PdfReferenceFileSystem
  // Cordis can return a new service proxy for the same underlying filesystem.
  const refs = createPdfReferences(() => new Proxy(fs, {}))
  const approve = vi.fn<PdfReferenceApproval['request']>(async () => 'allowed-once')
  const approval = { request: approve }
  const observe = (type: string, data: unknown, target = session) => {
    const event: PdfReferenceEvent = { type, data, seq: sequence++ }
    refs.observe(target, event)
  }
  const user = (text: string, rpcId = RPC_ID, kind = 'user') => observe('user/message', {
    role: 'user', source: { kind, rpcId }, content: [{ type: 'text', text }],
  })
  const start = (turn = 1) => observe('turn/start', { turn })
  return { refs, execution, fs, file, session, signal, approve, approval, observe, user, start }
}

describe('native PDF reference authorization', () => {
  it('reads the sole current in-workspace PDF and reuses a defensive snapshot without reopening the file', async () => {
    const { refs, execution, fs, approval, approve, start, user } = setup()
    start()
    user('请读一下 @"资料 合成.PDF"')
    const first = await refs.read(execution, approval)
    expect(first).toMatchObject({ accepted: true, bytes: PDF, fileIndex: 1, fileCount: 1 })
    if (first.accepted) first.bytes[0] = 0
    expect(await refs.read(execution, approval)).toMatchObject({ accepted: true, bytes: PDF })
    expect(approve).not.toHaveBeenCalled()
    expect(fs.readBytes).toHaveBeenCalledTimes(1)
    expect(fs.readBytes).toHaveBeenCalledWith(
      { targetKey: join(CWD, '资料 合成.PDF'), displayPath: join(CWD, '资料 合成.PDF') },
      execution.signal,
      PDF_LIMIT,
    )
  })

  it('requests one native approval for the canonical outside path before reading', async () => {
    const { refs, execution, fs, file, approve, approval, start, user } = setup()
    start()
    file.path = OUTSIDE
    user('@原始名称.pdf')
    approve.mockImplementation(async () => {
      expect(fs.readBytes).not.toHaveBeenCalled()
      expect(await refs.read(execution, approval)).toMatchObject({ code: 'PDF_REFERENCE_ALREADY_CHECKED' })
      return 'allowed-once'
    })
    expect(await refs.read(execution, approval)).toMatchObject({ accepted: true, bytes: PDF })
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      agent: execution.agent, callId: execution.callId, toolName: 'moneycome_read_referenced_pdf',
      signal: execution.signal, reason: expect.stringContaining(OUTSIDE),
    }))
    await refs.read(execution, approval)
    expect(approve).toHaveBeenCalledTimes(1)
    expect(fs.readBytes).toHaveBeenCalledTimes(1)
  })

  it('reads the current PDF under verified full access, then asks when the same session switches back', async () => {
    const { refs, execution, session, fs, approve, approval, start, user } = setup()
    let preset = 'danger-full-access'
    const presets: PermissionPresets = {
      ...fullAccess,
      current(activeSession) {
        expect(activeSession).toBe(session)
        return preset
      },
    }
    start()
    user(`@"${OUTSIDE}"`)
    expect(await refs.read(execution, approval, presets)).toMatchObject({ accepted: true, bytes: PDF })
    expect(approve).not.toHaveBeenCalled()
    expect(fs.readBytes).toHaveBeenCalledTimes(1)
    preset = 'workspace-write'
    expect(await refs.read(execution, approval, presets)).toMatchObject({ code: 'PDF_REFERENCE_PERMISSION_CHANGED' })
    start(2)
    user(`@"${OUTSIDE}"`)
    expect(await refs.read(execution, approval, presets)).toMatchObject({ accepted: true, bytes: PDF })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(fs.readBytes).toHaveBeenCalledTimes(2)
  })

  it.each([
    { sandbox: 'workspace-write', approval: 'never' },
    { sandbox: 'danger-full-access', approval: 'ask' },
  ])('requires approval when a configured preset name does not match the full-access bundle (%j)', async bundle => {
    const { refs, execution, fs, approve, approval, start, user } = setup()
    start()
    user(`@"${OUTSIDE}"`)
    approve.mockResolvedValueOnce('rejected')
    expect(await refs.read(execution, approval, { ...fullAccess, resolve: () => bundle })).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(fs.readBytes).not.toHaveBeenCalled()
  })

  it('does not grant access when the host cannot resolve its active preset', async () => {
    const { refs, execution, fs, start, user } = setup()
    const presets: PermissionPresets = {
      ...fullAccess,
      resolve() { throw new Error('Preset unavailable') },
    }
    start()
    user(`@"${OUTSIDE}"`)
    expect(await refs.read(execution, undefined, presets)).toMatchObject({ code: 'APPROVAL_UNAVAILABLE' })
    expect(fs.readBytes).not.toHaveBeenCalled()
  })

  it('stops before reading if full access is removed during path revalidation', async () => {
    const { refs, execution, fs, file, approve, approval, start, user } = setup()
    let preset = 'danger-full-access'
    const presets = { ...fullAccess, current: () => preset }
    const info = { type: 'file' as const, version: file.version, size: file.bytes.length }
    fs.stat.mockResolvedValueOnce(info).mockImplementationOnce(async () => {
      preset = 'workspace-write'
      return info
    })
    start()
    user(`@"${OUTSIDE}"`)
    expect(await refs.read(execution, approval, presets)).toMatchObject({ code: 'PDF_REFERENCE_PERMISSION_CHANGED' })
    expect(approve).not.toHaveBeenCalled()
    expect(fs.readBytes).not.toHaveBeenCalled()
  })

  it('does not grant full access to another turn or an injected file reference', async () => {
    const { refs, execution, fs, start, observe, user } = setup()
    start()
    user(`@"${OUTSIDE}"`)
    observe('turn/end', { turn: 1 })
    start(2)
    observe('assistant/message', { content: [{ type: 'text', text: `@"${OUTSIDE}"` }] })
    expect(await refs.read(execution, undefined, fullAccess)).toMatchObject({ code: 'PDF_REFERENCE_REQUIRED' })
    expect(fs.resolve).not.toHaveBeenCalled()
  })

  it('fails closed on denied or unavailable approval', async () => {
    const { refs, execution, fs, approve, approval, start, user } = setup()
    start()
    user(`@"${OUTSIDE}"`)
    expect(await refs.read(execution, undefined)).toMatchObject({ code: 'APPROVAL_UNAVAILABLE' })
    start(2)
    user(`@"${OUTSIDE}"`)
    approve.mockResolvedValueOnce('rejected')
    expect(await refs.read(execution, approval)).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(await refs.read(execution, approval)).toMatchObject({ code: 'PDF_REFERENCE_ALREADY_CHECKED' })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(fs.readBytes).not.toHaveBeenCalled()
  })

  it('ignores queued, injected, model, tool, non-RPC, and previous-turn content', async () => {
    const { refs, execution, fs, start, observe, user } = setup()
    user('@not-admitted-yet.pdf')
    start()
    observe('agent/inbox/spliced', { inserted: [{ content: [{ type: 'text', text: '@queued.pdf' }] }] })
    observe('assistant/message', { content: [{ type: 'text', text: '@model.pdf' }] })
    observe('tool/result', { content: [{ type: 'text', text: '@material.pdf' }] })
    user('@context.pdf', RPC_ID, 'runtime-context')
    user('@wechat.pdf', 'mc-in-message')
    observe('user/message', {
      role: 'user', source: { kind: 'user', rpcId: RPC_ID, principal: {} },
      content: [{ type: 'text', text: '@delegated.pdf' }],
    })
    expect(await refs.read(execution, undefined)).toMatchObject({ code: 'PDF_REFERENCE_REQUIRED' })
    user('@valid.pdf')
    observe('turn/end', { turn: 1 })
    start(2)
    expect(await refs.read(execution, undefined)).toMatchObject({ code: 'PDF_REFERENCE_REQUIRED' })
    expect(fs.resolve).not.toHaveBeenCalled()
  })

  it('reads the selected PDF in message order and caches each file separately for subsequent pages', async () => {
    const { refs, execution, fs, start, user } = setup()
    const secondPdf = Uint8Array.from(Buffer.from('%PDF-1.7\nsecond'))
    fs.stat.mockImplementation(async target => ({
      type: 'file', version: '1', size: target.targetKey === join(CWD, '合成 二.pdf') ? secondPdf.length : PDF.length,
    }))
    fs.readBytes.mockImplementation(async target =>
      target.targetKey === join(CWD, '合成 二.pdf') ? secondPdf : PDF,
    )
    start()
    user('@one.pdf @"合成 二.pdf" @one.pdf')
    expect(await refs.read(execution, undefined)).toEqual({ accepted: true, bytes: PDF, fileIndex: 1, fileCount: 2 })
    const second = await refs.read(execution, undefined, undefined, 2)
    expect(second).toEqual({ accepted: true, bytes: secondPdf, fileIndex: 2, fileCount: 2 })
    if (second.accepted) second.bytes[0] = 0
    expect(await refs.read(execution, undefined, undefined, 2)).toMatchObject({ accepted: true, bytes: secondPdf })
    expect(fs.readBytes).toHaveBeenCalledTimes(2)
  })

  it('authorizes external PDFs individually and allows another file after a denial', async () => {
    const { refs, execution, fs, approval, approve, start, user } = setup()
    const other = resolve('synthetic-external', '另一个.pdf')
    start()
    user(`@"${OUTSIDE}" @"${other}"`)
    approve.mockResolvedValueOnce('rejected')
    expect(await refs.read(execution, approval)).toMatchObject({ code: 'APPROVAL_REQUIRED', fileIndex: 1, fileCount: 2 })
    expect(fs.readBytes).not.toHaveBeenCalled()
    expect(await refs.read({ ...execution, callId: 'call-2' }, approval, undefined, 2))
      .toMatchObject({ accepted: true, bytes: PDF, fileIndex: 2, fileCount: 2 })
    expect(approve.mock.calls.map(([request]) => request.reason)).toEqual([
      expect.stringContaining(OUTSIDE), expect.stringContaining(other),
    ])
    expect(fs.readBytes).toHaveBeenCalledExactlyOnceWith(
      { targetKey: other, displayPath: other }, execution.signal, PDF_LIMIT,
    )
  })

  it('allows six PDFs and rejects an oversized batch before file access or approval', async () => {
    const { refs, execution, fs, approve, approval, start, user } = setup()
    const six = Array.from({ length: 6 }, (_, i) => `@file${i + 1}.pdf`).join(' ')
    start()
    user(`${six} @file7.pdf`)
    expect(await refs.read(execution, approval)).toMatchObject({ code: 'PDF_REFERENCE_LIMIT_EXCEEDED' })
    user(six)
    for (const fileIndex of [0, -1, 1.5, 7]) {
      expect(await refs.read(execution, approval, undefined, fileIndex))
        .toMatchObject({ code: 'PDF_REFERENCE_INDEX_INVALID', details: { fileCount: 6 } })
    }
    expect(fs.resolve).not.toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
    for (let fileIndex = 1; fileIndex <= 6; fileIndex++) {
      expect(await refs.read(execution, approval, undefined, fileIndex))
        .toMatchObject({ accepted: true, fileIndex, fileCount: 6 })
    }
    expect(fs.readBytes).toHaveBeenCalledTimes(6)
  })

  it('requires the exact live session and its current user message', async () => {
    const { refs, execution, session, fs, start, user } = setup()
    start()
    user('@one.pdf @two.pdf')
    expect(await refs.read({ ...execution, agent: { session: { ...session } } }, undefined, undefined, 2))
      .toMatchObject({ code: 'PDF_REFERENCE_REQUIRED' })
    user('先等等')
    expect(await refs.read(execution, undefined)).toMatchObject({ code: 'PDF_REFERENCE_REQUIRED' })
    expect(fs.resolve).not.toHaveBeenCalled()
  })

  it('does not read when a turn closes or is cancelled during approval', async () => {
    const { refs, execution, signal, fs, approve, approval, start, user, observe } = setup()
    start()
    user(`@"${OUTSIDE}"`)
    approve.mockImplementationOnce(async () => {
      observe('turn/end', { turn: 1 })
      return 'allowed-once'
    })
    expect(await refs.read(execution, approval)).toMatchObject({ code: 'PDF_REFERENCE_CANCELLED' })
    start(2)
    user(`@"${OUTSIDE}"`)
    approve.mockImplementationOnce(async () => {
      signal.abort()
      return 'allowed-once'
    })
    expect(await refs.read(execution, approval)).toMatchObject({ code: 'PDF_REFERENCE_CANCELLED' })
    expect(fs.readBytes).not.toHaveBeenCalled()
  })

  it('rejects file replacement during approval and discards bytes when the file changes during reading', async () => {
    const { refs, execution, fs, file, approve, approval, start, user } = setup()
    start()
    user(`@"${OUTSIDE}"`)
    approve.mockImplementationOnce(async () => {
      file.path = resolve('another', 'file.pdf')
      return 'allowed-once'
    })
    expect(await refs.read(execution, approval)).toMatchObject({ code: 'PDF_REFERENCE_CHANGED' })
    expect(fs.readBytes).not.toHaveBeenCalled()

    file.path = undefined
    start(2)
    user('@changed.pdf')
    fs.readBytes.mockImplementationOnce(async () => {
      file.version = 'replacement'
      return PDF
    })
    expect(await refs.read(execution, approval)).toMatchObject({ code: 'PDF_REFERENCE_CHANGED' })
  })

  it('rejects remote and device references and oversized PDFs', async () => {
    const { refs, execution, fs, file, start, user } = setup()
    start()
    user('@https://example.invalid/report.pdf')
    expect(await refs.read(execution, undefined)).toMatchObject({ code: 'PDF_REFERENCE_INVALID' })
    user('@\\\\?\\UNC\\host\\share\\report.pdf')
    expect(await refs.read(execution, undefined)).toMatchObject({ code: 'PDF_REFERENCE_INVALID' })
    expect(fs.resolve).not.toHaveBeenCalled()

    file.bytes = new Uint8Array(PDF_LIMIT + 1)
    user('@big.pdf')
    expect(await refs.read(execution, undefined)).toMatchObject({ code: 'FILE_TOO_LARGE' })
    expect(fs.readBytes).not.toHaveBeenCalled()
  })
})
