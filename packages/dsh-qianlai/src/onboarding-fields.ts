import { isCalendarDate, PERIOD_KEY } from './period.js'
import { taxPortalFor, taxScanCities } from './tax-portals.js'

export interface FormField {
  readonly key: string
  readonly label: string
  readonly type: 'text' | 'date' | 'month' | 'select' | 'multi'
  readonly maxLength?: number
  readonly required?: false
  readonly options?: readonly { value: string; label: string }[]
}

const selection = (key: string, label: string, choices: Record<string, string>): FormField => ({
  key, label, type: 'select', options: Object.entries(choices).map(([value, label]) => ({ value, label })),
})
const input = (key: string, label: string, maxLength: number, type: FormField['type'] = 'text'): FormField => ({
  key, label, type, maxLength,
})

const regionOptions = Object.entries(taxScanCities()).flatMap(([province, cities]) => cities.map(city =>
  [province + '|' + city, province === city ? city : province + ' ' + city]))

const business = { ...selection('business', '企业实际开展的业务', {
  goods: '买卖商品或有库存', production: '生产或加工产品',
  'cross-border': '有境外客户、供应商或外币收付款', 'multiple-entities': '有分公司或多个经营主体', none: '以上都没有',
}), type: 'multi' as const }

export const taxStatusChoices = Object.fromEntries(
  ['正常', '停业', '清算', '非正常', '注销', '非正常注销', '其他'].map(value => [value, value]),
)

export const onboardingFields = {
  1: [
    input('companyName', '企业全称', 200), input('taxId', '统一社会信用代码', 18),
    input('establishedOn', '成立日期', 10, 'date'),
    selection('taxRegion', '税务地区', Object.fromEntries(regionOptions)),
    input('taxAuthority', '主管税务机关', 200),
    { ...selection('taxStatus', '税务状态', taxStatusChoices), maxLength: 60, required: false },
    selection('taxpayerIdentity', '纳税人类型', { 'small-scale': '小规模纳税人', general: '一般纳税人', unknown: '待核实' }),
    business, selection('bankStatus', '银行账户情况', { provided: '有银行账户', none: '没有银行账户', pending: '账户资料待补' }),
  ],
  2: [
    selection('history', '旧账情况', { previous: '已有旧账', unrecorded: '成立后未记账', new: '刚成立' }),
    input('lastMonth', '旧账做到的月份', 7, 'month'), input('startMonth', '起账月份', 7, 'month'),
  ],
  3: [
    selection('payroll', '发薪安排', { scheduled: '定期发工资', none: '暂时不发工资' }),
    selection('payday', '每月发薪日', Object.fromEntries(Array.from({ length: 31 }, (_, index) => [index + 1, (index + 1) + ' 日']))),
    selection('social', '社保情况', { all: '所有人都交', partial: '部分人交', none: '都没交', unknown: '待核实' }),
  ],
} satisfies Record<number, FormField[]>

export function availableFields(step: 1 | 2 | 3, current: Record<string, unknown>) {
  return onboardingFields[step].filter(({ key }) => {
    if (key === 'lastMonth') return current.history === 'previous' && !current.lastMonth
    if (key === 'payday') return current.payroll === 'scheduled' && !current.payday
    if (key === 'taxRegion') return !current.province || !current.city
    if (key === 'business') return !Array.isArray(current.business) || !current.business.length
    return !current[key]
  })
}

export function fieldPatch(fields: readonly FormField[], values: Record<string, unknown>, today: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(values)) {
    const field = fields.find(candidate => candidate.key === key)
    if (!field) throw Error('请按当前表单填写资料。')
    if (field.type === 'multi') {
      if (!Array.isArray(raw) || !raw.length || raw.length > (field.options?.length ?? 0) ||
          raw.some(value => !field.options?.some(option => option.value === value)) ||
          (raw.includes('none') && raw.length > 1)) throw Error(`请核对${field.label}。`)
      patch[key] = [...new Set(raw)]
      continue
    }
    if (key === 'taxStatus' && raw === '') {
      patch[key] = ''
      continue
    }
    if (typeof raw !== 'string' || !raw.trim() || /\p{Cc}|\p{Cf}/u.test(raw)) throw Error('请按当前表单填写资料。')
    const value = raw.trim()
    if ((field.maxLength && value.length > field.maxLength)
        // Older drafts and official materials may carry a status outside the manual choices.
        || (field.options && key !== 'taxStatus' && !field.options.some(option => option.value === value))
        || (field.type === 'month' && !PERIOD_KEY.test(value))
        || (field.type === 'date' && (!isCalendarDate(value) || value > today))
        || (key === 'taxId' && !/^[A-Z0-9]{18}$/i.test(value))) throw Error(`请核对${field.label}。`)
    if (key === 'taxRegion') {
      const [province, city] = value.split('|')
      if (!province || !city || !taxPortalFor(province, city)) throw Error('请选择已接入的税务地区。')
      Object.assign(patch, { province, city })
    } else patch[key] = key === 'payday' ? Number(value) : value
  }
  return patch
}
