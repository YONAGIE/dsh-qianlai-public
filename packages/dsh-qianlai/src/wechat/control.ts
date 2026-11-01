import { resolve } from 'node:path'

export type LoginAction = 'status' | 'start' | 'refresh'
export interface LoginView {
  status: 'disconnected' | 'loading' | 'waiting' | 'scanned' | 'connected' | 'expired' | 'error'
  qrDataUrl?: string
  requestedAt?: string
  message?: string
}
export interface LoginControl { run(action: LoginAction): Promise<LoginView> }

// One controller per owning Host/state directory. No credentials cross this boundary.
const controls = new Map<string, LoginControl>()
export function registerLoginControl(directory: string, control: LoginControl): () => void {
  const key = resolve(directory)
  if (controls.has(key)) throw Error('WeChat controller already registered for this state directory')
  controls.set(key, control)
  return () => { if (controls.get(key) === control) controls.delete(key) }
}
export function loginControl(directory: string): LoginControl | undefined { return controls.get(resolve(directory)) }

export interface RpcConnection {
  fetch: {
    register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void>
  }
}

/** Uses Connection's exact route: web and Electron share Host authentication and its owner-only fence. */
export function registerLoginRpc(connection: RpcConnection, control: LoginControl) {
  return connection.fetch.register({
    path: '/api/qianlai/wechat', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let envelope: { type?: unknown; method?: unknown; rpcId?: unknown; payload?: unknown }
      try { envelope = await request.json() as typeof envelope }
      catch { return new Response('Invalid request', { status: 400 }) }
      if (!envelope || envelope.type !== 'client-request' || envelope.method !== 'qianlai/wechat' ||
          typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 128)
        return new Response('Invalid request', { status: 400 })
      const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result }, { headers: { 'Cache-Control': 'no-store' } })
      const payload = envelope.payload
      const action = (payload as { action?: unknown } | null)?.action
      if (!['status', 'start', 'refresh'].includes(String(action)) || !payload || Object.keys(payload).some(key => key !== 'action'))
        return reply({ ok: false, error: { code: 'invalid-argument', message: '无效的微信操作。', details: {} } })
      if (request.signal.aborted) return reply({ ok: false, error: { code: 'cancelled', message: '请求已取消。', details: {} } })
      return reply({ ok: true, value: await control.run(action as LoginAction) })
    },
  })
}
