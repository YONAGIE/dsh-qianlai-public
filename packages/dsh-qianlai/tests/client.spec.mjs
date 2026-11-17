import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import { taxRegionCities, taxScanCities } from '../src/tax-portals.js'

function makeClient() {
  const source = readFileSync(new URL('../client/client.src.js', import.meta.url), 'utf8')
    .replace('/* tax-region-catalogue */ {}', JSON.stringify(taxRegionCities))
    .replace('/* tax-scan-cities */ {}', JSON.stringify(taxScanCities()))
    .replace('/* onboarding-chat-client */', 'function registerOnboardingChat(_ctx, client) { window.onboardingClient = client }')
  const fibers = new Map()
  const pendingEffects = []
  const intervals = new Map()
  const registrations = []
  const calls = []
  let activeFiber
  let hookIndex
  let intervalId = 0
  let status = { status: 'connected' }
  let onboarding
  let tabOpen = false
  let rendered
  const sessionId = 'synthetic-session'
  const target = { sessionId, paneId: 'synthetic-pane' }
  const tabTypes = []
  const sidebarRight = {
    commandTarget: vi.fn(() => target),
    openTabFromTarget: vi.fn(() => { tabOpen = true }),
  }
  const sidebarRightTabs = { register: definition => tabTypes.push(definition) }
  const send = vi.fn(async () => {})
  const sessions = { scope: vi.fn(id => id === sessionId ? {
    get: service => service === 'conversation' ? { send } : undefined,
  } : undefined) }
  const react = {
    useId() {
      const index = hookIndex++
      return activeFiber.hooks[index] ??= `test-id-${index}`
    },
    useState(initial) {
      const fiber = activeFiber
      const index = hookIndex++
      if (!(index in fiber.hooks)) fiber.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [fiber.hooks[index], value => { fiber.hooks[index] = typeof value === 'function' ? value(fiber.hooks[index]) : value }]
    },
    useRef(initial) {
      const index = hookIndex++
      return activeFiber.hooks[index] ??= { current: initial }
    },
    useEffect(callback, dependencies) {
      const fiber = activeFiber
      const index = hookIndex++
      const previous = fiber.hooks[index]
      const unchanged = previous && dependencies && dependencies.length === previous.dependencies?.length
        && dependencies.every((value, item) => Object.is(value, previous.dependencies[item]))
      if (!unchanged) pendingEffects.push({ fiber, index, callback, dependencies })
    },
  }
  const jsx = (type, props) => ({ type, props })
  const window = {
    crypto: { randomUUID: () => 'synthetic-flow' },
    __ModuleLoader__: { load(definition) { this.factory = definition.factory } },
  }
  const timerSet = globalThis.setTimeout
  const timerClear = globalThis.clearTimeout
  runInNewContext(source, {
    window,
    AbortController,
    AbortSignal,
    setTimeout: timerSet,
    clearTimeout: timerClear,
    setInterval(callback) { const id = ++intervalId; intervals.set(id, callback); return id },
    clearInterval(id) { intervals.delete(id) },
  })
  const plugin = window.__ModuleLoader__.factory(name => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx }
    throw Error(`unexpected client dependency: ${name}`)
  })
  const connection = { rpc: { call: vi.fn(async (_path, _method, payload) => {
    if (_method === 'qianlai/company-onboarding') return { ok: true, value: await onboarding(payload) }
    calls.push(payload.action)
    return { ok: true, value: { ...status } }
  }) } }
  const ctx = {
    inject(dependencies, callback) {
      if (dependencies[0] === 'connection') callback({ connection, effect() {} })
      else if (dependencies.includes('sessions') && dependencies.includes('conversation')) callback({ sessions, effect() {} })
      else if (dependencies[0] === 'theme') callback({ theme: { overrideTokens: () => () => {} }, effect() {} })
      else if (dependencies[0] === 'uiConversation') callback({ uiConversation: { events: { register() {}, entries: () => [] } } })
      else if (dependencies[0] === 'sidebarRight') callback({ sidebarRight, sidebarRightTabs, effect: install => install() })
    },
    slots: {
      inject(_name, callback) { callback() },
      register(definition, component) { registrations.push({ definition, component }) },
    },
  }
  plugin.apply(ctx)
  const header = registrations.find(({ definition }) => definition.name === 'conversation.session.header.actions').component
  const onboardingTab = registrations.find(({ definition }) => definition.name === 'sidebar.right.pane.tab').component
  const useSessions = selector => selector({ byId: { [sessionId]: { projectionValues: { agentPreset: 'moneycome-zhangjie' } } } })

  function resolve(node) {
    if (Array.isArray(node)) return node.map(resolve)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return renderComponent(node.type, node.props)
    return { ...node, props: { ...node.props, children: resolve(node.props.children) } }
  }
  function renderComponent(component, props) {
    const fiber = fibers.get(component) ?? { hooks: [] }
    fibers.set(component, fiber)
    rendered.add(component)
    const previousFiber = activeFiber
    const previousIndex = hookIndex
    activeFiber = fiber
    hookIndex = 0
    const tree = component(props)
    activeFiber = previousFiber
    hookIndex = previousIndex
    return resolve(tree)
  }
  function render() {
    rendered = new Set()
    const tree = [renderComponent(header, { sessionId, useSessions }), tabOpen ? renderComponent(onboardingTab, { sessionId, useSessions }) : null]
    for (const [component, fiber] of fibers) {
      if (rendered.has(component)) continue
      for (const hook of fiber.hooks) hook?.cleanup?.()
      fibers.delete(component)
    }
    for (const effect of pendingEffects.splice(0)) {
      effect.fiber.hooks[effect.index]?.cleanup?.()
      const cleanup = effect.callback()
      effect.fiber.hooks[effect.index] = { dependencies: effect.dependencies, cleanup }
    }
    return tree
  }
  function findNodes(node, type, found = []) {
    if (Array.isArray(node)) for (const child of node) findNodes(child, type, found)
    else if (node && typeof node === 'object') {
      if (node.type === type) found.push(node)
      findNodes(node.props?.children, type, found)
    }
    return found
  }
  const findButtons = node => findNodes(node, 'button')
  function getText(node) {
    if (Array.isArray(node)) return node.map(getText).join(' ')
    return node && typeof node === 'object' ? getText(node.props?.children) : String(node ?? '')
  }
  function dispose() {
    for (const fiber of fibers.values()) for (const hook of fiber.hooks) hook?.cleanup?.()
    intervals.clear()
  }
  return {
    calls,
    connection,
    registrations,
    sidebarRight,
    tabTypes,
    send,
    sessions,
    sendOnboardingReply: (id, text) => window.onboardingClient.sendOnboardingReply(id, text),
    openOnboarding() { window.onboardingClient.openOnboarding(sessionId) },
    subscribeOnboarding(listener) { return window.onboardingClient.subscribeOnboarding(listener) },
    closeOnboarding() { tabOpen = false; render() },
    refreshOnboarding(view) { window.onboardingClient.refreshOnboarding(sessionId, view) },
    previewOnboardingTax(profile, draftId) { window.onboardingClient.previewOnboardingTax(sessionId, profile, draftId) },
    dispose,
    intervals,
    render,
    setStatus(value) { status = value },
    setOnboarding(respond) { onboarding = respond },
    text() { return getText(render()) },
    controls() { return ['input', 'select', 'button'].flatMap(type => findNodes(render()[1], type)) },
    editSection(label) {
      const button = findButtons(render()[1]).find(node => node.props['aria-label'] === '编辑' + label)
      if (!button) throw Error('edit button unavailable: ' + label)
      button.props.onClick()
    },
    input(name) { return this.controls().find(node => node.props.name === name)?.props },
    submitForm() { findNodes(render()[1], 'form')[0].props.onSubmit({ preventDefault() {} }) },
    buttonText() { return findButtons(render())[0]?.props.children },
    buttons() { return findButtons(render()).map(node => node.props.children) },
    click(text) {
      const button = findButtons(render()).find(node => node.props.children === text)
      if (!button || button.props.disabled) throw Error('button unavailable: ' + text)
      button.props.onClick()
    },
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
}

describe('WeChat header status', () => {
  it('opens the connected panel without starting handoff and issues a new start after disconnect', async () => {
    const client = makeClient()
    try {
      client.render()
      await settle()
      client.click('微信已连接')
      client.render()
      await settle()
      expect(client.calls).toEqual(['status', 'status'])
      expect(client.buttons()).toContain('断开连接')

      client.setStatus({ status: 'disconnected' })
      client.click('断开连接')
      await settle()
      expect(client.buttons()).toEqual(['连接微信'])
      expect(client.calls).toContain('disconnect')
      expect(client.calls).not.toContain('start')

      client.click('连接微信')
      client.render()
      await settle()
      expect(client.calls.at(-1)).toBe('start')
    } finally {
      client.dispose()
    }
  })

  it('keeps status polling while closed and reflects disconnect and recovery', async () => {
    const client = makeClient()
    try {
      client.render()
      await settle()
      expect(client.buttonText()).toBe('微信已连接')
      expect(client.calls[0]).toBe('status')

      client.setStatus({ status: 'error', message: '微信连接中断，正在自动重连。' })
      for (const poll of client.intervals.values()) poll()
      await settle()
      expect(client.buttonText()).toBe('微信连接异常，点击查看')

      client.setStatus({ status: 'connected', message: '微信连接已恢复。' })
      for (const poll of client.intervals.values()) poll()
      await settle()
      expect(client.buttonText()).toBe('微信已连接')
    } finally {
      client.dispose()
    }
  })
})


const sampleDraft = { accepted: true, draftId: 'synthetic-draft', revision: 0, step: 1, completed: false, replacesSampleBook: true }

describe('Zhangjie onboarding sidebar', () => {
  it('uses the native scoped conversation to send the card answer to its originating session', async () => {
    const client = makeClient()
    const message = '我选择扫码建档。'
    await client.sendOnboardingReply('synthetic-session', message)
    expect(client.sessions.scope).toHaveBeenCalledExactlyOnceWith('synthetic-session')
    expect(client.send).toHaveBeenCalledExactlyOnceWith(message)
    expect(() => client.sendOnboardingReply('another-session', message)).toThrow('当前对话暂时无法发送消息')
    expect(client.send).toHaveBeenCalledTimes(1)
  })

  it('shows saved chat changes and only masked account numbers in the sidebar', async () => {
    const client = makeClient()
    let draft = sampleDraft
    const respond = vi.fn(() => draft)
    client.setOnboarding(respond)
    try {
      expect(client.buttons()).not.toContain('开始建档')
      expect(client.registrations.some(({ definition }) => definition.name === 'conversation.input.dock')).toBe(false)
      expect(client.tabTypes).toEqual([expect.objectContaining({ id: 'moneycome-onboarding', keepMounted: true })])
      client.openOnboarding()
      expect(client.sidebarRight.openTabFromTarget).toHaveBeenCalledExactlyOnceWith('moneycome-onboarding', { sessionId: 'synthetic-session', paneId: 'synthetic-pane' })
      client.render()
      await settle()
      expect(client.text()).toContain('1/4 · 企业信息')

      draft = { ...sampleDraft, revision: 3, step: 4,
        enterprise: { companyName: '合成小店', bankStatus: 'provided',
          accounts: [{ bank: '合成银行', number: '000000654321', maskedNumber: '尾号 4321', currency: 'CNY' }] },
        accounting: { history: 'previous', lastMonth: '2025-07', startMonth: '2025-08' },
        payroll: { payroll: 'scheduled', payday: 25, social: 'partial' },
      }
      client.refreshOnboarding(draft)
      expect(client.text()).toContain('4/4 · 确认建档')
      expect(client.text()).toContain('合成小店')
      expect(client.text()).toContain('尾号 4321')
      expect(client.text()).not.toContain('000000654321')
      expect(client.text()).toContain('2025-08')
      expect(client.text()).toContain('每月 25 日')
      expect(client.controls()).toHaveLength(5)
      expect(client.controls().every(node => node.type === 'button' && node.props.children === '编辑')).toBe(true)

      client.closeOnboarding()
      client.openOnboarding()
      client.render()
      await settle()
      expect(client.text()).toContain('合成小店')
      expect(respond.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ action: 'status', sessionId: 'synthetic-session' }]))
    } finally {
      client.dispose()
    }
  })

  it('uses the saved revision and broadcasts a sidebar correction to the active chat', async () => {
    const client = makeClient()
    const draft = { ...sampleDraft, revision: 2, enterprise: { companyName: '合成企业', taxId: '000000000000000123' } }
    const saved = { ...draft, revision: 3, enterprise: { ...draft.enterprise, companyName: '合成公司' } }
    const respond = vi.fn(payload => payload.action === 'edit-section' ? saved : draft)
    client.setOnboarding(respond)
    const listener = vi.fn()
    const unsubscribe = client.subscribeOnboarding(listener)
    try {
      client.openOnboarding()
      client.render()
      await settle()
      listener.mockClear()
      client.editSection('公司资料')
      expect(client.input('companyName').value).toBe('合成企业')
      client.input('companyName').onChange({ target: { value: '合成公司' } })
      client.submitForm()
      client.submitForm()
      await settle()
      expect(respond.mock.calls.filter(([payload]) => payload.action === 'edit-section')).toEqual([[{
        action: 'edit-section', sessionId: 'synthetic-session', draftId: 'synthetic-draft', revision: 2,
        section: 'company', input: { companyName: '合成公司' },
      }]])
      expect(listener).toHaveBeenCalledExactlyOnceWith('synthetic-session', { view: saved })
      expect(client.text()).toContain('合成公司')
      expect(client.text()).toContain('公司资料已保存')
      expect(client.input('companyName')).toBeUndefined()
    } finally {
      unsubscribe()
      client.dispose()
    }
  })

  it('keeps an existing account number private when saving another bank field', async () => {
    const client = makeClient()
    const draft = { ...sampleDraft, revision: 4, enterprise: { bankStatus: 'provided', accounts: [
      { id: 'synthetic-account', holder: '合成公司', bank: '合成银行', maskedNumber: '尾号 4321', currency: 'CNY', openedOn: '' },
    ] } }
    const respond = vi.fn(payload => payload.action === 'status' ? draft : { ...draft, revision: 5 })
    client.setOnboarding(respond)
    try {
      client.openOnboarding()
      client.render()
      await settle()
      client.editSection('银行账户')
      expect(client.input('account-0-number')).toMatchObject({ value: '', placeholder: '留空保留 尾号 4321' })
      client.input('account-0-bank').onChange({ target: { value: '合成另一银行' } })
      client.submitForm()
      await settle()
      expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({ input: { accounts: [{
        id: 'synthetic-account', holder: '合成公司', bank: '合成另一银行', currency: 'CNY', openedOn: '',
      }] } }))
    } finally {
      client.dispose()
    }
  })

  it('prevents stale edits from overwriting newer chat changes', async () => {
    const client = makeClient()
    const draft = { ...sampleDraft, revision: 1, enterprise: { companyName: '合成草稿' } }
    const respond = vi.fn(() => draft)
    client.setOnboarding(respond)
    try {
      client.openOnboarding()
      client.render()
      await settle()
      client.editSection('公司资料')
      client.input('companyName').onChange({ target: { value: '合成侧栏编辑' } })
      client.refreshOnboarding({ ...draft, revision: 2, enterprise: { companyName: '合成对话更新' } })
      client.submitForm()
      expect(client.text()).toContain('建档资料已更新。请重新编辑这组资料。')
      expect(client.input('companyName').value).toBe('合成侧栏编辑')
      expect(respond).toHaveBeenCalledTimes(1)
      client.click('取消')
      expect(client.text()).toContain('合成对话更新')
    } finally {
      client.dispose()
    }
  })

  it('shows captured tax information for its active draft before saving it in chat', async () => {
    const client = makeClient()
    client.setOnboarding(() => sampleDraft)
    try {
      client.openOnboarding()
      client.render()
      await settle()

      const profile = { companyName: '合成扫码企业', authority: '合成主管机关', establishedOn: '2025-07-01',
        obligations: [{ taxItem: '增值税', filingCycle: '按季' }] }
      client.previewOnboardingTax(profile, 'another-draft')
      expect(client.text()).not.toContain('合成扫码企业')
      client.previewOnboardingTax(profile, sampleDraft.draftId)
      expect(client.text()).toContain('已读取的税务资料 · 待核对')
      expect(client.text()).toContain('合成扫码企业')
      expect(client.text()).toContain('合成主管机关')
      expect(client.text()).toContain('2025-07-01')
      expect(client.text()).toContain('增值税 · 按季')

      client.previewOnboardingTax()
      expect(client.text()).not.toContain('合成扫码企业')
      client.previewOnboardingTax(profile, sampleDraft.draftId)
      client.refreshOnboarding({ ...sampleDraft, draftId: 'another-draft' })
      expect(client.text()).not.toContain('合成扫码企业')
    } finally {
      client.dispose()
    }
  })

  it('keeps newer chat state when initial read or earlier draft changes arrive after it', async () => {
    const client = makeClient()
    let finishStatus
    client.setOnboarding(() => new Promise(resolve => { finishStatus = resolve }))
    try {
      client.openOnboarding()
      client.render()
      client.refreshOnboarding({ ...sampleDraft, revision: 2, step: 3 })
      finishStatus(sampleDraft)
      await settle()
      client.refreshOnboarding({ ...sampleDraft, revision: 1, step: 2 })
      expect(client.text()).toContain('3/4 · 工资社保')
    } finally {
      client.dispose()
    }
  })
})
