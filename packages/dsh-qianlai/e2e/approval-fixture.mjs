// Test-only native answerer. Never referenced by the production plugin patch.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const critical = new Set(['open_book', 'set_opening_balances', 'record_entry', 'void_voucher', 'reverse_voucher', 'close_period'].map(name => 'moneycome_' + name))
export function apply(ctx, config) {
  if (!['allow', 'reject'].includes(config?.mode) || !config.home || !config.runId
    || resolve(process.env.DSH_HOME ?? '') !== resolve(config.home)
    || readFileSync(join(config.home, '.synthetic-e2e-home'), 'utf8') !== config.runId)
    throw Error('Synthetic approval fixture requires an explicit, fresh test home.')
  ctx.on('approval/request', async (request, next) => critical.has(request.toolName)
    ? config.mode === 'allow' ? 'allowed-once' : 'rejected'
    : next())
}
