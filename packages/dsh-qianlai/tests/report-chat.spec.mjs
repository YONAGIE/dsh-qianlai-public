import { describe, expect, it, vi } from 'vitest'

import { companyReportDefinition, registerCompanyReportChat } from '../client/report-chat.src.js'

const call = (callId, name = 'moneycome_company_report') => ({ type: 'tool/call', data: { callId, name } })
const result = (callId, fields = {}) => ({
  type: 'tool/result',
  data: { message: { source: { kind: 'tool', callId }, text: JSON.stringify({
    accepted: false,
    kind: 'financial',
    periodKey: '2026-01',
    title: '月度财务报表',
    nextAction: 'upload',
    uploadKind: 'transaction-evidence',
    message: '2026-01-10 收入 5000.00 元（咨询服务来款）',
    ...fields,
  }) } },
})
const end = (kind = 'completed') => ({ type: 'turn/end', data: { reason: { kind } } })

function project(events) {
  const definition = companyReportDefinition(event => event.data.message.text)
  const start = { location: { kind: 'turn', turn: 1 } }
  let state = definition.start()
  for (const [index, event] of events.entries()) {
    const bound = { ...event, data: { ...event.data, turn: 1 }, seq: index + 1 }
    if (definition.match[event.type]?.(bound)) state = definition.update({ state }, { event: bound })
  }
  return definition.buildViewNode({ key: 'turn-1', id: '1', state, start })
}

describe('财务报表补资料', () => {
  const missing = [call('report'), result('report')]

  it('回复结束后同一轮只显示最新报表动作，后续的问答和记账不会叠加旧卡', () => {
    expect(project(missing)).toBeNull()
    expect(project([...missing, end()])).toMatchObject({
      anchorSeq: 3, data: { callId: 'report', periodKey: '2026-01', uploadKind: 'transaction-evidence' },
    })
    expect(project([...missing, call('latest'), result('latest', { periodKey: '2026-02' }), end()])).toMatchObject({
      anchorSeq: 5, data: { callId: 'latest', periodKey: '2026-02' },
    })
    expect(project([...missing, end('cancelled')])).toBeNull()
    expect(project([...missing, call('other', 'ask_user_question'), end()])).toBeNull()
    expect(project([...missing, call('other', 'moneycome_record_entry'), end()])).toBeNull()
    expect(project([call('report', 'moneycome_read_upload'), result('report'), end()])).toBeNull()
  })

  it.each([
    ['transaction-evidence', '上传本笔发票或凭据'],
    ['invoice', '上传发票'],
    [undefined, '上传本月资料'],
  ])('%s 补资料入口直接调用当前会话文件选择器', (uploadKind, label) => {
    let render
    let message = ''
    const input = { canPickFiles: vi.fn(() => true), pickFiles: vi.fn() }
    registerCompanyReportChat({
      inject(names, mount) {
        if (names[0] === 'connection') mount({ conversation: { input }, effect: install => install() })
      },
      slots: {
        inject(_name, mount) { mount() },
        register(_descriptor, component) { render = component },
      },
    }, {
      jsx: (type, props) => ({ type, ...props }),
      useState: initial => initial === '' ? [message, value => { message = value }] : [initial, vi.fn()],
      useRef: initial => ({ current: initial }),
      usePreset: () => 'moneycome-zhangjie',
    })
    const node = project([call('report'), result('report', { uploadKind }), end()])
    const props = { node, sessionId: 'session-1' }
    const action = render(props).children.find(child => child?.type === 'div')
    expect(action.children[0].children).toContain('5000.00 元')
    const button = action.children[1]
    expect(button.children).toBe(label)
    button.onClick()
    expect(input.canPickFiles).toHaveBeenCalledWith('session-1')
    expect(input.pickFiles).toHaveBeenCalledExactlyOnceWith('session-1')

    input.canPickFiles.mockReturnValue(false)
    button.onClick()
    expect(input.pickFiles).toHaveBeenCalledTimes(1)
    expect(render(props).children.find(child => child?.role === 'status')?.children).toContain('文件入口')
  })
})
