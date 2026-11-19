import { describe, expect, it, vi } from 'vitest'

import { registerOnboardingChat } from '../client/onboarding-chat.src.js'
import { onboardingFields, taxFields } from '../src/onboarding-fields.js'

const sessionId = 'synthetic-zhangjie'
const cardId = 'e8e802ae-6616-45b5-98b4-1b487cc03c11'
const draftId = '9a78707f-f585-4aa9-b379-fd86b308c011'
const toolId = 'synthetic-call'
const toolCall = { type: 'tool/call', data: { turn: 1, name: 'moneycome_onboarding', callId: toolId } }
const completedTurn = { type: 'turn/end', seq: 20, data: { turn: 1, reason: { kind: 'completed' } } }
const baseCard = { id: cardId, draftId, revision: 5 }

function resultFor(card) {
  return {
    type: 'tool/result', seq: 12, surfaceOp: 'append',
    data: { turn: 1, message: { source: { kind: 'tool', callId: toolId }, content: [
      { type: 'text', text: JSON.stringify({ accepted: true, card }) },
    ] } },
  }
}

function client(onboardingRequest, preset = 'moneycome-zhangjie', extras = {}) {
  let definition
  let renderNode
  const openOnboarding = vi.fn()
  const refreshOnboarding = vi.fn()
  const sendOnboardingReply = vi.fn(async () => {})
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
    jsx, onboardingRequest, openOnboarding, refreshOnboarding, sendOnboardingReply, ...extras,
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
    const start = { location: { kind: 'turn', turn: 1 } }
    const state = [toolCall, resultFor(card), completedTurn].reduce(
      (current, event) => definition.update({ state: current }, { event }),
      definition.start({}, start),
    )
    const node = definition.buildViewNode({ id: '1', key: '1', state, start })
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
    definition, openOnboarding, refreshOnboarding, sendOnboardingReply, render,
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
const fileRow = phase => node => node.props['data-qianlai-document-file'] === phase
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const next = (index, data) => ({ id: 'e8e802ae-6616-45b5-98b4-1b487cc03c1' + index, draftId, revision: 5 + index, ...data })
const section = (tree, card) => find(tree, node => node.props['data-qianlai-onboarding-card'] === card.id)
const companyChoice = next(2, { kind: 'document', documentKind: 'license', fields: [
  { key: 'companyName', type: 'text', label: '企业全称' },
  { key: 'taxId', type: 'text', label: '统一社会信用代码' },
  { key: 'establishedOn', type: 'date', label: '成立日期' },
] })
const companyUpload = next(3, { kind: 'upload', documentKind: 'license' })
const recognizedView = { revision: 9, enterprise: { companyName: '示例服务有限公司', taxId: '111111111111111111' } }

describe('建档对话卡', () => {
  it('从已保存的成立日期回执重新打开可编辑表单，然后保存新值', async () => {
    const archived = {
      ...baseCard, kind: 'fields', title: '更正成立日期', maintenance: { field: 'establishedOn' },
      fields: [{ key: 'establishedOn', type: 'date', label: '成立日期' }], initialValues: { establishedOn: '2025-01-01' },
    }
    const fresh = next(2, { kind: archived.kind, title: archived.title, maintenance: archived.maintenance,
      fields: archived.fields, initialValues: { establishedOn: '2025-03-03' } })
    const receipt = { accepted: true, cardState: 'saved', receipt: { labels: ['成立日期'] } }
    const current = { accepted: true, cardState: 'active', card: fresh }
    const lookup = Promise.withResolvers()
    const request = vi.fn(async (_session, action, payload) => {
      if (action === 'card-status') return payload.cardId === archived.id ? receipt : lookup.promise
      if (action === 'reopen-profile-card') return current
      if (action === 'submit-card') return receipt
    })
    const active = client(request)
    active.render(archived)
    await settle()
    const saved = active.render(archived)
    expect(find(saved, node => node.type === 'form')).toBeUndefined()
    expect(find(saved, info)?.props.children).toBe('已保存 成立日期')
    find(saved, named('再次更正')).props.onClick()
    await settle()
    const reopened = active.render(archived)
    expect(request).toHaveBeenCalledWith(sessionId, 'reopen-profile-card', { cardId: archived.id })
    expect(section(reopened, fresh)?.props['aria-label']).toBe('更正成立日期')
    const date = find(reopened, node => node.props.name === 'establishedOn')
    expect(date.props).toMatchObject({ type: 'date', value: '2025-03-03' })
    date.props.onChange({ target: { value: '2025-03-04' } })
    const edited = active.render(archived)
    expect(find(edited, named('保存更正'))).toBeDefined()
    find(edited, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    await settle()
    expect(request).toHaveBeenCalledWith(sessionId, 'submit-card',
      { cardId: fresh.id, draftId, revision: fresh.revision, values: { establishedOn: '2025-03-04' } })
    lookup.resolve(current)
    await settle()
    expect(find(active.render(archived), node => node.type === 'form')).toBeUndefined()
    expect(active.sendOnboardingReply).not.toHaveBeenCalled()
  })

  it('keeps a tax status blocker on the same card and sends one receipt after saving the correction', async () => {
    const original = { ...baseCard, kind: 'document', documentKind: 'tax', fields: taxFields,
      initialValues: { taxpayerIdentity: 'small-scale', taxStatus: '停业', taxAuthority: '合成税务机关',
        incomeMethod: '查账征收', accountingSystem: '小企业会计准则' } }
    const recheck = { ...baseCard, revision: baseCard.revision + 1, kind: 'fields', correction: true, recheck: true,
      title: '更正纳税人状态', fields: taxFields.filter(field => field.key === 'taxStatus' || field.requiredWhen === 'taxStatus'),
      message: '草稿中的纳税人状态为停业，当前无法继续建档。', initialValues: { taxStatus: '停业' } }
    const request = vi.fn(async (_session, action, { revision }) => {
      if (action === 'card-status') return { accepted: true, card: original }
      if (revision === original.revision) return { accepted: true, card: recheck, incomplete: true }
      return { accepted: true, receipt: { labels: ['纳税人状态'] }, view: { revision: recheck.revision + 1 } }
    })
    const active = client(request)
    active.render(original)
    await settle()
    const submit = () => find(active.render(original), node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    submit()
    await settle()
    const tree = active.render(original)
    const status = find(tree, node => node.props.name === 'taxStatus')
    expect(section(tree, original)?.props['aria-label']).toBe('更正纳税人状态')
    expect(find(tree, info)?.props.children).toBe(recheck.message)
    expect(find(tree, node => node.props.name === 'taxAuthority')).toBeUndefined()
    expect(status.props.value).toBe('停业')
    expect(status.props.children.flat().map(child => child.props.value).filter(Boolean))
      .toEqual(['正常', '停业', '清算', '非正常', '注销', '非正常注销', '其他'])
    expect(active.sendOnboardingReply).not.toHaveBeenCalled()
    status.props.onChange({ target: { value: '正常' } })
    submit()
    await settle()
    expect(request).toHaveBeenLastCalledWith(sessionId, 'submit-card',
      expect.objectContaining({ cardId, revision: recheck.revision, values: { taxStatus: '正常' } }))
    expect(active.sendOnboardingReply).toHaveBeenCalledExactlyOnceWith(sessionId, '我已核对并保存纳税人状态，请继续建档。')
  })

  it('keeps an official blocker visible without offering to change it', async () => {
    const card = { ...baseCard, kind: 'blocked', locked: true, message: '税务机关资料显示该企业处于停业状态。' }
    const active = client(vi.fn(async () => ({ accepted: true, card })))
    active.render(card)
    await settle()
    const tree = active.render(card)
    expect(find(tree, info)?.props.children).toBe(card.message)
    expect(find(tree, named('重新核对资料'))).toBeUndefined()
  })

  it('keeps the four business options compatible with one another and exclusive of "none"', async () => {
    const card = { ...baseCard, kind: 'fields', title: '确认实际经营',
      fields: onboardingFields[1].filter(field => field.key === 'business') }
    const request = vi.fn(async (_session, action) => action === 'card-status' ? { accepted: true, card }
      : { accepted: true, receipt: { labels: ['企业实际开展的业务'] } })
    const active = client(request)
    active.render(card)
    await settle()
    const checkbox = value => find(active.render(card), node => node.props.name === 'business' && node.props.value === value).props
    const pick = value => checkbox(value).onChange({ target: { checked: true } })
    const activities = ['goods', 'production', 'cross-border', 'multiple-entities']
    for (const activity of activities) pick(activity)
    expect(activities.every(activity => checkbox(activity).checked)).toBe(true)
    pick('none')
    expect(checkbox('none').checked).toBe(true)
    expect(activities.some(activity => checkbox(activity).checked)).toBe(false)
    pick('production')
    expect(checkbox('none').checked).toBe(false)
    expect(checkbox('production').checked).toBe(true)
    find(active.render(card), node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    await settle()
    expect(request).toHaveBeenLastCalledWith(sessionId, 'submit-card', expect.objectContaining({ values: { business: ['production'] } }))
  })

  it('shows conditional required Other details on the tax document card', async () => {
    const card = { ...baseCard, kind: 'document', documentKind: 'tax', fields: taxFields }
    const request = vi.fn(async (_session, action) => action === 'card-status' ? { accepted: true, card }
      : { accepted: true, receipt: { labels: ['纳税人状态'] } })
    const active = client(request)
    active.render(card)
    await settle()
    const input = key => find(active.render(card), node => node.props.name === key)
    expect(input('province')).toBeUndefined()
    expect(input('city')).toBeUndefined()
    expect(input('taxStatusOther')).toBeUndefined()
    expect(input('taxStatus').props.children[0].props).toMatchObject({ value: '', disabled: true })
    input('taxStatus').props.onChange({ target: { value: '其他' } })
    expect(input('taxStatusOther').props.required).toBe(true)
    input('accountingSystem').props.onChange({ target: { value: '其他' } })
    expect(input('accountingSystemOther').props.required).toBe(true)
    input('taxStatus').props.onChange({ target: { value: '正常' } })
    expect(input('taxStatusOther')).toBeUndefined()
  })

  it('仅将张姐工具的有效卡片投影到普通聊天，并允许打开右侧当前表单', async () => {
    const view = { revision: 5 }
    const request = vi.fn(async () => ({ accepted: true, view }))
    const active = client(request)
    const card = { ...baseCard, kind: 'fields', fields: [] }
    expect(active.definition.match['tool/call']({ data: { ...toolCall.data, name: 'unrelated' } })).toBeNull()
    expect(active.definition.match['tool/call'](toolCall)).toEqual({ id: '1', role: 'update' })
    expect(active.definition.match['tool/result'](resultFor(card))).toEqual({ id: '1', role: 'update' })
    expect(active.render({ ...card, draftId: 'forged' })).toBeNull()
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
    expect(active.sendOnboardingReply).toHaveBeenCalledExactlyOnceWith(sessionId, '我选择扫码建档。')
    expect(find(active.render(card), info).props.children).toBe('已选择扫码建档')

    active.remount()
    active.render(card)
    await settle()
    expect(find(active.render(card), info).props.children).toBe('已选择扫码建档')
    expect(find(active.render(card), named('扫码建档'))).toBeUndefined()
    expect(active.openOnboarding).toHaveBeenCalledTimes(1)
    expect(active.sendOnboardingReply).toHaveBeenCalledTimes(1)
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
    expect(active.sendOnboardingReply).toHaveBeenCalledExactlyOnceWith(sessionId, '我已填写统一社会信用代码、税务地区，请继续建档。')
    expect(find(active.render(card), node => node.type === 'input')).toBeUndefined()
  })

  it('在原对话选择执照，只预填同一张卡并保留手填值，确认后才同步保存', async () => {
    const mode = { ...baseCard, kind: 'mode' }
    const persisted = new Map()
    const request = vi.fn(async (_session, action, { cardId, ...input }) => {
      if (action === 'card-status') return persisted.get(cardId) ?? { accepted: true }
      if (action === 'recognize') return { accepted: true, fields: { ...recognizedView.enterprise,
        ...(input.file.name === '更清晰的合成执照.png' ? { taxId: '111111111111111122' } : {}),
      } }
      const result = {
        [mode.id]: { receipt: { mode: input.mode } },
        [companyChoice.id]: { receipt: { labels: ['企业全称', '统一社会信用代码', '成立日期'] }, view: recognizedView },
      }[cardId]
      persisted.set(cardId, { accepted: true, ...result })
      return persisted.get(cardId)
    })
    const readOnboardingFile = vi.fn(async () => 'dGVzdA==')
    const active = client(request, undefined, { readOnboardingFile })
    const choose = async (card, label) => {
      const click = find(active.render(card), named(label)).props.onClick
      click()
      click()
      await settle()
    }
    active.render(mode)
    await settle()
    await choose(mode, '手动填写')
    expect(section(active.render(mode), companyChoice)).toBeUndefined()
    expect(active.sendOnboardingReply).toHaveBeenCalledExactlyOnceWith(sessionId, '我选择手动填写。')
    active.render(companyChoice)
    await settle()
    const nativeInput = find(active.render(companyChoice), node => node.type === 'input' && node.props.type === 'file')
    const pick = files => find(active.render(companyChoice), node => node.type === 'input' && node.props.type === 'file')
      .props.onChange({ target: { files } })
    const openPicker = vi.fn()
    nativeInput.props.ref.current = { click: openPicker }
    await choose(companyChoice, '选择营业执照')
    expect(openPicker).toHaveBeenCalled()
    expect(request.mock.calls.filter(([, action]) => action === 'submit-card')).toHaveLength(1)
    expect(active.sendOnboardingReply).toHaveBeenCalledTimes(1)
    pick([])
    expect(readOnboardingFile).not.toHaveBeenCalled()
    expect(section(active.render(companyChoice), companyUpload)).toBeUndefined()
    find(active.render(companyChoice), node => node.props.name === 'companyName').props.onChange({ target: { value: '已经手填的合成企业' } })
    const file = { name: '示例营业执照.png', type: 'image/png', size: 4 }
    pick([file])
    const reading = active.render(companyChoice)
    const row = find(reading, fileRow('reading'))
    expect(find(row, node => node.type === 'strong').props.children).toBe(file.name)
    expect(find(row, info).props.children).toBe('文件已接收，结果会先请你核对。')
    expect(find(row, named('选择营业执照'))).toBeUndefined()
    const companyInput = find(reading, node => node.props.name === 'companyName').props
    expect(companyInput.disabled).toBe(false)
    companyInput.onChange({ target: { value: '识别期间继续手填的合成企业' } })
    expect(find(reading, named('保存到草稿')).props.disabled).toBe(true)
    await settle()
    let preview = active.render(companyChoice)
    expect(find(preview, info).props.children).toBe('保留了原先填写的企业全称。请对照资料核对后确认。')
    expect(find(preview, node => node.props.name === 'companyName').props.value).toBe('识别期间继续手填的合成企业')
    expect(find(preview, node => node.props.name === 'taxId').props.value).toBe('111111111111111111')
    expect(find(preview, node => node.props.name === 'establishedOn').props.value).toBe('')
    expect(active.refreshOnboarding).not.toHaveBeenCalled()
    expect(active.sendOnboardingReply).toHaveBeenCalledTimes(1)

    expect(readOnboardingFile).toHaveBeenCalledExactlyOnceWith(file)
    expect(request).toHaveBeenCalledWith(sessionId, 'recognize', {
      cardId: companyChoice.id, draftId, revision: companyChoice.revision,
      file: { name: file.name, mimeType: file.type, base64: 'dGVzdA==' },
    })
    pick([{ ...file, name: '更清晰的合成执照.png' }])
    await settle()
    preview = active.render(companyChoice)
    expect(find(preview, node => node.props.name === 'companyName').props.value).toBe('识别期间继续手填的合成企业')
    expect(find(preview, node => node.props.name === 'taxId').props.value).toBe('111111111111111122')
    expect(find(preview, named('保存到草稿'))).toBeDefined()
    find(preview, node => node.props.name === 'establishedOn').props.onChange({ target: { value: '2026-01-01' } })
    preview = active.render(companyChoice)
    expect(find(preview, named('确认公司资料'))).toBeDefined()
    find(preview, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    await settle()
    expect(request).toHaveBeenCalledWith(sessionId, 'submit-card', {
      cardId: companyChoice.id, draftId, revision: companyChoice.revision,
      values: { companyName: '识别期间继续手填的合成企业', taxId: '111111111111111122', establishedOn: '2026-01-01' },
    })
    expect(active.refreshOnboarding).toHaveBeenCalledWith(sessionId, recognizedView)
    expect(active.sendOnboardingReply.mock.calls).toEqual([
      [sessionId, '我选择手动填写。'],
      [sessionId, '我已核对并确认公司资料，请继续建档。'],
    ])
    active.remount()
    active.render(companyChoice)
    await settle()
    expect(find(active.render(companyChoice), info).props.children).toBe('已保存 企业全称、统一社会信用代码、成立日期')
    expect(readOnboardingFile).toHaveBeenCalledTimes(2)
    expect(active.sendOnboardingReply).toHaveBeenCalledTimes(2)
  })

  it('只保存成立日期后原卡继续补充两项，不向对话发送确认', async () => {
    const pending = {
      ...companyChoice, revision: companyChoice.revision + 1,
      fields: companyChoice.fields.filter(field => field.key !== 'establishedOn'),
    }
    const view = { draftId, revision: pending.revision, enterprise: { establishedOn: '2026-01-01' } }
    const request = vi.fn(async (_session, action) => action === 'card-status'
      ? { accepted: true } : { accepted: true, incomplete: true, card: pending, view })
    const active = client(request)
    active.render(companyChoice)
    await settle()
    find(active.render(companyChoice), node => node.props.name === 'establishedOn').props.onChange({ target: { value: '2026-01-01' } })
    const filling = active.render(companyChoice)
    expect(find(filling, named('保存到草稿'))).toBeDefined()
    find(filling, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    await settle()
    expect(request).toHaveBeenCalledWith(sessionId, 'submit-card', {
      cardId: companyChoice.id, draftId, revision: companyChoice.revision, values: { establishedOn: '2026-01-01' },
    })
    const updated = active.render(companyChoice)
    expect(find(updated, node => node.props.name === 'establishedOn')).toBeUndefined()
    expect(find(updated, node => node.props.name === 'companyName')).toBeDefined()
    expect(active.refreshOnboarding).toHaveBeenCalledExactlyOnceWith(sessionId, view)
    expect(active.sendOnboardingReply).not.toHaveBeenCalled()
  })

  it('拖到卡片收起宿主遮罩，识别失败后可在原文件行重试', async () => {
    let attempts = 0
    const request = vi.fn(async (_session, action) => {
      if (action === 'recognize') {
        if (++attempts === 1) throw Error('未能识别这份资料，请重试。')
        return { accepted: true, fields: { companyName: '合成服务有限公司' } }
      }
      return { accepted: true }
    })
    const readOnboardingFile = vi.fn(async () => 'dGVzdA==')
    const active = client(request, undefined, { readOnboardingFile })
    active.render(companyChoice)
    await settle()
    const file = { name: '合成营业执照.pdf', type: 'application/pdf', size: 4 }
    const card = active.render(companyChoice)
    const host = new EventTarget()
    host.Event = Event
    let globalMask = true // A file drag previously entered the document outside the card.
    host.addEventListener('dragend', () => { globalMask = false })
    const currentTarget = { ownerDocument: { defaultView: host } }
    const event = {
      currentTarget, dataTransfer: { types: ['Files'], files: [file, file] },
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    }
    card.props.onDragEnter(event)
    expect(globalMask).toBe(false)
    expect(active.render(companyChoice).props.style.outline).toBeDefined()
    card.props.onDrop(event)
    expect(find(active.render(companyChoice), node => node.props.role === 'alert').props.children).toContain('一次只能识别一份资料')
    expect(readOnboardingFile).not.toHaveBeenCalled()
    event.dataTransfer.files = [file]
    globalMask = true
    card.props.onDrop(event)
    expect(globalMask).toBe(false)
    const reading = active.render(companyChoice)
    expect(reading.props.style.outline).toBeUndefined()
    expect(find(find(reading, fileRow('reading')), node => node.type === 'strong').props.children).toBe(file.name)
    expect(find(reading, node => node.props.className === 'qianlai-document-reading')).toBeDefined()
    await settle()
    expect(event.preventDefault).toHaveBeenCalledTimes(3)
    expect(event.stopPropagation).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenCalledWith(sessionId, 'recognize', {
      cardId: companyChoice.id, draftId, revision: companyChoice.revision,
      file: { name: file.name, mimeType: file.type, base64: 'dGVzdA==' },
    })
    const errorRow = find(active.render(companyChoice), fileRow('error'))
    expect(find(errorRow, node => node.props.role === 'alert').props.children).toBe('未能识别这份资料，请重试。')
    expect(find(errorRow, named('更换文件')).props.disabled).toBe(false)
    const retry = find(errorRow, named('重试这份文件')).props.onClick
    retry()
    retry()
    expect(find(active.render(companyChoice), fileRow('reading'))).toBeDefined()
    await settle()
    expect(readOnboardingFile.mock.calls).toEqual([[file], [file]])
    expect(find(active.render(companyChoice), fileRow('ready'))).toBeDefined()
    expect(active.refreshOnboarding).not.toHaveBeenCalled()
    expect(active.sendOnboardingReply).not.toHaveBeenCalled()
  })

  it.each([
    { card: companyChoice, title: '添加营业执照', field: 'companyName', value: '合成公司有限公司', direct: true },
    { card: next(4, { kind: 'document', documentKind: 'tax', fields: [
      { key: 'taxAuthority', type: 'text', label: '主管税务机关' },
    ] }), title: '添加税务资料', field: 'taxAuthority', value: '合成税务机关', direct: false },
  ])('$title 可直接粘贴图片，识别结果留在当前卡片核对', async ({ card, title, field, value, direct }) => {
    const request = vi.fn(async (_session, action) => action === 'recognize' ? { fields: { [field]: value } } : { accepted: true })
    const readOnboardingFile = vi.fn(async () => 'dGVzdA==')
    const active = client(request, undefined, { readOnboardingFile })
    active.render(card)
    await settle()
    const current = active.render(card)
    const area = find(current, node => node.props['aria-label'] === title)
    expect(area.props.tabIndex).toBe(0)
    const image = { name: '合成截图.png', type: 'image/png', size: 4 }
    const event = {
      target: { closest: vi.fn(() => null) },
      clipboardData: { files: direct ? [image] : [], items: [{ kind: 'file', getAsFile: () => image }] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }
    current.props.onPaste({ ...event, clipboardData: { files: [], items: [{ kind: 'string' }] } })
    current.props.onPaste({ ...event, target: { closest: () => ({}) } })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(readOnboardingFile).not.toHaveBeenCalled()

    current.props.onPaste({ ...event, clipboardData: { files: [image, image] } })
    expect(find(active.render(card), node => node.props.role === 'alert').props.children).toContain('一次只能识别一份资料')
    expect(readOnboardingFile).not.toHaveBeenCalled()

    current.props.onPaste(event)
    expect(find(find(active.render(card), fileRow('reading')), node => node.type === 'strong').props.children).toBe(image.name)
    await settle()
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(event.stopPropagation).toHaveBeenCalledTimes(2)
    expect(readOnboardingFile).toHaveBeenCalledExactlyOnceWith(image)
    expect(request).toHaveBeenCalledWith(sessionId, 'recognize', {
      cardId: card.id, draftId, revision: card.revision,
      file: { name: image.name, mimeType: image.type, base64: 'dGVzdA==' },
    })
    expect(find(active.render(card), node => node.props.name === field).props.value).toBe(value)
    expect(find(active.render(card), node => node.props.role === 'alert')).toBeUndefined()
    expect(active.refreshOnboarding).not.toHaveBeenCalled()
    expect(active.sendOnboardingReply).not.toHaveBeenCalled()
  })

  it('侧栏保存后阻止旧聊天卡继续提交，用户可以按最新草稿开启下一轮', async () => {
    let update
    const request = vi.fn(async () => ({ accepted: true }))
    const active = client(request, undefined, { subscribeOnboarding: listener => { update = listener } })
    active.render(companyChoice)
    await settle()
    expect(find(active.render(companyChoice), named('选择营业执照'))).toBeDefined()
    update(sessionId, { view: { draftId, revision: companyChoice.revision + 1 } })
    expect(find(active.render(companyChoice), named('选择营业执照'))).toBeUndefined()
    expect(active.sendOnboardingReply).not.toHaveBeenCalled()
    find(active.render(companyChoice), named('继续建档')).props.onClick()
    await settle()
    expect(request).toHaveBeenCalledExactlyOnceWith(sessionId, 'card-status', { cardId: companyChoice.id })
    expect(active.sendOnboardingReply).toHaveBeenCalledExactlyOnceWith(sessionId, '请按最新资料继续建档。')
  })

  it('银行账户卡把稍后补资料和保存放在同一右对齐操作区', async () => {
    const bank = next(4, { kind: 'bank' })
    const request = vi.fn(async (_session, action) => action === 'card-status'
      ? { accepted: true }
      : { accepted: true, receipt: { labels: ['稍后补账户资料'] } })
    const active = client(request)
    active.render(bank)
    await settle()
    const form = find(active.render(bank), node => node.type === 'form')
    const footer = find(form, node => node.props.style?.justifyContent === 'flex-end')
    expect(footer.props.style.flexWrap).toBe('wrap')
    expect(footer.props.children.map(button => [button.props.children, button.props.type]))
      .toEqual([['稍后补账户资料', 'button'], ['保存到草稿', 'submit']])
    find(footer, named('稍后补账户资料')).props.onClick()
    await settle()
    expect(request).toHaveBeenLastCalledWith(sessionId, 'submit-card', {
      cardId: bank.id, draftId, revision: bank.revision, choice: 'skip',
    })
  })

  it('银行账号离开输入框时提示格式错误，修正后保存，重复账号提示仍归在字段下', async () => {
    const bank = next(4, { kind: 'bank' })
    const submit = vi.fn(async () => { throw Object.assign(Error('该银行账号已在账户列表中，请填写另一个账号。'), {
      details: { field: 'number', index: 1 },
    }) })
    const request = vi.fn(async (_session, action, payload) => action === 'card-status'
      ? { accepted: true, card: bank, view: recognizedView } : submit(payload))
    const active = client(request)
    const field = name => find(active.render(bank), node => node.props.name === name).props
    const form = () => find(active.render(bank), node => node.type === 'form').props
    active.render(bank)
    await settle()
    field('number').onChange({ target: { value: '123' } })
    field('number').onBlur()
    expect(field('number')).toMatchObject({ value: '123', 'aria-invalid': true })
    expect(find(active.render(bank), node => node.props.id === field('number')['aria-describedby']).props.children)
      .toContain('请输入 4 至 34 位数字')
    form().onSubmit({ preventDefault() {} })
    expect(submit).not.toHaveBeenCalled()
    field('bank').onChange({ target: { value: '合成银行' } })
    field('number').onChange({ target: { value: '12 34-56' } })
    expect(field('number')['aria-invalid']).toBeUndefined()
    form().onSubmit({ preventDefault() {} })
    await settle()
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ values: expect.objectContaining({ number: '12 34-56' }) }))
    expect(field('number')).toMatchObject({ value: '12 34-56', 'aria-invalid': true })
    expect(find(active.render(bank), node => node.props.id === field('number')['aria-describedby']).props.children)
      .toContain('已在账户列表中')
  })

  it('选择地区后立刻打开官方扫码，重开对话只恢复状态，用户核对后再回填', async () => {
    vi.useFakeTimers()
    try {
      const region = next(2, { kind: 'region' })
      const scan = next(3, { kind: 'tax-scan', province: '北京市', city: '北京市', autoStart: true })
      const bank = next(4, { kind: 'bank' })
      const selectedView = { revision: scan.revision, enterprise: { companyName: '', taxId: '' } }
      const profile = { companyName: '示例服务有限公司', taxId: '111111111111111111' }
      let selected = false
      let applied = false
      let claimed = false
      const request = vi.fn(async (_session, action, input) => {
        if (action === 'claim-tax-auto-start') {
          const start = !claimed
          claimed = true
          return { accepted: true, start }
        }
        if (action === 'submit-card') selected = true
        if (input.cardId === region.id) return selected ? { accepted: true, receipt: { labels: ['税务地区'] }, nextCard: scan, view: selectedView } : { accepted: true }
        if (input.cardId === scan.id) return applied
          ? { accepted: true, receipt: { labels: ['官方税务资料'] }, view: recognizedView, nextCard: bank }
          : { accepted: true, view: selectedView }
        return { accepted: true, view: recognizedView }
      })
      let submitting = false
      const taxRequest = vi.fn(async action => {
        if (action === 'start') return { phase: 'waiting', message: '请扫码并选择企业。' }
        if (action === 'status') {
          if (submitting) {
            applied = true
            return { phase: 'submitted' }
          }
          return { phase: 'ready', profile }
        }
        if (action === 'submit') {
          submitting = true
          return { phase: 'submitting' }
        }
      })
      const previewOnboardingTax = vi.fn()
      const active = client(request, undefined, {
        taxRequest, previewOnboardingTax, taxRegionCities: { 北京市: ['北京市'], 浙江省: ['杭州市', '宁波市'] },
      })
      const pick = (label, value) => find(find(active.render(region), node => node.type === 'label' && node.props.children[0] === label),
        node => node.type === 'select').props.onChange({ target: { value } })
      const renderAndSettle = async card => { active.render(card); await settle() }
      await renderAndSettle(region)
      pick('省份', '浙江省')
      pick('城市或地区', '宁波市')
      pick('省份', '北京市')
      const cityLabel = find(active.render(region), node => node.type === 'label' && node.props.children[0] === '城市或地区')
      expect(find(cityLabel, node => node.type === 'select').props.value).toBe('')
      expect(find(cityLabel, node => node.type === 'option' && node.props.value === '宁波市')).toBeUndefined()
      pick('城市或地区', '北京市')
      find(active.render(region), node => node.type === 'form').props.onSubmit({ preventDefault() {} })
      await settle()
      expect(section(active.render(region), scan)).toBeUndefined()
      expect(active.sendOnboardingReply).toHaveBeenCalledExactlyOnceWith(sessionId, '我的税务地区是北京市，请继续。')
      expect(taxRequest).not.toHaveBeenCalled()
      await renderAndSettle(scan)
      await renderAndSettle(scan)
      expect(taxRequest).toHaveBeenCalledExactlyOnceWith('start', scan.id, sessionId, draftId, {
        province: '北京市', city: '北京市', companyName: '', taxId: '',
      })
      expect(find(active.render(scan), named('重试读取'))).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1400)
      expect(previewOnboardingTax).toHaveBeenCalledWith(sessionId, profile, draftId)
      expect(find(active.render(scan), named('核对无误，回填税务资料'))).toBeDefined()

      active.remount()
      for (let i = 0; i < 4; i++) await renderAndSettle(scan)
      expect(taxRequest.mock.calls.filter(([action]) => action === 'start')).toHaveLength(1)
      expect(taxRequest.mock.calls.filter(([action]) => action === 'submit')).toHaveLength(0)
      find(active.render(scan), named('核对无误，回填税务资料')).props.onClick()
      await settle()
      expect(taxRequest).toHaveBeenLastCalledWith('submit', scan.id, sessionId, draftId, {})
      expect(active.sendOnboardingReply).toHaveBeenCalledTimes(1)
      active.render(scan)
      await vi.advanceTimersByTimeAsync(1400)
      expect(active.refreshOnboarding).toHaveBeenCalledWith(sessionId, recognizedView)
      expect(section(active.render(scan), bank)).toBeUndefined()
      expect(active.sendOnboardingReply).toHaveBeenLastCalledWith(sessionId, '我已核对并回填税务资料，请继续建档。')
      active.remount()
      await renderAndSettle(scan)
      expect(active.sendOnboardingReply).toHaveBeenCalledTimes(2)
      active.remount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('历史和当前字段卡都隐藏切换方式，取消扫码不替用户切换方式或发新消息', async () => {
    const fields = next(2, {
      kind: 'fields', title: '补充公司资料', canSwitchToScan: true,
      fields: [
        { key: 'companyName', type: 'text', label: '企业全称' },
        { key: 'establishedOn', type: 'date', label: '成立日期' },
      ],
    })
    const scan = next(3, { kind: 'tax-scan', province: '北京市', city: '北京市' })
    const view = { revision: scan.revision, enterprise: { companyName: '示例服务有限公司', taxId: '' } }
    const request = vi.fn(async () => ({ accepted: true, view }))
    const taxRequest = vi.fn(async action => action === 'cancel' ? { phase: 'idle' } : { phase: 'waiting' })
    const active = client(request, undefined, { taxRequest })
    active.render(fields)
    await settle()
    expect(find(active.render(fields), named('改为扫码建档'))).toBeUndefined()
    active.render(scan)
    await settle()
    active.render(scan)
    await settle()
    expect(find(active.render(scan), named('改为手动填写'))).toBeUndefined()
    find(active.render(scan), named('取消扫码')).props.onClick()
    await settle()
    expect(taxRequest).toHaveBeenLastCalledWith('cancel', scan.id, sessionId, draftId, {})
    expect(find(active.render(scan), named('重新打开扫码页'))).toBeDefined()
    expect(request.mock.calls.map(([, action]) => action)).toEqual(['card-status', 'card-status'])
    expect(active.sendOnboardingReply).not.toHaveBeenCalled()
    active.remount()
  })

  it('切换方式后，历史扫码卡不再显示重新打开入口', async () => {
    const scan = next(3, { kind: 'tax-scan', province: '北京市', city: '北京市' })
    const view = { draftId, revision: scan.revision, mode: 'scan' }
    let update
    const unsubscribe = vi.fn()
    const active = client(vi.fn(async () => ({ accepted: true, view })), undefined, {
      subscribeOnboarding: listener => { update = listener; return unsubscribe },
      taxRequest: vi.fn(async () => ({ phase: 'failed', message: '官方登录窗口已关闭。' })),
    })
    active.render(scan)
    await settle()
    active.render(scan)
    await settle()
    expect(find(active.render(scan), named('重新打开扫码页'))).toBeDefined()
    update('another-session', { view: { ...view, mode: 'manual', revision: view.revision + 1 } })
    expect(find(active.render(scan), named('重新打开扫码页'))).toBeDefined()
    update(sessionId, { view: { ...view, mode: 'manual', revision: view.revision + 1 } })
    expect(find(active.render(scan), named('重新打开扫码页'))).toBeUndefined()
    active.remount()
    expect(unsubscribe).toHaveBeenCalledOnce()
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
    const footer = find(active.render(confirm), node => node.props.style?.justifyContent === 'flex-end' &&
      node.props.children?.some?.(child => child && named('确认建档')(child)))
    expect(footer.props.children.map(button => button.props.children)).toEqual(['查看建档表单', '确认建档'])
    expect(find(footer, named('确认建档')).props.disabled).toBe(true)
    find(active.render(confirm), node => node.type === 'select').props.onChange({ target: { value: 'edit-accounting' } })
    find(active.render(confirm), node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    await settle()
    active.render(confirm)
    await settle()
    expect(request).toHaveBeenCalledWith(sessionId, 'submit-card', {
      cardId: confirm.id, draftId, revision: confirm.revision, choice: 'edit-accounting',
    })
    expect(section(active.render(confirm), revise)).toBeUndefined()
    expect(active.sendOnboardingReply).toHaveBeenCalledExactlyOnceWith(sessionId, '我要更正记账准备。')
    active.render(revise)
    await settle()
    expect(find(active.render(revise), node => node.type === 'input').props.value).toBe('2026-11')
  })

  it('对话发送失败时可单独重试，重复点击不会再次提交草稿', async () => {
    const card = { ...baseCard, kind: 'mode' }
    const request = vi.fn(async (_session, action) => action === 'card-status' ? { accepted: true }
      : { accepted: true, receipt: { mode: 'scan' } })
    const sendOnboardingReply = vi.fn().mockRejectedValueOnce(Error('暂时不可用')).mockResolvedValue(undefined)
    const active = client(request, undefined, { sendOnboardingReply })
    active.render(card)
    await settle()
    find(active.render(card), named('扫码建档')).props.onClick()
    await settle()
    const retry = find(active.render(card), named('重试发送到对话')).props.onClick
    retry()
    retry()
    await settle()
    expect(request.mock.calls.filter(([, action]) => action === 'submit-card')).toHaveLength(1)
    expect(sendOnboardingReply.mock.calls).toEqual([[sessionId, '我选择扫码建档。'], [sessionId, '我选择扫码建档。']])
    expect(find(active.render(card), named('重试发送到对话'))).toBeUndefined()
  })
})
