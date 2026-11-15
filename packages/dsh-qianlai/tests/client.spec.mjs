import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function makeClient() {
  const source = readFileSync(new URL('../client/client.src.js', import.meta.url), 'utf8')
  const fibers = new Map()
  const pendingEffects = []
  const intervals = new Map()
  const registrations = []
  const calls = []
  let activeFiber
  let hookIndex
  let intervalId = 0
  let status = { status: 'connected' }
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
  const window = { __ModuleLoader__: { load(definition) { this.factory = definition.factory } } }
  const timerSet = globalThis.setTimeout
  const timerClear = globalThis.clearTimeout
  runInNewContext(source, {
    window,
    AbortController,
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
    const tree = renderComponent(header, { sessionId, useSessions })
    for (const effect of pendingEffects.splice(0)) {
      effect.fiber.hooks[effect.index]?.cleanup?.()
      const cleanup = effect.callback()
      effect.fiber.hooks[effect.index] = { dependencies: effect.dependencies, cleanup }
    }
    return tree
  }
  function findButtons(node, found = []) {
    if (Array.isArray(node)) for (const child of node) findButtons(child, found)
    else if (node && typeof node === 'object') {
      if (node.type === 'button') found.push(node)
      findButtons(node.props?.children, found)
    }
    return found
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
    buttonText() { return findButtons(render())[0]?.props.children },
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
}

describe('WeChat header status', () => {
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
