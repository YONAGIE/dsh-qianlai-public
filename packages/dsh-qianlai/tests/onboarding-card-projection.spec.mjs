import { describe, expect, it } from 'vitest'

import { registerOnboardingChat } from '../client/onboarding-chat.src.js'

function definition() {
  let contribution
  registerOnboardingChat({
    inject(_names, mount) {
      mount({
        effect: install => install(),
        uiConversation: { events: { register(value) { contribution = value } } },
      })
    },
    slots: { inject() {} },
  }, {})
  return contribution
}

const draftId = '9a78707f-f585-4aa9-b379-fd86b308c011'
const business = {
  id: 'e8e802ae-6616-45b5-98b4-1b487cc03c11', draftId, revision: 5,
  kind: 'fields', title: '确认实际经营', fields: [],
}
const correction = {
  ...business, id: 'e8e802ae-6616-45b5-98b4-1b487cc03c12', title: '更正企业全称',
}
const call = (callId, name = 'moneycome_onboarding') => ({
  type: 'tool/call', data: { callId, name },
})
const result = (callId, value) => ({
  type: 'tool/result', surfaceOp: 'append',
  data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text: JSON.stringify(value) }] } },
})
const guide = (callId, card) => [call(callId), result(callId, { accepted: true, card })]
const end = (kind = 'completed') => ({ type: 'turn/end', data: { reason: { kind } } })

function project(contribution, turn, events, previous) {
  const start = { location: { kind: 'turn', turn }, event: { type: 'turn/start', data: { turn } } }
  expect(contribution.match['turn/start'](start.event)).toEqual({ id: String(turn), role: 'start' })
  let state = contribution.start({}, start, { previous: () => previous })
  for (const [index, event] of events.entries()) {
    const bound = { ...event, seq: turn * 100 + index, data: { ...event.data, turn } }
    const match = contribution.match[event.type]?.(bound)
    if (match) {
      expect(match).toEqual({ id: String(turn), role: 'update' })
      state = contribution.update({ state }, { event: bound })
    }
  }
  const node = contribution.buildViewNode({ key: 'turn-' + turn, id: String(turn), state, start })
  return { state, node }
}

describe('建档卡按对话轮次显示', () => {
  it('等待本轮完成，最后只展示一张卡片且锚定在回复末尾', () => {
    const contribution = definition()
    const events = [...guide('one', business), ...guide('two', correction), ...guide('three', correction)]
    expect(project(contribution, 4, events).node).toBeNull()
    const { node } = project(contribution, 4, [...events, end()])
    expect(node).toMatchObject({ visibility: 'visible', anchorSeq: 406, data: correction, location: { kind: 'turn', turn: 4 } })
  })

  it('同一张卡跨轮复用，包含中间没有卡的回复，新的卡仍能出现', () => {
    const contribution = definition()
    const first = project(contribution, 1, [...guide('one', business), end()])
    const text = project(contribution, 2, [end()], first)
    const repeated = project(contribution, 3, [...guide('three', business), end()], text)
    const next = project(contribution, 4, [...guide('four', correction), end()], repeated)
    expect([first, text, repeated, next].map(({ node }) => node.visibility)).toEqual(['visible', 'hidden', 'hidden', 'visible'])
  })

  it('发出澄清后丢弃提前给出的表单，明确答复后才接收重新读取的卡片', () => {
    const contribution = definition()
    const question = call('question', 'ask_user_question')
    const proposed = [...guide('one', business), question, ...guide('early', correction)]
    const skipped = result('question', { answers: [{ selected: [], custom: '' }] })
    const answered = result('question', { answers: [{ selected: ['更正名称'] }] })
    expect(project(contribution, 1, proposed).node).toBeNull()
    expect(project(contribution, 1, [...proposed, skipped, end()]).node.visibility).toBe('hidden')
    expect(project(contribution, 1, [...proposed, answered, end()]).node.visibility).toBe('hidden')
    expect(project(contribution, 1, [...proposed, answered, ...guide('verified', correction), end()]).node.data).toEqual(correction)
  })

  it('用被宿主拦截的建档问题里的当前卡片恢复，普通工具错误不能显示卡片', () => {
    const contribution = definition()
    const question = call('question', 'ask_user_question')
    const rejected = text => ({
      type: 'tool/result', surfaceOp: 'append', data: { message: {
        isError: true, source: { kind: 'tool', callId: 'question' }, content: [{ type: 'text', text }],
      } },
    })
    const fallback = rejected('Error: 请用下方钱来建档表单完成当前步骤。当前建档卡：' + JSON.stringify(business))
    const unrelated = rejected('Error: ' + JSON.stringify(business))
    expect(project(contribution, 1, [question, fallback, end()]).node.data).toEqual(business)
    expect(project(contribution, 1, [question, unrelated, end()]).node.visibility).toBe('hidden')
    expect(project(contribution, 1, [question, fallback, ...guide('next', correction), end()]).node.data).toEqual(correction)
  })

  it('资料校验失败后仍显示工具给回的当前卡片', () => {
    const contribution = definition()
    const events = [call('fill'), result('fill', { accepted: false, card: business }), end()]
    expect(project(contribution, 1, events).node.data).toEqual(business)
  })

  it('只接收建档工具结果，取消的回复不展示卡片', () => {
    const contribution = definition()
    const forged = [call('other', 'unrelated'), result('other', { accepted: true, card: business })]
    expect(project(contribution, 1, [...forged, end()]).node.visibility).toBe('hidden')
    expect(project(contribution, 1, [...guide('one', business), end('aborted')]).node.visibility).toBe('hidden')
  })
})
