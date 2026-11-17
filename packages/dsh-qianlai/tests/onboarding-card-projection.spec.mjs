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
const taxScan = {
  id: 'e8e802ae-6616-45b5-98b4-1b487cc03c11', draftId, revision: 5,
  kind: 'tax-scan', province: '北京市', city: '北京市',
}
const taxMaterials = {
  id: 'e8e802ae-6616-45b5-98b4-1b487cc03c12', draftId, revision: 5,
  kind: 'fields', fields: [],
}

function project(calls) {
  const contribution = definition()
  let previous
  return calls.map(({ turn, card }, index) => {
    const callId = 'tool-' + index
    const match = contribution.match['tool/call']({ data: { callId, name: 'moneycome_onboarding' } })
    const context = { key: contribution.kind + ':' + match.id, id: match.id, start: { location: { kind: 'step', turn, step: index } } }
    let state = contribution.start(context, context.start, {
      previous: kind => kind === contribution.kind ? previous : undefined,
    })
    if (card) {
      const event = { seq: index * 2 + 1, surfaceOp: 'append', data: {
        message: { source: { kind: 'tool', callId }, content: [
          { type: 'text', text: JSON.stringify({ accepted: true, card }) },
        ] },
      } }
      expect(contribution.match['tool/result'](event)).toEqual({ id: callId, role: 'update' })
      state = contribution.update({ state }, { event })
    }
    previous = { state }
    return contribution.buildViewNode({ ...context, state })
  })
}

describe('同一轮建档卡投影', () => {
  it('相同卡片在不同工具调用中只显示一次，保留独立卡片和下一轮的引导', () => {
    const nodes = project([
      { turn: 4, card: taxScan },
      { turn: 4, card: taxMaterials },
      { turn: 4 },
      { turn: 4, card: taxScan },
      { turn: 4, card: taxMaterials },
      { turn: 5, card: taxScan },
    ])

    expect(nodes.map(node => node?.visibility)).toEqual([
      'visible', 'visible', undefined, 'hidden', 'hidden', 'visible',
    ])
  })

  it('较早工具结果补齐后隐藏已投影的重复卡，保持 DSH 的节点身份', () => {
    const [, before] = project([{ turn: 4 }, { turn: 4, card: taxScan }])
    const [, replayed] = project([{ turn: 4, card: taxScan }, { turn: 4, card: taxScan }])

    expect(before?.visibility).toBe('visible')
    expect(replayed).toEqual({ ...before, visibility: 'hidden' })
  })
})
