import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import { onboardingFieldError } from '../client/onboarding-chat.src.js'
import { createOnboardingDateInput } from '../client/onboarding-date.src.js'
import { taxFields } from '../src/onboarding-fields.js'
import { taxRegionCities, taxScanCities } from '../src/tax-portals.js'

function makeClient() {
  const reportChat = readFileSync(new URL('../client/report-chat.src.js', import.meta.url), 'utf8').replace(/^export /gm, '')
  const source = readFileSync(new URL('../client/client.src.js', import.meta.url), 'utf8')
    .replace('/* tax-region-catalogue */ {}', JSON.stringify(taxRegionCities))
    .replace('/* tax-fields */ []', JSON.stringify(taxFields))
    .replace('/* tax-scan-cities */ {}', JSON.stringify(taxScanCities()))
    .replace('/* onboarding-date-client */', () => createOnboardingDateInput.toString())
    .replace('/* report-chat-client */', () => reportChat)
    .replace('/* onboarding-chat-client */', () => onboardingFieldError.toString() +
      '\nfunction registerOnboardingChat(_ctx, client) { window.onboardingClient = client }')
  const fibers = new Map()
  const pendingEffects = []
  const intervals = new Map()
  const registrations = []
  const eventDefinitions = []
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
    isExpanded: () => tabOpen,
    active: () => tabOpen ? { kind: 'moneycome-onboarding' } : undefined,
  }
  const sidebarRightTabs = { register: definition => tabTypes.push(definition) }
  const send = vi.fn(async () => {})
  let eventWindow = { revision: 0 }
  const eventSubscribers = new Set()
  const eventSource = {
    getSnapshot: () => eventWindow,
    subscribe(listener) {
      eventSubscribers.add(listener)
      return () => eventSubscribers.delete(listener)
    },
  }
  const sessions = {
    scope: vi.fn(id => id === sessionId ? {
      get: service => service === 'conversation' ? { send } : undefined,
    } : undefined),
    binding: id => id === sessionId ? { eventSource } : undefined,
  }
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
  const jsx = (type, props, key) => ({ type, props, key })
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
      if (dependencies[0] === 'connection' && dependencies.includes('conversation'))
        callback({ connection, conversation: {}, effect: install => install() })
      else if (dependencies[0] === 'connection') callback({ connection, effect() {} })
      else if (dependencies.includes('sessions') && dependencies.includes('conversation')) callback({ sessions, effect() {} })
      else if (dependencies[0] === 'theme') callback({ theme: { overrideTokens: () => () => {} }, effect() {} })
      else if (dependencies[0] === 'uiConversation') callback({
        effect: install => install(),
        uiConversation: { events: { register(definition) { eventDefinitions.push(definition) }, entries: () => eventDefinitions } },
      })
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
    if (typeof node.type === 'function') return renderComponent(node.type, node.props, node.key)
    return { ...node, props: { ...node.props, children: resolve(node.props.children) } }
  }
  function renderComponent(component, props, key) {
    const identity = key === undefined ? component : component.name + ':' + key
    const fiber = fibers.get(identity) ?? { hooks: [] }
    fibers.set(identity, fiber)
    rendered.add(identity)
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
    eventDefinitions,
    registrations,
    sidebarRight,
    tabTypes,
    send,
    sessions,
    emitHistoryChange(kind, events) {
      eventWindow = { revision: eventWindow.revision + 1, change: { kind, entries: events.map(event => ({ event })) } }
      for (const listener of eventSubscribers) listener()
    },
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
    input(name) { return this.controls().find(node => node.props.name === name)?.props },
    submitForm(section) {
      findNodes(render()[1], 'form').find(node => node.props['aria-label'] === section).props.onSubmit({ preventDefault() {} })
    },
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

it('registers the report projection and renderer alongside the onboarding UI', () => {
  const client = makeClient()
  try {
    expect(client.eventDefinitions).toContainEqual(expect.objectContaining({
      kind: 'moneycome-report-action', target: 'chat',
    }))
    expect(client.registrations).toContainEqual(expect.objectContaining({
      definition: { name: 'conversation.chat.node', key: 'moneycome-report-action' },
      component: expect.any(Function),
    }))
  } finally {
    client.dispose()
  }
})

describe('Zhangjie onboarding sidebar', () => {
  it('clears other business selections when selecting "none", and clears "none" when selecting an activity', async () => {
    const client = makeClient()
    client.setOnboarding(() => ({ ...sampleDraft, enterprise: { business: ['goods', 'production'] } }))
    try {
      client.openOnboarding()
      client.render()
      await settle()
      const business = () => client.controls().filter(node => node.props.name === 'business')
      const pick = value => business().find(node => node.props.value === value).props.onChange({ target: { checked: true } })
      const selected = () => business().filter(node => node.props.checked).map(node => node.props.value)
      expect(selected()).toEqual(['goods', 'production'])
      pick('none')
      expect(selected()).toEqual(['none'])
      pick('production')
      expect(selected()).toEqual(['production'])
    } finally {
      client.dispose()
    }
  })

  it('matches the manual tax selectors and requires a specific note for Other', async () => {
    const client = makeClient()
    let draft = { ...sampleDraft, enterprise: { taxStatus: '正常' } }
    const respond = vi.fn(payload => {
      if (payload.action === 'edit-section') draft = {
        ...draft, revision: draft.revision + 1, enterprise: { ...draft.enterprise, ...payload.input },
      }
      return draft
    })
    client.setOnboarding(respond)
    try {
      client.openOnboarding()
      client.render()
      await settle()
      expect(client.controls().map(node => node.props.name)).not.toContain('province')
      expect(client.controls().map(node => node.props.name)).not.toContain('city')
      const control = client.controls().find(node => node.props.name === 'taxStatus')
      expect(control.type).toBe('select')
      expect(control.props.value).toBe('正常')
      expect(control.props.children[0].props).toMatchObject({ value: '', disabled: true })
      expect(control.props.children.flat().map(node => node.props.value))
        .toEqual(['', '正常', '停业', '清算', '非正常', '注销', '非正常注销', '其他'])
      control.props.onChange({ target: { value: '其他' } })
      client.submitForm('税务资料')
      await settle()
      expect(client.text()).toContain('请填写具体纳税人状态')
      client.input('taxStatusOther').onChange({ target: { value: '合成状态说明' } })
      client.submitForm('税务资料')
      await settle()
      expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({
        input: { taxStatus: '其他', taxStatusOther: '合成状态说明' },
      }))
    } finally {
      client.dispose()
    }
  })

  it('opens on a live, accepted onboarding start and respects its session and history', async () => {
    const client = makeClient()
    client.setOnboarding(() => sampleDraft)
    const call = (callId, action = 'start') => ({
      type: 'tool/call', data: { name: 'moneycome_onboarding', callId, arguments: JSON.stringify({ action }) },
    })
    const result = (callId, value = { accepted: true, card: { kind: 'mode' } }) => ({
      type: 'tool/result', surfaceOp: 'append',
      data: { message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text: JSON.stringify(value) }] } },
    })
    try {
      client.render()
      client.emitHistoryChange('replace', [call('historical'), result('historical')])
      client.emitHistoryChange('prepend', [call('older'), result('older')])
      client.emitHistoryChange('append', [call('refused'), result('refused', { accepted: false })])
      client.emitHistoryChange('append', [call('completed'), result('completed', { accepted: true, completed: true })])
      expect(client.sidebarRight.openTabFromTarget).not.toHaveBeenCalled()

      client.emitHistoryChange('append', [call('start')])
      client.emitHistoryChange('append', [result('start')])
      expect(client.sidebarRight.openTabFromTarget).toHaveBeenCalledExactlyOnceWith('moneycome-onboarding',
        { sessionId: 'synthetic-session', paneId: 'synthetic-pane' })
      client.openOnboarding()
      expect(client.sidebarRight.openTabFromTarget).toHaveBeenCalledTimes(1)

      client.closeOnboarding()
      client.emitHistoryChange('append', [call('next', 'continue'), result('next')])
      expect(client.sidebarRight.openTabFromTarget).toHaveBeenCalledTimes(1)

      client.sidebarRight.commandTarget.mockReturnValueOnce({ sessionId: 'another-session', paneId: 'another-pane' })
      client.emitHistoryChange('append', [call('background-start'), result('background-start')])
      expect(client.sidebarRight.openTabFromTarget).toHaveBeenCalledTimes(1)

      client.emitHistoryChange('append', [call('resume'), result('resume', { accepted: true, card: { kind: 'fields' } })])
      expect(client.sidebarRight.openTabFromTarget).toHaveBeenCalledTimes(2)
      client.render()
      await settle()
      expect(client.text()).toContain('1/4 · 企业信息')
    } finally {
      client.dispose()
    }
  })

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
      expect(client.input('companyName').value).toBe('合成小店')
      expect(client.text()).toContain('尾号 4321')
      expect(client.text()).not.toContain('000000654321')
      expect(client.input('account-0-number').value).toBe('')
      expect(client.input('startMonth').value).toBe('2025-08')
      expect(client.input('payday').value).toBe(25)
      expect(client.buttons()).not.toContain('编辑')

      client.closeOnboarding()
      client.openOnboarding()
      client.render()
      await settle()
      expect(client.input('companyName').value).toBe('合成小店')
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
      expect(client.input('companyName').value).toBe('合成企业')
      client.input('companyName').onChange({ target: { value: '合成公司' } })
      client.submitForm('公司资料')
      client.submitForm('公司资料')
      await settle()
      expect(respond.mock.calls.filter(([payload]) => payload.action === 'edit-section')).toEqual([[{
        action: 'edit-section', sessionId: 'synthetic-session', draftId: 'synthetic-draft', revision: 2,
        section: 'company', input: { companyName: '合成公司' },
      }]])
      expect(listener).toHaveBeenCalledExactlyOnceWith('synthetic-session', { view: saved })
      expect(client.input('companyName').value).toBe('合成公司')
      expect(client.text()).toContain('已保存到建档草稿')
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
      expect(client.input('account-0-number')).toMatchObject({ value: '', placeholder: '留空保留 尾号 4321' })
      client.input('account-0-bank').onChange({ target: { value: '合成另一银行' } })
      client.submitForm('银行账户')
      await settle()
      expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({ input: { accounts: [{
        id: 'synthetic-account', holder: '合成公司', bank: '合成另一银行', currency: 'CNY', openedOn: '',
      }] } }))
    } finally {
      client.dispose()
    }
  })

  it('explains an invalid bank account number beside the sidebar input without submitting it', async () => {
    const client = makeClient()
    const draft = { ...sampleDraft, enterprise: { bankStatus: 'provided', accounts: [
      { id: 'synthetic-account', holder: '合成公司', bank: '合成银行', maskedNumber: '尾号 4321', currency: 'CNY' },
    ] } }
    const respond = vi.fn(() => draft)
    client.setOnboarding(respond)
    try {
      client.openOnboarding()
      client.render()
      await settle()
      const account = () => client.input('account-0-number')
      account().onChange({ target: { value: '123' } })
      account().onBlur()
      expect(account()).toMatchObject({ value: '123', 'aria-invalid': true })
      expect(client.text()).toContain('请输入 4 至 34 位数字')
      client.submitForm('银行账户')
      expect(respond.mock.calls.some(([payload]) => payload.action === 'edit-section')).toBe(false)
      account().onChange({ target: { value: '12 34-56' } })
      expect(account()['aria-invalid']).toBeUndefined()
      client.submitForm('银行账户')
      expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({ input: { accounts: [
        expect.objectContaining({ id: 'synthetic-account', number: '12 34-56' }),
      ] } }))
    } finally {
      client.dispose()
    }
  })

  it('preserves a sidebar edit when chat refreshes and saves only explicit edits on the latest revision', async () => {
    const client = makeClient()
    const draft = { ...sampleDraft, revision: 1, enterprise: { companyName: '合成草稿' } }
    const latest = { ...draft, revision: 2, enterprise: { companyName: '合成对话更新', establishedOn: '2025-03-08' } }
    const respond = vi.fn(payload => payload.action === 'edit-section'
      ? { ...latest, revision: 3, enterprise: { ...latest.enterprise, ...payload.input } } : draft)
    client.setOnboarding(respond)
    try {
      client.openOnboarding()
      client.render()
      await settle()
      client.input('companyName').onChange({ target: { value: '合成侧栏编辑' } })
      client.refreshOnboarding(latest)
      expect(client.text()).toContain('资料有更新，已保留你的输入。')
      expect(client.text()).toContain('草稿当前值 · 合成对话更新')
      expect(client.input('companyName').value).toBe('合成侧栏编辑')
      expect(client.input('establishedOn').value).toBe('2025-03-08')
      expect(respond).toHaveBeenCalledTimes(1)
      client.submitForm('公司资料')
      await settle()
      expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2, input: { companyName: '合成侧栏编辑' } }))
      expect(client.input('establishedOn').value).toBe('2025-03-08')
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
