import { describe, expect, it, vi } from 'vitest'

import { payrollFormDefinition, registerPayrollForm } from '../client/payroll-work.src.js'

const card = { kind: 'schedule', earliestMonth: '2026-01', currentMonth: '2026-02', periodKey: '2026-03', mode: 'once', payday: 31 }
const call = (callId, name = 'moneycome_payroll') => ({ type: 'tool/call', data: { callId, name } })
const result = callId => ({ type: 'tool/result', data: { message: { source: { kind: 'tool', callId },
  content: JSON.stringify({ accepted: true, payrollForm: card }) } } })
const end = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

function projection(events) {
  const view = payrollFormDefinition(event => event.data.message.content)
  let state = view.start()
  for (const [i, detail] of events.entries()) {
    const event = { ...detail, seq: i + 1, data: { ...detail.data, turn: 1 } }
    if (view.match[event.type]?.(event)) state = view.update({ state }, { event })
  }
  return view.buildViewNode({ key: '1', id: '1', state, start: { location: 'chat' } })
}

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object') return []
  return [node, ...elements(node.props.children)]
}

describe('发薪安排小表单', () => {
  it('等本轮结束，只显示真实工具的表单，已有确认时不再给一张', () => {
    expect(projection([call('pay'), result('pay')])).toBeNull()
    expect(projection([call('pay'), result('other'), end])).toBeNull()
    expect(projection([call('pay'), result('pay'), call('ask', 'ask_user_question'), end])).toBeNull()
    expect(projection([call('pay'), result('pay'), end])).toMatchObject({
      kind: 'moneycome-payroll-schedule-form', anchorSeq: 3, data: card,
    })
  })

  it('提供真实的月份与 31 天选项并只提交给当前会话', async () => {
    let Form
    const jsx = (type, props) => ({ type, props })
    const calendar = () => {}
    const sendOnboardingReply = vi.fn().mockResolvedValue(undefined)
    registerPayrollForm({
      inject() {},
      slots: {
        inject(_name, install) { install() },
        register(_options, component) { Form = component },
      },
    }, {
      jsx, useState: value => [value, () => {}], usePreset: () => 'moneycome-zhangjie', useId: () => 'payroll-month',
      OnboardingDateInput: calendar, sendOnboardingReply,
    })
    const form = Form({ sessionId: 'active', node: { data: card } })
    const components = elements(form)
    expect(components.find(node => node.type === calendar).props).toMatchObject({
      type: 'month', value: '2026-03', min: '2026-01', max: '2027-02',
    })
    const dateSelect = components.find(node => node.type === 'select' && node.props.value === '31')
    const days = elements(dateSelect).filter(node => node.type === 'option' && node.props.value)
    expect(days).toHaveLength(31)
    await form.props.onSubmit({ preventDefault() {} })
    expect(sendOnboardingReply).toHaveBeenCalledExactlyOnceWith('active',
      '发薪安排表单已填：仅这个月发薪，生效月份 2026-03，发薪日 31 日。请给我确认保存。')
  })
})
