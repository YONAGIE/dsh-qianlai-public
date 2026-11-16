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

function client(onboardingRequest, preset = 'moneycome-zhangjie', extras = {}) {
  let definition
  let renderNode
  const openOnboarding = vi.fn()
  const refreshOnboarding = vi.fn()
  const jsx = (type, props, key) => ({ type, props, key })
  const components = new Map()
  let hooks
  let index = 0
  let effects = []
  registerOnboardingChat({
    inject(_names, mount) {
      mount({ effect: install => install(), uiConversation: { events: { register(value) { definition = value } } } })
    },
    slots: { inject: (_slot, mount) => mount(), register: (_options, component) => { renderNode = component } },
  }, {
    jsx, onboardingRequest, openOnboarding, refreshOnboarding, ...extras,
    usePreset: () => preset,
    useState(initial) {
      const slot = index++
      const slots = hooks
      if (!(slot in slots)) slots[slot] = initial
      return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    },
    useRef(initial) { return hooks[index++] ??= { current: initial } },
    useEffect(effect, deps) {
      const slot = index++
      const original = hooks[slot]
      if (original?.deps.every((value, i) => value === deps[i])) return
      const slots = hooks
      effects.push(() => {
        original?.cleanup?.()
        slots[slot] = { deps, cleanup: effect() }
      })
    },
  })
  function resolve(tree, path, mounted) {
    if (Array.isArray(tree)) return tree.map((child, i) => resolve(child, path + '.' + (child?.key ?? i), mounted))
    if (!tree || typeof tree !== 'object') return tree
    if (typeof tree.type === 'function') {
      const key = path + '.' + (tree.key ?? tree.type.name)
      hooks = components.get(key) ?? []
      components.set(key, hooks)
      mounted.add(key)
      index = 0
      return resolve(tree.type(tree.props), key, mounted)
    }
    return { ...tree, props: { ...tree.props, children: resolve(tree.props.children, path, mounted) } }
  }
  const render = card => {
    const event = resultFor(card)
    const state = definition.update({ state: null }, { event })
    const node = definition.buildViewNode({ id: toolId, key: toolId, state, start: { location: {} } })
    const widget = node && renderNode({ node, sessionId })
    const mounted = new Set()
    const rendered = resolve(widget, 'root', mounted)
    for (const [key, previous] of components) {
      if (mounted.has(key)) continue
      for (const hook of previous) hook?.cleanup?.()
      components.delete(key)
    }
    for (const effect of effects.splice(0)) effect()
    return rendered
  }
  return {
    definition, openOnboarding, refreshOnboarding, render,
    remount() {
      for (const slots of components.values()) {
        for (const hook of slots) hook?.cleanup?.()
      }
      components.clear()
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
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const next = (index, data) => ({ id: 'e8e802ae-6616-45b5-98b4-1b487cc03c1' + index, draftId, revision: 5 + index, ...data })
const section = (tree, card) => find(tree, node => node.props['data-qianlai-onboarding-card'] === card.id)
const companyChoice = next(2, { kind: 'source', documentKind: 'license' })
const companyUpload = next(3, { kind: 'upload', documentKind: 'license' })
const recognizedView = { revision: 9, enterprise: { companyName: '示例服务有限公司', taxId: '111111111111111111' } }

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

  it('在原对话里选手动、上传营业执照，只对识别剩余的字段展示小表单', async () => {
    const mode = { ...baseCard, kind: 'mode' }
    const fields = next(4, { kind: 'fields', title: '补充公司资料', fields: [{ key: 'establishedOn', type: 'date', label: '成立日期' }] })
    const persisted = new Map()
    const request = vi.fn(async (_session, action, { cardId, ...input }) => {
      if (action === 'card-status') return persisted.get(cardId) ?? { accepted: true }
      const result = {
        [mode.id]: { receipt: { mode: input.mode }, nextCard: companyChoice },
        [companyChoice.id]: { receipt: { choice: input.choice }, nextCard: companyUpload },
        [companyUpload.id]: { receipt: { labels: ['识别公司资料'] }, nextCard: fields, view: recognizedView },
      }[cardId]
      persisted.set(cardId, { accepted: true, ...result })
      return persisted.get(cardId)
    })
    const readOnboardingFile = vi.fn(async () => 'dGVzdA==')
    const active = client(request, undefined, { readOnboardingFile })
    const choose = async label => {
      find(active.render(mode), named(label)).props.onClick()
      await settle()
      active.render(mode)
      await settle()
    }
    active.render(mode)
    await settle()
    await choose('手动填写')
    await choose('上传营业执照')
    const file = { name: '示例营业执照.png', type: 'image/png', size: 4 }
    find(section(active.render(mode), companyUpload), node => node.type === 'input' && node.props.type === 'file')
      .props.onChange({ target: { files: [file] } })
    await settle()
    active.render(mode)
    await settle()

    expect(readOnboardingFile).toHaveBeenCalledExactlyOnceWith(file)
    expect(request).toHaveBeenCalledWith(sessionId, 'submit-card', {
      cardId: companyUpload.id, draftId, revision: companyUpload.revision,
      document: { name: file.name, mimeType: file.type, base64: 'dGVzdA==' },
    }, expect.any(AbortSignal))
    expect(active.refreshOnboarding).toHaveBeenCalledWith(sessionId, recognizedView)
    const visibleFields = section(active.render(mode), fields)
    expect(find(visibleFields, node => node.type === 'input').props.type).toBe('date')
    expect(find(visibleFields, node => node.type === 'label' && node.props.children[0] === '企业全称')).toBeUndefined()

    active.remount()
    for (let i = 0; i < 4; i++) {
      active.render(mode)
      await settle()
    }
    expect(find(section(active.render(mode), fields), node => node.type === 'input').props.type).toBe('date')
    expect(readOnboardingFile).toHaveBeenCalledTimes(1)
  })

  it('选择地区后立刻打开官方扫码，重开对话只恢复状态，用户核对后再回填', async () => {
    vi.useFakeTimers()
    try {
      const region = next(2, { kind: 'region' })
      const scan = next(3, { kind: 'tax-scan', province: '北京市', city: '北京市' })
      const bank = next(4, { kind: 'bank' })
      const selectedView = { revision: scan.revision, enterprise: { companyName: '', taxId: '' } }
      const profile = { companyName: '示例服务有限公司', taxId: '111111111111111111' }
      let selected = false
      let applied = false
      const request = vi.fn(async (_session, action, input) => {
        if (action === 'submit-card') selected = true
        if (input.cardId === region.id) return selected ? { accepted: true, receipt: { labels: ['税务地区'] }, nextCard: scan, view: selectedView } : { accepted: true }
        if (input.cardId === scan.id) return applied
          ? { accepted: true, receipt: { labels: ['官方税务资料'] }, view: recognizedView, nextCard: bank }
          : { accepted: true, view: selectedView }
        return { accepted: true, view: recognizedView }
      })
      const taxRequest = vi.fn(async action => {
        if (action === 'start') return { phase: 'waiting', message: '请扫码并选择企业。' }
        if (action === 'status') return { phase: 'ready', profile }
        if (action === 'submit') {
          applied = true
          return { phase: 'submitted' }
        }
      })
      const previewOnboardingTax = vi.fn()
      const active = client(request, undefined, {
        taxRequest, previewOnboardingTax, taxRegionCities: { 北京市: ['北京市'], 浙江省: ['杭州市', '宁波市'] },
      })
      const pick = (label, value) => find(find(active.render(region), node => node.type === 'label' && node.props.children[0] === label),
        node => node.type === 'select').props.onChange({ target: { value } })
      const renderAndSettle = async () => { active.render(region); await settle() }
      await renderAndSettle()
      pick('省份', '浙江省')
      pick('城市或地区', '宁波市')
      pick('省份', '北京市')
      const cityLabel = find(active.render(region), node => node.type === 'label' && node.props.children[0] === '城市或地区')
      expect(find(cityLabel, node => node.type === 'select').props.value).toBe('')
      expect(find(cityLabel, node => node.type === 'option' && node.props.value === '宁波市')).toBeUndefined()
      pick('城市或地区', '北京市')
      find(active.render(region), node => node.type === 'form').props.onSubmit({ preventDefault() {} })
      await settle()
      await renderAndSettle()
      await renderAndSettle()
      await renderAndSettle()
      expect(taxRequest).toHaveBeenCalledExactlyOnceWith('start', scan.id, sessionId, draftId, {
        province: '北京市', city: '北京市', companyName: '', taxId: '',
      })
      expect(find(active.render(region), named('重试读取'))).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1400)
      expect(previewOnboardingTax).toHaveBeenCalledWith(sessionId, profile, draftId)
      expect(find(active.render(region), named('核对无误，回填税务资料'))).toBeDefined()

      active.remount()
      for (let i = 0; i < 4; i++) await renderAndSettle()
      expect(taxRequest.mock.calls.filter(([action]) => action === 'start')).toHaveLength(1)
      expect(taxRequest.mock.calls.filter(([action]) => action === 'submit')).toHaveLength(0)
      find(active.render(region), named('核对无误，回填税务资料')).props.onClick()
      await settle()
      expect(taxRequest).toHaveBeenLastCalledWith('submit', scan.id, sessionId, draftId, {})
      expect(active.refreshOnboarding).toHaveBeenCalledWith(sessionId, recognizedView)
      expect(section(active.render(region), bank)).toBeDefined()
      active.remount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('手填中改用扫码时保留已填字段，取消扫码后还可继续手填', async () => {
    const fields = next(2, {
      kind: 'fields', title: '补充公司资料', canSwitchToScan: true,
      fields: [
        { key: 'companyName', type: 'text', label: '企业全称' },
        { key: 'establishedOn', type: 'date', label: '成立日期' },
      ],
    })
    const scan = next(3, { kind: 'tax-scan', province: '北京市', city: '北京市' })
    const taxSource = next(4, { kind: 'source', documentKind: 'tax' })
    const view = { revision: scan.revision, enterprise: { companyName: '示例服务有限公司', taxId: '' } }
    const request = vi.fn(async (_session, action, input) => {
      if (action === 'card-status') return { accepted: true, view }
      if (input.choice === 'scan') return { accepted: true, view, receipt: { mode: 'scan' }, nextCard: scan }
      return { accepted: true, view, receipt: { mode: 'manual' }, nextCard: taxSource }
    })
    const taxRequest = vi.fn(async action => action === 'cancel' ? { phase: 'idle' } : { phase: 'waiting' })
    const active = client(request, undefined, { taxRequest })
    const renderAndSettle = async () => { active.render(fields); await settle() }
    await renderAndSettle()
    find(active.render(fields), node => node.type === 'input' && node.props.type === 'text')
      .props.onChange({ target: { value: view.enterprise.companyName } })
    find(active.render(fields), named('改为扫码建档')).props.onClick()
    await settle()
    for (let i = 0; i < 3; i++) await renderAndSettle()
    expect(request).toHaveBeenCalledWith(sessionId, 'submit-card', {
      cardId: fields.id, draftId, revision: fields.revision,
      choice: 'scan', values: { companyName: view.enterprise.companyName },
    })
    expect(taxRequest).toHaveBeenCalledWith('start', scan.id, sessionId, draftId, {
      province: '北京市', city: '北京市', companyName: view.enterprise.companyName, taxId: '',
    })
    await find(active.render(fields), named('改为手动填写')).props.onClick()
    for (let i = 0; i < 2; i++) await renderAndSettle()
    expect(taxRequest).toHaveBeenLastCalledWith('cancel', scan.id, sessionId, draftId, {})
    expect(find(section(active.render(fields), taxSource), named('上传税务资料'))).toBeDefined()
    active.remount()
  })

  it('核对页可以从对话发起定向更正，表单保留已填值供核对', async () => {
    const confirm = next(2, { kind: 'confirm', replacesSampleBook: true })
    const revise = next(3, {
      kind: 'fields', title: '更正记账准备', initialValues: { startMonth: '2026-11', lastMonth: '2026-10' },
      fields: [
        { key: 'startMonth', type: 'month', label: '起账月份' },
        { key: 'lastMonth', type: 'month', label: '旧账做到的月份' },
      ],
    })
    const request = vi.fn(async (_session, action) => action === 'card-status'
      ? { accepted: true }
      : { accepted: true, receipt: { labels: ['更正记账准备'] }, nextCard: revise })
    const active = client(request)
    active.render(confirm)
    await settle()
    expect(find(active.render(confirm), named('确认建档')).props.disabled).toBe(true)
    find(active.render(confirm), node => node.type === 'select').props.onChange({ target: { value: 'edit-accounting' } })
    find(active.render(confirm), node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    await settle()
    active.render(confirm)
    await settle()
    expect(request).toHaveBeenCalledWith(sessionId, 'submit-card', {
      cardId: confirm.id, draftId, revision: confirm.revision, choice: 'edit-accounting',
    })
    expect(find(section(active.render(confirm), revise), node => node.type === 'input').props.value).toBe('2026-11')
  })
})
