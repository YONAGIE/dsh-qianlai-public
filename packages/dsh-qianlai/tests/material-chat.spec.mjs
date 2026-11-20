import { describe, expect, it, vi } from 'vitest'

import { materialRetryDefinition, registerMaterialRetry } from '../client/material-chat.src.js'

const failed = { accepted: false, code: 'FILE_FORMAT_MISMATCH', material: { id: 1, name: '合成流水.pdf', status: 'failed' } }
const read = { accepted: true, material: { id: 2, name: '合成发票.pdf', status: 'read' } }

function project(events, completed = true) {
  const definition = materialRetryDefinition()
  let state = definition.start()
  const update = (type, data, seq) => {
    const event = { type, data: { turn: 1, ...data }, surfaceOp: 'append', seq }
    if (definition.match[type](event)) state = definition.update({ state }, { event })
  }
  events.forEach(([callId, name, output, args], index) => {
    update('tool/call', { name, callId, arguments: JSON.stringify(args ?? {}) }, index * 2 + 1)
    if (output) update('tool/result', { message: { source: { kind: 'tool', callId },
      content: [{ type: 'text', text: JSON.stringify(output) }] } }, index * 2 + 2)
  })
  update('turn/end', { reason: { kind: completed ? 'completed' : 'aborted' } }, events.length * 2 + 1)
  return definition.buildViewNode({ key: 'key', id: 'turn-1', state, start: { location: 'turn location' } })
}

describe('材料重传操作', () => {
  const batch = [['bad', 'moneycome_read_upload', failed], ['good', 'moneycome_read_upload', read]]

  it('任一份失败后仍保留重传入口，确认回合结束才显示', () => {
    expect(project([...batch, ['preview', 'moneycome_record_entry', null, { preview: true }]])).toMatchObject({
      kind: 'moneycome-material-retry', anchorSeq: 7, data: { id: 1, name: '合成流水.pdf', code: 'FILE_FORMAT_MISMATCH' },
    })
    expect(project(batch, false)).toBeNull()
    expect(project([['unrelated', 'another_tool', failed]])).toBeNull()
    expect(project([...batch, ['fixed', 'moneycome_read_upload', { ...read, material: { ...read.material, id: 1 } }]])).toBeNull()
  })

  it('已经要老板选择、确认凭证或换发票时只保留当前动作', () => {
    expect(project([...batch, ['ask', 'ask_user_question']])).toBeNull()
    expect(project([...batch, ['confirm', 'moneycome_record_entry', null, { requestApproval: true }]])).toBeNull()
    expect(project([...batch, ['invoice', 'moneycome_check_invoice', {
      accepted: true, nextAction: { kind: 'replace_invoice' },
    }]])).toBeNull()
    expect(project([...batch, ['invoice', 'moneycome_check_invoice', { accepted: true, recordable: true }]])).not.toBeNull()
  })

  it('使用实有的会话文件选择器，当前会话打不开时显示聊天附件提示', () => {
    const canPickFiles = vi.fn(() => true)
    const pickFiles = vi.fn()
    let render
    let fallback = false
    registerMaterialRetry({
      inject: (names, register) => { if (names[0] === 'conversation') register({
        conversation: { input: { canPickFiles, pickFiles } }, effect: fn => fn(),
      }) },
      slots: {
        inject: (_name, register) => register(),
        register: (_slot, component) => { render = component },
      },
    }, {
      jsx: (name, props) => ({ name, ...props }), usePreset: () => 'moneycome-zhangjie',
      useState: () => [fallback, value => { fallback = value }], buttonStyle: {}, panelSectionStyle: {},
    })
    const args = { node: project(batch), sessionId: 'synthetic-session' }
    const action = render(args).children[0].children[1]
    expect(action.children).toBe('重新选文件')
    action.onClick()
    expect(pickFiles).toHaveBeenCalledExactlyOnceWith('synthetic-session')
    canPickFiles.mockReturnValue(false)
    action.onClick()
    expect(pickFiles).toHaveBeenCalledTimes(1)
    expect(render(args).children[1].children).toContain('输入框旁的「文件」')
  })
})
