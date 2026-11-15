import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import { taxRegionCities, taxScanCities } from '../src/tax-portals.js'

function makeClient() {
  const source = readFileSync(new URL('../client/client.src.js', import.meta.url), 'utf8')
    .replace('/* tax-region-catalogue */ {}', JSON.stringify(taxRegionCities))
    .replace('/* tax-scan-cities */ {}', JSON.stringify(taxScanCities()))
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
  let tax
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
      const unchanged = previous && dependencies?.length === previous.dependencies?.length
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
    if (_method === 'qianlai/company-onboarding') return { ok: true, value: onboarding(payload) }
    if (_method === 'qianlai/tax-onboarding') return { ok: true, value: tax(payload) }
    calls.push(payload.action)
    return { ok: true, value: { ...status } }
  }) } }
  const ctx = {
    inject(dependencies, callback) {
      if (dependencies[0] === 'connection') callback({ connection, effect() {} })
      else if (dependencies[0] === 'theme') callback({ theme: { overrideTokens: () => () => {} }, effect() {} })
      else if (dependencies[0] === 'uiConversation') callback({ uiConversation: { events: { register() {}, entries: () => [] } } })
    },
    slots: {
      inject(_name, callback) { callback() },
      register(definition, component) { registrations.push({ definition, component }) },
    },
  }
  plugin.apply(ctx)
  const header = registrations.find(({ definition }) => definition.name === 'conversation.session.header.actions').component
  const onboardingDock = registrations.find(({ definition }) => definition.name === 'conversation.input.dock').component
  const sessionId = 'synthetic-session'
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
    const tree = [renderComponent(header, { sessionId, useSessions }), renderComponent(onboardingDock, { sessionId, useSessions })]
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
  function field(label) {
    const row = findNodes(render(), 'label').find(node => Array.isArray(node.props.children)
      && node.props.children.some(value => typeof value === 'string' && value.trim() === label))
    const control = row && (findNodes(row, 'select')[0] ?? findNodes(row, 'input')[0])
    if (!control) throw Error('field unavailable: ' + label)
    return control
  }

  function dispose() {
    for (const fiber of fibers.values()) for (const hook of fiber.hooks) hook?.cleanup?.()
    intervals.clear()
  }
  return {
    calls,
    connection,
    dispose,
    intervals,
    render,
    setStatus(value) { status = value },
    setOnboarding(respond) { onboarding = respond },
    setTax(respond) { tax = respond },
    text() { return getText(render()) },
    value(label) { return field(label).props.value },
    change(label, value) { field(label).props.onChange({ target: { value, checked: value === true } }) },
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
      expect(client.buttons()).toEqual(['连接微信', '开始建档'])
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


describe('Zhangjie onboarding', () => {
  it('advances four steps through verified responses, reviews masked accounts and asks before replacing the sample book', async () => {
    const client = makeClient()
    const draftId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    let draft = { accepted: true, draftId, revision: 0, step: 1, completed: false, replacesSampleBook: true }
    client.setOnboarding(payload => {
      expect(payload.sessionId).toBe('synthetic-session')
      if (payload.action === 'status') return draft
      expect(payload.draftId).toBe(draftId)
      expect(payload.revision).toBe(draft.revision)
      if (payload.action === 'confirm') {
        expect(payload.replaceSampleBook).toBe(true)
        return draft = { ...draft, completed: true, nextAction: 'review-book-periods', replacesSampleBook: false }
      }
      const stepKey = ['enterprise', 'accounting', 'payroll'][payload.step - 1]
      const data = { ...payload.input }
      if (stepKey === 'enterprise') {
        const [{ number, ...account }] = data.accounts
        expect(number).toBe('000000654321')
        data.accounts = [{ ...account, id: 'synthetic-account', maskedNumber: '尾号 4321' }]
      }
      return draft = { ...draft, [stepKey]: data, revision: draft.revision + 1, step: payload.advance ? payload.step + 1 : payload.step }
    })
    try {
      client.click('开始建档')
      client.render()
      await settle()
      expect(client.text()).toContain('1/4 企业信息')
      client.change('企业全称', '合成小店')
      client.change('统一社会信用代码', '91330000MA00000001')
      client.change('成立日期', '2025-01-12')
      client.change('纳税人类型', 'small-scale')
      client.change('以上都没有', true)
      client.change('账户情况', 'provided')
      client.change('银行账号', '000000654321')
      client.change('开户行', '合成银行')
      client.click('继续')
      await settle()
      expect(client.text()).toContain('2/4 记账准备')
      client.change('原有账务', 'previous')
      client.change('旧账做到', '2025-07')
      client.change('开始记账', '2025-09')
      client.click('继续')
      await settle()
      expect(client.text()).toContain('3/4 工资社保')
      client.change('发薪安排', 'scheduled')
      client.change('每月发薪日', '25')
      client.change('社保情况', 'partial')
      client.click('继续')
      await settle()
      expect(client.text()).toContain('4/4 确认建档')
      expect(client.text()).toContain('尾号 4321')
      expect(client.text()).toContain('每月 25 日')
      expect(client.text()).not.toContain('000000654321')
      expect(() => client.click('确认建档')).toThrow(/button unavailable/)
      client.change('我确认清除样本账，建立这家企业的账本。', true)
      client.click('确认建档')
      await settle()
      expect(client.text()).toContain('建档完成')
      expect(client.text()).toContain('核对旧账截止月份和开始记账月份')
    } finally {
      client.dispose()
    }
  })

  it('saves an incomplete step and restores its fields in a newly mounted conversation panel', async () => {
    let draft = { accepted: true, draftId: 'synthetic-draft', revision: 1, step: 2, completed: false, replacesSampleBook: true }
    const respond = payload => {
      if (payload.action === 'status') return draft
      expect(payload).toMatchObject({ action: 'save', advance: false, step: 2, input: { history: 'previous', lastMonth: '2025-07' } })
      return draft = { ...draft, revision: 2, accounting: payload.input }
    }
    const client = makeClient()
    const reopened = makeClient()
    try {
      client.setOnboarding(respond)
      client.click('开始建档')
      client.render()
      await settle()
      client.change('原有账务', 'previous')
      client.change('旧账做到', '2025-07')
      client.click('保存并收起')
      await settle()
      expect(client.text()).not.toContain('2/4 记账准备')

      reopened.setOnboarding(respond)
      reopened.click('开始建档')
      reopened.render()
      await settle()
      expect(reopened.value('旧账做到')).toBe('2025-07')
      expect(reopened.value('开始记账')).toBe('')
    } finally {
      reopened.dispose()
      client.dispose()
    }
  })

  it.each([
    { province: '浙江省', city: '杭州市', taxId: '91330000MA00000001', region: 'zhejiang' },
    { province: '北京市', city: '北京市', taxId: '91110000MA00000001', region: 'beijing' },
  ])('$province saves before opening the official portal and reloads only confirmed tax fields', async ({ province, city, taxId, region }) => {
    const client = makeClient()
    const draftId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    let draft = { accepted: true, draftId, revision: 0, step: 1, completed: false, replacesSampleBook: true }
    const initialEnterprise = { companyName: '合成小店', taxId, province, city }
    const profile = {
      companyName: '合成小店', taxId, authority: '合成税务机关',
      taxpayerQualification: '小规模纳税人', taxpayerStatus: '正常', sourceUrl: `https://etax.${region}.chinatax.gov.cn/`,
    }
    client.setOnboarding(payload => {
      if (payload.action === 'status') return draft
      expect(payload).toMatchObject({ draftId, action: 'save', advance: false, input: initialEnterprise })
      return draft = { ...draft, revision: 1, enterprise: payload.input }
    })
    client.setTax(payload => {
      expect(payload).toMatchObject({ draftId, sessionId: 'synthetic-session', id: 'synthetic-flow' })
      if (payload.action === 'start') {
        expect(draft.revision).toBe(1)
        expect(payload).toMatchObject(initialEnterprise)
        return { phase: 'waiting' }
      }
      if (payload.action === 'read') return { phase: 'ready', profile }
      if (payload.action === 'submit') {
        draft = { ...draft, revision: 2, enterprise: { ...draft.enterprise,
          taxAuthority: profile.authority, taxpayerIdentity: 'small-scale', taxStatus: '正常',
          officialTax: { taxAuthority: profile.authority, taxpayerIdentity: 'small-scale', taxStatus: '正常', sourceUrl: profile.sourceUrl },
        } }
        return { phase: 'submitted' }
      }
      return { phase: 'idle' }
    })
    try {
      client.click('开始建档')
      client.render()
      await settle()
      client.change('企业全称', initialEnterprise.companyName)
      client.change('统一社会信用代码', initialEnterprise.taxId)
      client.change('省份', '浙江省')
      client.change('城市或地区', '宁波市')
      expect(client.text()).toContain('该地区暂未接入扫码')
      client.change('省份', initialEnterprise.province)
      client.change('城市或地区', initialEnterprise.city)
      client.click('打开官方扫码页')
      await settle()
      client.click('已登录，读取税务资料')
      await settle()
      expect(client.value('纳税人类型')).toBe('')
      client.click('核对无误，回填税务资料')
      await settle()
      expect(client.value('纳税人类型')).toBe('small-scale')
      expect(client.text()).toContain('已回填税务资料')
      expect(client.text()).toContain('1/4 企业信息')
    } finally {
      client.dispose()
    }
  })
})
