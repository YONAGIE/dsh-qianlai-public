const PRIVATE_HANDOFF_TOOLS = new Set([
  'moneycome_payroll', 'moneycome_benefits', 'moneycome_tax_work',
  'moneycome_receipt_match', 'moneycome_material_archive', 'moneycome_historical_backfill',
])
const PRIVATE_ENTRY_KINDS = new Set([
  'payroll', 'social_insurance', 'housing_fund', 'closing.payroll_accrual',
  'closing.social_accrual', 'closing.housing_fund_accrual',
  'personal_advance_repayment', 'tax_payment', 'tax_accrual',
])

export function privateHandoffOperation(name: unknown, rawArgs: unknown): boolean {
  if (typeof name !== 'string') return false
  if (PRIVATE_HANDOFF_TOOLS.has(name)) return true
  if (name !== 'moneycome_record_entry') return false
  let args = rawArgs
  if (typeof args === 'string') {
    if (args.length > 64_000) return true
    try { args = JSON.parse(args) as unknown } catch { return true }
  }
  const kind = (args as { eventKind?: unknown } | undefined)?.eventKind
  return typeof kind !== 'string' || PRIVATE_ENTRY_KINDS.has(kind)
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
const materialKinds = new Set(['发票', '合同', '银行回单', '流水', '银行对账单', '科目余额表', '缴费凭据'])

function publicEvents(value: unknown) {
  return list(value).filter(event => !privateHandoffOperation(event.operation, event.request)).map(event => {
    const request = object(event.request)
    const result = object(event.result)
    return { id: event.id, operation: event.operation, createdAt: event.createdAt,
      ...(typeof request.periodKey === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(request.periodKey) ? { periodKey: request.periodKey } : {}),
      ...(typeof result.voucherNo === 'string' && /^PZ-\d{6}-\d+$/.test(result.voucherNo) ? { voucherNo: result.voucherNo } : {}),
      ...(request.preview === true ? { preview: true } : {}),
    }
  })
}

function publicMatter(value: unknown) {
  const matter = object(value)
  const missing = Array.isArray(matter.missing) ? matter.missing : []
  const materials = list(matter.materials)
  return {
    id: matter.id, revision: matter.revision, period: matter.period, voucherNo: matter.voucherNo, updatedAt: matter.updatedAt,
    missingCount: missing.length, missingKinds: missing.filter(field => typeof field === 'string' && materialKinds.has(field)),
    materialCount: materials.length,
  }
}

export function compactWechatWorkResult(tool: string, value: unknown): unknown {
  const result = object(value)
  if (result.accepted !== true) return value
  if (tool === 'moneycome_material_archive') return {
    accepted: true, matterId: result.matterId, period: result.period, materialCount: list(result.materials).length,
    guidance: '请在桌面或网页对话查看和下载原件。',
  }
  if (tool === 'moneycome_work_progress') {
    if (result.matter) return { accepted: true, approval: result.approval, matter: publicMatter(result.matter),
      guidance: '待办编号和缺件数量可用于续办。详细资料请在桌面或网页对话查看。' }
    const pendingMatters = list(result.pendingMatters)
    const handoff = object(result.historicalHandoff)
    return {
      accepted: true, company: result.company, scope: result.scope, nextBeforeId: result.nextBeforeId,
      events: publicEvents(result.events), pendingMatterCount: pendingMatters.length, pendingMatters: pendingMatters.map(publicMatter),
      recentMaterialCount: list(result.recentMaterials).length,
      fundsArrangements: list(result.fundsArrangements).map(plan => ({
        arrangementId: plan.arrangementId, direction: plan.direction, scheduledOn: plan.scheduledOn, status: plan.status,
      })),
      historicalHandoff: { planCount: list(handoff.plans).length, balanceCount: list(handoff.balances).length },
      guidance: '这里显示当前业务进度。个人资料、材料名称和原件请在桌面或网页对话核对。',
    }
  }
  if (tool === 'moneycome_book_status') {
    const currentWork = object(result.currentWork)
    const nextAction = object(currentWork.nextAction)
    return { ...result, recentWork: publicEvents(result.recentWork), ...(result.currentWork ? {
      currentWork: nextAction.kind === 'material' ? { ...currentWork, nextAction: {
        kind: 'material', message: '还有资料待补。请在当前企业桌面或网页对话查看具体事项。',
      } } : currentWork,
    } : {}) }
  }
  return value
}
