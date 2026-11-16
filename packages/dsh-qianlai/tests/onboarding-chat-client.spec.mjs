import { describe, expect, it, vi } from 'vitest'

import { registerOnboardingChat } from '../client/onboarding-chat.src.js'

const sessionId = 'synthetic-zhangjie'
const cardId = 'e8e802ae-6616-45b5-98b4-1b487cc03c11'
const draftId = '9a78707f-f585-4aa9-b379-fd86b308c011'
const toolId = 'synthetic-call'
const baseCard = { id: cardId, draftId, revision: 5 }

function resultFor(card) {
  return {
    seq: 12, surfaceOp: 'append',
    data: { message: { source: { kind: 'tool', callId: toolId }, content: [
      { type: 'text', text: JSON.stringify({ accepted: true, card }) },
    ] } },
  }
}

function client(onboardingRequest, preset = 'moneycome-zhangjie') {
  let definition
  let renderNode
  const openOnboarding = vi.fn()
  const refreshOnboarding = vi.fn()
  const jsx = (type, props) => ({ type, props })
  let hooks = []
  let index = 0
  let effects = []
  registerOnboardingChat({
    inject(_names, mount) {
      mount({ effect: install => install(), uiConversation: { events: { register(value) { definition = value } } } })
    },
    slots: { inject: (_slot, mount) => mount(), register: (_options, component) => { renderNode = component } },
  }, {
    jsx, onboardingRequest, openOnboarding, refreshOnboarding,
    usePreset: () => preset,
    useState(initial) {
      const slot = index++
      if (!(slot in hooks)) hooks[slot] = initial
      return [hooks[slot], value => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value }]
    },
    useRef(initial) { return hooks[index++] ??= { current: initial } },
    useEffect(effect, deps) {
      const slot = index++
      const original = hooks[slot]
      if (original?.deps.every((value, i) => value === deps[i])) return
      effects.push(() => {
        original?.cleanup?.()
        hooks[slot] = { deps, cleanup: effect() }
      })
    },
  })
  const render = card => {
    const event = resultFor(card)
    const state = definition.update({ state: null }, { event })
    const node = definition.buildViewNode({ id: toolId, key: toolId, state, start: { location: {} } })
    const widget = node && renderNode({ node, sessionId })
    index = 0
    const rendered = widget && widget.type(widget.props)
    for (const effect of effects.splice(0)) effect()
    return rendered
  }
  return {
    definition, openOnboarding, refreshOnboarding, render,
    remount() {
      for (const hook of hooks) hook?.cleanup?.()
      hooks = []
      effects = []
    },
  }
}

function find(tree, test) {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = find(child, test)
      if (found) return found
    }
  } else if (tree && typeof tree === 'object') {
    if (test(tree)) return tree
    return find(tree.props?.children, test)
  }
  return undefined
}

const named = label => node => node.type === 'button' && node.props.children === label
const info = node => node.type === 'p' && node.props.role === 'status'
const settle = async () => { await Promise.resolve(); await Promise.resolve() }

describe('建档对话卡', () => {
  it('仅将张姐工具的有效卡片投影到普通聊天，并允许打开右侧当前表单', async () => {
    const view = { revision: 5 }
    const request = vi.fn(async () => ({ accepted: true, view }))
    const active = client(request)
    const card = { ...baseCard, kind: 'fields', fields: [] }
    expect(active.definition.match['tool/call']({ data: { name: 'unrelated', callId: toolId } })).toBeNull()
    expect(active.definition.match['tool/call']({ data: { name: 'moneycome_onboarding', callId: toolId } })).toEqual({ id: toolId, role: 'start' })
    expect(active.definition.match['tool/result'](resultFor({ ...card, draftId: 'forged' }))).toBeNull()
    expect(active.definition.match['tool/result'](resultFor(card))).toEqual({ id: toolId, role: 'update' })
    expect(client(request, 'default').render(card)).toBeNull()

    find(active.render(card), named('打开建档表单')).props.onClick()
    await settle()
    expect(active.openOnboarding).toHaveBeenCalledWith(sessionId, undefined)
    expect(request).toHaveBeenCalledExactlyOnceWith(sessionId, 'card-status', { cardId })
    expect(active.refreshOnboarding).toHaveBeenCalledExactlyOnceWith(sessionId, view)
  })

  it('保存扫码选择、打开当前会话的表单并在重开后展示原提交回执', async () => {
    const card = { ...baseCard, kind: 'mode' }
    let receipt
    const view = { revision: 6 }
    const request = vi.fn(async (_session, action, payload) => {
      if (action === 'card-status') return { accepted: true, receipt }
      receipt = { labels: [], mode: payload.mode }
      return { accepted: true, receipt, view }
    })
    const active = client(request)
    active.render(card)
    await settle()
    expect(find(active.render(card), named('手动填写'))).toBeDefined()
    find(active.render(card), named('扫码建档')).props.onClick()
    await settle()
    expect(request).toHaveBeenLastCalledWith(sessionId, 'submit-card', { cardId, draftId, revision: 5, mode: 'scan' })
    expect(active.openOnboarding).toHaveBeenCalledExactlyOnceWith(sessionId, { mode: 'scan', view })
    expect(find(active.render(card), info).props.children).toBe('已选择扫码建档')

    active.remount()
    active.render(card)
    await settle()
    expect(find(active.render(card), info).props.children).toBe('已选择扫码建档')
    expect(find(active.render(card), named('扫码建档'))).toBeUndefined()
    expect(active.openOnboarding).toHaveBeenCalledTimes(1)
  })

  it('保存结构化补填结果、刷新右侧草稿，并以字段名称显示回执', async () => {
    const card = { ...baseCard, kind: 'fields', fields: [
      { key: 'taxId', type: 'text', label: '统一社会信用代码', maxLength: 18 },
      { key: 'taxRegion', type: 'select', label: '税务地区', options: [{ value: '北京市|北京市', label: '北京市税务局' }] },
    ] }
    const view = { revision: 6 }
    const request = vi.fn(async (_session, action) => action === 'card-status' ? { accepted: true }
      : { accepted: true, receipt: { labels: ['统一社会信用代码', '税务地区'] }, view })
    const active = client(request)
    active.render(card)
    await settle()
    const syntheticCode = '123456789012345678'
    find(active.render(card), node => node.type === 'input').props.onChange({ target: { value: syntheticCode } })
    find(active.render(card), node => node.type === 'select').props.onChange({ target: { value: '北京市|北京市' } })
    find(active.render(card), node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    await settle()

    expect(request).toHaveBeenLastCalledWith(sessionId, 'submit-card', {
      cardId, draftId, revision: 5, values: { taxId: syntheticCode, taxRegion: '北京市|北京市' },
    })
    expect(active.refreshOnboarding).toHaveBeenCalledExactlyOnceWith(sessionId, view)
    expect(find(active.render(card), info).props.children).toBe('已保存 统一社会信用代码、税务地区')
    expect(find(active.render(card), node => node.type === 'input')).toBeUndefined()
  })
})
