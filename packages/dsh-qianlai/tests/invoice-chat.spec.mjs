import { describe, expect, it, vi } from 'vitest'

import { invoiceUploadDefinition, registerInvoiceUpload } from '../client/invoice-chat.src.js'

const call = (callId, name = 'moneycome_check_invoice') => ({ type: 'tool/call', data: { callId, name } })
const result = (callId, kind, recordable = false) => ({
  type: 'tool/result',
  data: { message: { source: { kind: 'tool', callId }, text: JSON.stringify({ accepted: true, recordable, nextAction: { kind } }) } },
})
const end = (kind = 'completed') => ({ type: 'turn/end', data: { reason: { kind } } })

function project(events) {
  const definition = invoiceUploadDefinition(event => event.data.message.text)
  const start = { location: { kind: 'turn', turn: 1 } }
  let state = definition.start()
  for (const [index, event] of events.entries()) {
    const bound = { ...event, data: { ...event.data, turn: 1 }, seq: index + 1 }
    if (definition.match[event.type]?.(bound)) state = definition.update({ state }, { event: bound })
  }
  return definition.buildViewNode({ key: 'turn-1', id: '1', state, start })
}

describe('核票后补发附件', () => {
  const wrongInvoice = [call('invoice'), result('invoice', 'replace_invoice')]

  it('在回复之后只显示最后一次核票对应的一个动作', () => {
    expect(project(wrongInvoice)).toBeNull()
    const events = [...wrongInvoice, call('retry'), result('retry', 'upload_clearer_invoice'), end()]
    expect(project(events)).toMatchObject({
      kind: 'moneycome-invoice-upload', visibility: 'visible', data: { action: 'upload_clearer_invoice' },
      anchorSeq: 5,
    })
    expect(project([...wrongInvoice, end('cancelled')])).toBeNull()
  })

  it('其他工具不能伪装成核票结果，新的确认或有效票也不会显示旧入口', () => {
    expect(project([call('fake', 'moneycome_read_upload'), result('fake', 'replace_invoice'), end()])).toBeNull()
    expect(project([...wrongInvoice, call('question', 'ask_user_question'), end()])).toBeNull()
    expect(project([...wrongInvoice, call('confirm', 'moneycome_record_entry'), end()])).toBeNull()
    expect(project([...wrongInvoice, call('valid'), result('valid', 'prepare_posting', true), end()])).toBeNull()
  })

  it('通过当前对话的宿主选择器上传，能力不可用时显示现有附件路径', () => {
    let render
    let showFallback = false
    const input = { canPickFiles: vi.fn(() => true), pickFiles: vi.fn() }
    registerInvoiceUpload({
      inject(names, mount) {
        if (names[0] === 'conversation') mount({ conversation: { input }, effect: install => install() })
      },
      slots: {
        inject(_name, mount) { mount() },
        register(_descriptor, component) { render = component },
      },
    }, {
      jsx: (type, props) => ({ type, ...props }),
      useState: () => [showFallback, value => { showFallback = value }],
      usePreset: () => 'moneycome-zhangjie',
    })
    const props = { node: { data: { action: 'replace_invoice' } }, sessionId: 'session-1' }
    const button = render(props).children[0].children[1]
    expect(button.children).toBe('上传正确发票')
    button.onClick()
    expect(input.canPickFiles).toHaveBeenCalledWith('session-1')
    expect(input.pickFiles).toHaveBeenCalledExactlyOnceWith('session-1')

    input.canPickFiles.mockReturnValue(false)
    button.onClick()
    expect(input.pickFiles).toHaveBeenCalledTimes(1)
    expect(render(props).children[1].children).toContain('「文件」')
  })
})
