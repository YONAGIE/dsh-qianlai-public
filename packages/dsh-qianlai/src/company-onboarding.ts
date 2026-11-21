import { randomUUID } from 'node:crypto'

import { openBook } from './book.js'
import { confirmHistoricalHandoff, readHistoricalHandoff } from './historical-handoff.js'
import { accountingSystemChoices, availableFields, fieldPatch, incomeMethodChoices, missingTaxFields, onboardingFields, profileAccountFields, profilePayrollField, taxFields, taxStatusChoices, type FormField } from './onboarding-fields.js'
import { isCalendarDate, PERIOD_KEY, previousPeriod, refuse, todayInChina, type Refusal } from './period.js'
import type { BookStore } from './store.js'
import regions from './tax-regions.json' with { type: 'json' }
import type { TaxProfile } from './tax-portal.js'
import { taxPortalFor } from './tax-portals.js'

type Step = 1 | 2 | 3 | 4
type EditableStep = Exclude<Step, 4>
export type OnboardingMode = 'scan' | 'manual'
type DocumentKind = 'license' | 'tax'
type TaxpayerIdentity = 'small-scale' | 'general' | 'unknown'
type Business = 'goods' | 'production' | 'cross-border' | 'multiple-entities' | 'none'
type BankStatus = 'provided' | 'none' | 'pending'
type History = 'previous' | 'unrecorded' | 'new'
type PayrollMode = 'scheduled' | 'none'
type SocialMode = 'all' | 'partial' | 'none' | 'unknown'

interface Account {
  id: string
  holder: string
  number: string
  bank: string
  currency: string
  openedOn: string
}

interface OfficialTax {
  province: string
  city: string
  taxpayerIdentity: TaxpayerIdentity
  taxStatus: string
  taxAuthority: string
  incomeMethod?: string
  accountingSystem?: string
  obligations: TaxProfile['obligations']
  obligationCoverage: TaxProfile['obligationCoverage']
  observedAt: string
  sourceUrl: string
}

interface Enterprise {
  companyName: string
  taxId: string
  establishedOn: string
  province: string
  city: string
  taxpayerIdentity: TaxpayerIdentity | ''
  taxStatus: string
  taxAuthority: string
  taxStatusOther?: string
  incomeMethod?: string
  accountingSystem?: string
  accountingSystemOther?: string
  business: Business[]
  bankStatus: BankStatus | ''
  accounts: Account[]
  officialTax?: OfficialTax
}

interface Accounting {
  history: History | ''
  lastMonth: string
  startMonth: string
}

interface Payroll {
  payroll: PayrollMode | ''
  payday?: number
  social: SocialMode | ''
}

export interface OnboardingRecord {
  draftId: string
  revision: number
  step: Step
  mode?: OnboardingMode
  taxFlowId?: string
  correction?: CorrectionField
  cards?: StoredCard[]
  enterprise?: Enterprise
  accounting?: Accounting
  payroll?: Payroll
  completedAt?: string
  entryDeferred?: true
}

type NextAction = 'review-book-periods' | 'opening-balances' | 'bookkeeping'

export interface OnboardingView extends Omit<OnboardingRecord, 'enterprise' | 'cards' | 'taxFlowId' | 'correction' | 'entryDeferred'> {
  accepted: true
  completed: boolean
  replacesSampleBook: boolean
  enterprise?: Omit<Enterprise, 'accounts'> & { accounts: (Omit<Account, 'number'> & { maskedNumber?: string })[] }
  nextAction?: NextAction
  handoff?: OnboardingHandoff
  handoffWarning?: string
}

type OnboardingHandoff = { guidance: string } & (
  | { kind: 'review-book-periods'; gapFrom: string; gapTo: string }
  | { kind: 'prior-period-balances'; statementMonth: string; attachment: string }
  | { kind: 'reconstruct-opening-balances'; openingMonth: string; attachment?: string }
  | { kind: 'confirm-opening-balances'; openingMonth: string }
  | { kind: 'bookkeeping' }
)

interface CardBase {
  id: string
  draftId: string
  revision: number
}

interface DocumentCard {
  kind: 'document'
  documentKind: DocumentKind
  fields: FormField[]
  initialValues?: Record<string, unknown>
}

interface FieldsCard {
  kind: 'fields'
  fields: FormField[]
  step?: EditableStep
  initialValues?: Record<string, unknown>
  correction?: true
  recheck?: true
  maintenance?: { field: string; accountId?: string; proposed?: Record<string, unknown> }
}

type CardContent = (
  | { kind: 'mode' | 'region' | 'bank' | 'bank-next' }
  | { kind: 'source' | 'upload'; documentKind: 'license' | 'tax' }
  | DocumentCard
  | FieldsCard
  | { kind: 'tax-scan'; province: string; city: string; autoStart?: true }
  | { kind: 'confirm'; replacesSampleBook: boolean }
  | { kind: 'blocked'; message: string; locked?: true }
) & { title?: string; message?: string }
type OnboardingCard = CardBase & CardContent
interface CardReceipt { labels: string[]; mode?: OnboardingMode; choice?: string; notice?: string }
interface StoredCard { sessionId: string; card: OnboardingCard; receipt?: CardReceipt; autoStartClaimed?: true }
export type OnboardingGuideAction = 'start' | 'continue' | 'defer-entry' | 'fill' | 'review-document' | 'switch-mode' | 'correct' | 'read-profile' | 'edit-profile' | 'add-bank-account' | 'review-handoff'

const companyDocumentKeys = ['companyName', 'taxId', 'establishedOn']
const profileFields = [...onboardingFields[1], ...onboardingFields[2], ...onboardingFields[3]]
const profileReadOnly = new Set(['taxId', 'bankStatus', 'history', 'startMonth'])
const accountTail = (account: Account) => account.number.slice(-4)
const accountLabel = (account: Account) => account.bank + (account.number ? ' 尾号 ' + accountTail(account) : '（尾号待补）')

const TAX_ID = /^[0-9A-Z]{18}$/
const cities: Readonly<Record<string, readonly string[]>> = regions
const identities = ['small-scale', 'general', 'unknown'] as const
const blockedStatuses = ['非正常', '注销', '非正常注销', '停业', '清算'] as const
const businessLabels = {
  goods: '买卖商品或有库存',
  production: '生产或加工产品',
  'cross-border': '有境外客户、供应商或用外币收付款',
  'multiple-entities': '有分公司或多个经营主体',
  none: '以上都没有',
} as const
const choices = Object.keys(businessLabels) as Business[]
const normalizeCompanyName = (name: string) => name.normalize('NFKC').replace(/\s+/g, '')
const editableSections = {
  company: { step: 1, keys: ['companyName', 'taxId', 'establishedOn', 'business'] },
  tax: { step: 1, keys: taxFields.map(field => field.key) },
  bank: { step: 1, keys: ['bankStatus', 'accounts'] },
  accounting: { step: 2, keys: ['history', 'lastMonth', 'startMonth'] },
  payroll: { step: 3, keys: ['payroll', 'payday', 'social'] },
} satisfies Record<string, { step: EditableStep; keys: string[] }>

const correctionSections = {
  companyName: 'company', establishedOn: 'company', business: 'company',
  taxAuthority: 'tax', taxStatus: 'tax', taxpayerIdentity: 'tax', incomeMethod: 'tax', accountingSystem: 'tax',
  lastMonth: 'accounting', startMonth: 'accounting',
} as const satisfies Record<string, keyof typeof editableSections>
type CorrectionField = keyof typeof correctionSections

function isCorrectionField(field: unknown): field is CorrectionField {
  return typeof field === 'string' && Object.hasOwn(correctionSections, field)
}

function correctionPending() {
  return refuse('DRAFT_CORRECTION_PENDING', '请先在当前更正表单里核对并保存，再继续建档。')
}

function isOfficialField(key: string, profile?: OfficialTax) {
  return !!profile && (['companyName', 'taxId', 'province', 'city', 'taxAuthority'].includes(key) ||
    (key === 'taxStatus' && !!profile.taxStatus) ||
    (key === 'incomeMethod' && !!profile.incomeMethod) ||
    (key === 'accountingSystem' && !!profile.accountingSystem) ||
    (key === 'taxpayerIdentity' && profile.taxpayerIdentity !== 'unknown'))
}

function isBlockedStatus(value: string) {
  return blockedStatuses.some(status => status === value.trim())
}

function unsupportedEnterpriseFields(data: Enterprise) {
  const business = data.business.filter(value => value !== 'none').map(value => businessLabels[value])
  return [
    ...(isBlockedStatus(data.taxStatus) ? [{ key: 'taxStatus' as const, reason: `纳税人状态为${data.taxStatus}` }] : []),
    ...(data.taxpayerIdentity === 'general' ? [{ key: 'taxpayerIdentity' as const, reason: '增值税一般纳税人' }] : []),
    ...(business.length ? [{ key: 'business' as const, reason: business.join('、') }] : []),
  ]
}

class InputError extends Error {}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('没有收到可保存的资料，请重新填写。')
  return input as Record<string, unknown>
}

function text(input: unknown, label: string, max = 200): string {
  if (input === undefined || input === '') return ''
  if (typeof input !== 'string' || input.length > max || /\p{Cc}|\p{Cf}/u.test(input))
    throw new InputError(`${label}格式不正确。`)
  return input.trim()
}

function select<Value extends string>(input: unknown, values: readonly Value[], label: string): Value | '' {
  if (input === undefined || input === '') return ''
  const choice = values.find(value => value === input)
  if (!choice) throw new InputError(`请重新选择${label}。`)
  return choice
}

function parseAccounts(input: unknown, previous: readonly Account[]): Account[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 20) throw new InputError('请核对银行账户列表，最多可填写 20 个账户。')
  const ids = new Set<string>()
  return input.map((item: unknown) => {
    const entry = object(item)
    const id = text(entry.id, '账户标识', 40)
    const saved = id ? previous.find(account => account.id === id) : undefined
    if (id && (!saved || ids.has(id))) throw new InputError('账户列表已变化，请刷新后重试。')
    if (id) ids.add(id)
    return {
      id: id || randomUUID(),
      holder: text(entry.holder, '账户户名'),
      number: text(entry.number, '银行账号', 48).replace(/[ -]/g, '') || saved?.number || '',
      bank: text(entry.bank, '开户行'),
      currency: text(entry.currency, '币种', 3).toUpperCase(),
      openedOn: text(entry.openedOn, '开户日期', 10),
    }
  })
}

function parseEnterprise(input: unknown, previous?: Enterprise): Enterprise {
  const data = object(input)
  const companyName = text(data.companyName, '企业全称')
  const taxId = text(data.taxId, '统一社会信用代码', 18).toUpperCase()
  const province = text(data.province, '省份', 30)
  const city = text(data.city, '城市或地区', 50)
  const officialTax = taxId && previous?.taxId === taxId ? previous.officialTax : undefined
  if (officialTax && previous && normalizeCompanyName(previous.companyName) !== normalizeCompanyName(companyName))
    throw new InputError('企业名称与同一信用代码的已读取税务资料不一致，请核对后再填。')
  const selected = data.business ?? []
  if (!Array.isArray(selected) || selected.length > choices.length || selected.some(value => !choices.includes(value as Business)))
    throw new InputError('请重新选择企业的实际经营情况。')
  const business = [...new Set(selected as Business[])]
  if (business.includes('none') && business.length > 1)
    throw new InputError('请在「以上都没有」和实际经营项目之间选择。')
  const bankStatus = select(data.bankStatus, ['provided', 'none', 'pending'], '账户情况')
  const taxStatus = officialTax?.taxStatus || select(data.taxStatus, Object.keys(taxStatusChoices), '纳税人状态')
  const accountSystem = officialTax?.accountingSystem || select(data.accountingSystem, Object.keys(accountingSystemChoices), '会计制度')
  return {
    companyName, taxId, province, city,
    establishedOn: text(data.establishedOn, '成立日期', 10),
    taxpayerIdentity: officialTax && officialTax.taxpayerIdentity !== 'unknown'
      ? officialTax.taxpayerIdentity : select(data.taxpayerIdentity, identities, '纳税人身份'),
    taxStatus: taxStatus && !Object.hasOwn(taxStatusChoices, taxStatus) ? '其他' : taxStatus,
    taxStatusOther: taxStatus === '其他' ? text(data.taxStatusOther, '具体纳税人状态', 160)
      : !Object.hasOwn(taxStatusChoices, taxStatus) ? taxStatus : '',
    taxAuthority: officialTax?.taxAuthority || text(data.taxAuthority, '主管税务机关'),
    incomeMethod: officialTax?.incomeMethod || select(data.incomeMethod, Object.keys(incomeMethodChoices), '企业所得税征收方式'),
    accountingSystem: accountSystem,
    accountingSystemOther: accountSystem === '其他' ? text(data.accountingSystemOther, '具体会计制度', 160) : '',
    business,
    bankStatus,
    accounts: bankStatus === 'none' ? [] : parseAccounts(data.accounts,
      previous && (!TAX_ID.test(previous.taxId) || previous.taxId === taxId) ? previous.accounts : []),
    ...(officialTax ? { officialTax } : {}),
  }
}

function parseAccounting(input: unknown): Accounting {
  const data = object(input)
  const history = select(data.history, ['previous', 'unrecorded', 'new'], '以前的账务情况')
  return {
    history,
    lastMonth: history === 'previous' ? text(data.lastMonth, '旧账做到的月份', 7) : '',
    startMonth: text(data.startMonth, '开始记账的月份', 7),
  }
}

function parsePayroll(input: unknown): Payroll {
  const data = object(input)
  const payroll = select(data.payroll, ['scheduled', 'none'], '发薪安排')
  if (payroll === 'scheduled' && data.payday !== undefined && data.payday !== '' && typeof data.payday !== 'number')
    throw new InputError('请选择每月发薪日。')
  return {
    payroll,
    ...(payroll === 'scheduled' && typeof data.payday === 'number' ? { payday: data.payday } : {}),
    social: select(data.social, ['all', 'partial', 'none', 'unknown'], '社保情况'),
  }
}

function validateEnterprise(data: Enterprise | undefined, today: string): Refusal | undefined {
  if (!data?.companyName || !TAX_ID.test(data.taxId)) return refuse('ENTERPRISE_REQUIRED', '请填写企业全称和 18 位统一社会信用代码。')
  if (!isCalendarDate(data.establishedOn) || data.establishedOn > today)
    return refuse('ESTABLISHED_DATE_INVALID', '请按营业执照填写有效的成立日期。')
  if (data.province || data.city) {
    if (!Object.hasOwn(cities, data.province) || !cities[data.province]?.includes(data.city))
      return refuse('REGION_INVALID', '请重新选择省份和城市或地区。')
  }
  const unsupported = unsupportedEnterpriseFields(data)
  if (unsupported.length) return refuse('ENTERPRISE_UNSUPPORTED',
    `当前版本暂不能承接${unsupported.map(({ reason }) => reason).join('、')}的企业。请核对这一步的资料。`, { step: 1 })
  const missingTax = missingTaxFields({ ...data })
  if (missingTax.length) return refuse('TAX_DETAILS_REQUIRED', '请补齐' + missingTax.map(field => field.label).join('、') + '。', { step: 1 })
  if (!data.business.includes('none')) return refuse('BUSINESS_REQUIRED', '请确认企业目前实际开展的业务。')
  if (!data.bankStatus) return refuse('BANK_STATUS_REQUIRED', '请确认银行账户情况，资料未齐可以选待补。')
  if (data.bankStatus === 'provided' && (!data.accounts.length || data.accounts.some(account => !account.holder || !account.number || !account.bank || !account.currency)))
    return refuse('BANK_ACCOUNT_REQUIRED', '请补齐账户户名、账号、开户行和币种，资料未齐可以选待补。')
  return validateAccountValues(data.accounts, today)
}

const accountRequired = {
  holder: '请填写账户户名。', number: '请填写银行账号。', bank: '请填写开户行。', currency: '请选择账户币种。',
} as const

function validateAccountValues(accounts: readonly Account[], today: string, requireComplete = false): Refusal | undefined {
  const numbers = new Set<string>()
  for (const [index, account] of accounts.entries()) {
    if (requireComplete) {
      const missing = (Object.keys(accountRequired) as (keyof typeof accountRequired)[]).find(key => !account[key])
      if (missing) return refuse('BANK_ACCOUNT_REQUIRED', accountRequired[missing], { field: missing, index })
    }
    if (account.number && !/^\d{4,34}$/.test(account.number))
      return refuse('BANK_NUMBER_INVALID', '请输入 4 至 34 位数字。账号中的空格和短横线会自动忽略。', { field: 'number', index })
    if (account.number && numbers.has(account.number))
      return refuse('BANK_NUMBER_DUPLICATE', '该银行账号已在账户列表中，请填写另一个账号。', { field: 'number', index })
    if (account.number) numbers.add(account.number)
    if (account.currency && !/^[A-Z]{3}$/.test(account.currency))
      return refuse('BANK_CURRENCY_INVALID', '请输入三位币种代码，如 CNY。', { field: 'currency', index })
    if (account.openedOn && (!isCalendarDate(account.openedOn) || account.openedOn > today))
      return refuse('BANK_DATE_INVALID', '开户日期须为有效日期，且不能晚于今天。', { field: 'openedOn', index })
  }
}

function validateAccounting(data: Accounting | undefined, enterprise: Enterprise | undefined, today: string): Refusal | undefined {
  if (!data?.history || !PERIOD_KEY.test(data.startMonth))
    return refuse('ACCOUNTING_REQUIRED', '请选择以前的账务情况和开始记账的月份。')
  const firstMonth = enterprise?.establishedOn.slice(0, 7) ?? ''
  if (data.startMonth < firstMonth)
    return refuse('START_MONTH_BEFORE_ESTABLISHED', '开始记账的月份不能早于企业成立月份。')
  const currentMonth = today.slice(0, 7)
  const nextMonth = currentMonth.endsWith('-12') ? `${Number(currentMonth.slice(0, 4)) + 1}-01`
    : `${currentMonth.slice(0, 4)}-${String(Number(currentMonth.slice(5)) + 1).padStart(2, '0')}`
  if (data.startMonth > nextMonth)
    return refuse('START_MONTH_TOO_LATE', '开始记账的月份最晚可选下个月。')
  if (data.history === 'previous' && (!PERIOD_KEY.test(data.lastMonth) || data.lastMonth < firstMonth || data.lastMonth > currentMonth))
    return refuse('LAST_MONTH_INVALID', '请核对旧账做到的月份，应在企业成立到当前月份之间。')
  if (data.history === 'previous' && data.startMonth <= data.lastMonth)
    return refuse('BOOK_PERIOD_OVERLAP', `旧账已做到 ${data.lastMonth}。请选择之后的起账月份，或先更正旧账截止月。`, { step: 2 })
}

function validatePayroll(data: Payroll | undefined): Refusal | undefined {
  if (!data?.payroll || !data.social) return refuse('PAYROLL_REQUIRED', '请分别确认工资和社保安排。')
  if (data.payroll === 'scheduled' && (data.payday === undefined || !Number.isInteger(data.payday) || data.payday < 1 || data.payday > 31))
    return refuse('PAYDAY_INVALID', '请选择每月发薪的日期。')
}

function handoffFor(store: BookStore, { history, lastMonth, startMonth }: Accounting, bankStatus: Enterprise['bankStatus'] = ''): {
  nextAction: NextAction
  handoff: OnboardingHandoff
} {
  if (store.openingBalancesSetAt()) return {
    nextAction: 'bookkeeping',
    handoff: { kind: 'bookkeeping', guidance: '建档和期初余额已确认，可以继续记账。' },
  }
  if (history === 'previous') {
    const statementMonth = previousPeriod(startMonth)
    if (lastMonth !== statementMonth) {
      const year = Number(lastMonth.slice(0, 4))
      const month = Number(lastMonth.slice(5))
      const gapFrom = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`
      const gap = gapFrom === statementMonth ? gapFrom : `${gapFrom} 至 ${statementMonth}`
      return {
        nextAction: 'review-book-periods',
        handoff: { kind: 'review-book-periods', gapFrom, gapTo: statementMonth,
          guidance: `旧账做到 ${lastMonth}，这本账从 ${startMonth} 开始。${gap} 的账需要先确认由谁补齐。` },
      }
    }
    return {
      nextAction: 'opening-balances',
      handoff: { kind: 'prior-period-balances', statementMonth, attachment: '添加科目余额表',
        guidance: `请发 ${statementMonth} 月末的科目余额表，可以发 Excel、PDF 或清晰照片。我核对后会用它接上 ${startMonth} 的账。` },
    }
  }
  if (history === 'unrecorded') return {
    nextAction: 'opening-balances',
    handoff: {
      kind: 'reconstruct-opening-balances', openingMonth: startMonth,
      ...(bankStatus === 'provided' ? { attachment: '添加银行对账单' } : {}),
      guidance: bankStatus === 'provided'
        ? `之前已有经营，先请发能看出 ${startMonth} 月初余额的银行对账单。我会再逐项核对其他余额。`
        : `之前已有经营，请先核对 ${startMonth} 月初有哪些余额，我再按实际情况收材料。`,
    },
  }
  return {
    nextAction: 'opening-balances',
    handoff: { kind: 'confirm-opening-balances', openingMonth: startMonth,
      guidance: `请先确认 ${startMonth} 月初公司账上是否有余额，包括银行存款、现金、欠款和投入的资金。` },
  }
}

/** Preserve the four-step review when a legacy open-book call targets a company with an active draft. */
export function checkOnboardingBookOpen(store: BookStore, companyName: string, taxId?: string): Refusal | undefined {
  const draft = store.companyOnboarding()
  if (!draft || draft.revision === 0 || draft.completedAt || !draft.enterprise) return
  const name = normalizeCompanyName(draft.enterprise.companyName)
  const sameName = !!name && name === normalizeCompanyName(companyName)
  const code = draft.enterprise.taxId
  const sameCode = TAX_ID.test(code) && code === taxId?.normalize('NFKC').replace(/\s+/g, '').toUpperCase()
  if (sameName || sameCode) {
    return refuse('ONBOARDING_IN_PROGRESS', '这家企业已有建档草稿。请在对话里说「继续建档」，核对资料后再确认。', { step: draft.step })
  }
}

/** Status used for natural-language guidance. Account details and uploaded documents stay behind the onboarding UI. */
export function onboardingBookStatus(store: BookStore) {
  const record = store.companyOnboarding()
  if (!record || record.revision === 0) return undefined
  if (!record.completedAt || !record.accounting) return {
    completed: false as const,
    step: record.step,
    guidance: '企业建档资料已保存，可以从当前步骤继续。',
  }
  const { accounting, enterprise, payroll } = record
  const company = store.company()
  if (!enterprise || !company || company.isSample || company.accountingStartMonth !== accounting.startMonth ||
    company.taxId?.toUpperCase() !== enterprise.taxId ||
    normalizeCompanyName(company.name) !== normalizeCompanyName(enterprise.companyName)) return undefined
  const { nextAction, handoff } = handoffFor(store, accounting, enterprise.bankStatus)
  const payrollFact = store.companyFacts()['entity.has_payroll']
  return {
    completed: true as const, ...accounting, payroll, nextAction, handoff, guidance: handoff.guidance,
    routineMaterialExclusions: [
      ...(payroll?.payroll === 'none' && payrollFact !== 'yes' ? ['工资表'] : []),
      ...(payroll?.social === 'none' && payrollFact !== 'yes' ? ['社保缴费凭证'] : []),
    ],
    bankStatus: enterprise.bankStatus,
    confirmedAccountLabels: enterprise.bankStatus === 'provided' ? enterprise.accounts.map(accountLabel) : [],
  }
}

export class CompanyOnboarding {
  constructor(private readonly store: BookStore, private readonly now: () => Date = () => new Date()) {}

  private record(): OnboardingRecord {
    const saved = this.store.companyOnboarding()
    if (saved) {
      // Old drafts could contain contradictory choices. Preserve every reported business activity for review.
      const enterprise = saved.enterprise
      if (enterprise?.business.includes('none') && enterprise.business.some(value => value !== 'none')) {
        enterprise.business = enterprise.business.filter(value => value !== 'none')
      }
      if (enterprise && !Object.hasOwn(enterprise, 'incomeMethod')) {
        if (enterprise.taxStatus && !Object.hasOwn(taxStatusChoices, enterprise.taxStatus)) {
          enterprise.taxStatusOther = enterprise.taxStatus
          enterprise.taxStatus = '其他'
        }
        enterprise.incomeMethod = ''
        enterprise.accountingSystem ??= ''
        if (!saved.completedAt && (saved.mode !== 'scan' || enterprise.officialTax || saved.step > 1)) {
          saved.step = 1
          saved.revision++
        }
        this.store.saveCompanyOnboarding(saved)
      }
      return saved
    }
    const record: OnboardingRecord = { draftId: randomUUID(), revision: 0, step: 1 }
    const company = this.store.company()
    if (company && !company.isSample) {
      const taxId = company.taxId?.toUpperCase()
      record.enterprise = parseEnterprise({
        companyName: company.name.length <= 200 && !/\p{Cc}|\p{Cf}/u.test(company.name) ? company.name : '',
        taxId: taxId && TAX_ID.test(taxId) ? taxId : '',
      })
    }
    this.store.saveCompanyOnboarding(record)
    return record
  }

  private view(record: OnboardingRecord): OnboardingView {
    const { enterprise, draftId, revision, step, mode, accounting, payroll, completedAt } = record
    const view: OnboardingView = {
      accepted: true, draftId, revision, step, completed: !!completedAt,
      ...(mode ? { mode } : {}),
      ...(accounting ? { accounting } : {}),
      ...(payroll ? { payroll } : {}),
      ...(completedAt ? { completedAt } : {}),
      replacesSampleBook: this.store.company()?.isSample === true,
      ...(enterprise ? {
        enterprise: {
          ...enterprise,
          accounts: enterprise.accounts.map(({ number, ...account }) => ({
            ...account, ...(number ? { maskedNumber: `尾号 ${number.slice(-4)}` } : {}),
          })),
        },
      } : {}),
    }
    if (view.completed && accounting) Object.assign(view, handoffFor(this.store, accounting, enterprise?.bankStatus))
    if (!view.completed && view.step === 4 && record.accounting?.history === 'previous'
        && previousPeriod(record.accounting.startMonth) !== record.accounting.lastMonth) {
      view.handoffWarning = '旧账截止月与起账月之间有空档。请核对这段月份如何处理。'
    }
    return view
  }

  status(): OnboardingView {
    return this.store.transaction(() => this.view(this.record()))
  }

  entryState(): 'start' | 'continue' | 'deferred' | null {
    const draft = this.store.companyOnboarding()
    if (draft?.completedAt) return null
    const started = !!draft && (draft.revision > 0 || !!draft.mode || !!draft.cards?.length)
    const company = this.store.company()
    // A pre-existing formal book can be in use without an onboarding draft.
    if (!started && company && !company.isSample) return null
    if (draft?.entryDeferred) return 'deferred'
    return started ? 'continue' : 'start'
  }

  openEntry(sessionId: string) {
    return this.store.transaction(() => {
      const entry = this.entryState()
      if (entry !== 'start' && entry !== 'continue') return { accepted: true as const, entry: null }
      const result = this.guide(sessionId, 'start')
      if (!result.accepted) return result
      if (!('card' in result) || !result.card)
        return refuse('CARD_UNAVAILABLE', '当前建档步骤暂时无法打开，请重试。')
      return { accepted: true as const, entry, card: result.card, view: this.view(this.record()) }
    })
  }

  setMode(revision: number, mode: OnboardingMode): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.record()
      if (revision !== record.revision) return refuse('DRAFT_STALE', '资料已更新，请刷新后继续。')
      if (record.completedAt) return refuse('ONBOARDING_COMPLETE', '企业已经完成建档。')
      if (mode !== 'scan' && mode !== 'manual') return refuse('DRAFT_INPUT_INVALID', '请选择扫码建档或手动填写。')
      if (record.mode !== mode) {
        record.mode = mode
        record.revision++
        this.store.saveCompanyOnboarding(record)
      }
      return this.view(record)
    })
  }

  private stepValues(record: OnboardingRecord, step = record.step): Record<string, unknown> {
    return { ...({ 1: record.enterprise, 2: record.accounting, 3: record.payroll, 4: undefined }[step]) }
  }

  editSection(revision: number, section: unknown, input: unknown): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.record()
      if (revision !== record.revision) return refuse('DRAFT_STALE', '资料已更新，请核对当前版本后重试。')
      if (record.completedAt) return refuse('ONBOARDING_COMPLETE', '企业已经完成建档。')
      if (typeof section !== 'string' || !Object.hasOwn(editableSections, section))
        return refuse('DRAFT_INPUT_INVALID', '请选择需要修改的资料。')
      const { step, keys } = editableSections[section as keyof typeof editableSections]
      const current = this.stepValues(record, step)
      const today = todayInChina(this.now())
      const patch: Record<string, unknown> = {}
      try {
        for (const [key, value] of Object.entries(object(input))) {
          if (!keys.includes(key)) throw new InputError('请按当前分组修改资料。')
          if (current[key] === value) continue
          if (isOfficialField(key, record.enterprise?.officialTax))
            throw new InputError('这是从税务机关读取的资料。如需更正，请核对税务资料。')
          if (key === 'accounts') {
            if (!Array.isArray(value) || value.some(account => Object.keys(object(account))
              .some(field => !['id', 'holder', 'number', 'bank', 'currency', 'openedOn'].includes(field))))
              throw new InputError('请核对银行账户资料。')
            const accounts = parseAccounts(value, record.enterprise?.accounts ?? [])
            const invalid = validateAccountValues(accounts, today, true)
            if (invalid) return invalid
            // The original input preserves which IDs were supplied by the caller.
            patch[key] = value
          } else if (value === '' || (key === 'business' && Array.isArray(value) && !value.length)) {
            patch[key] = value
          } else {
            Object.assign(patch, fieldPatch(onboardingFields[step], {
              [key]: key === 'payday' && typeof value === 'number' ? String(value) : value,
            }, today))
          }
        }
      } catch (error) {
        return refuse('DRAFT_INPUT_INVALID', error instanceof Error ? error.message : '请核对当前资料。')
      }
      if (!Object.keys(patch).length) return this.view(record)
      const previous = record.enterprise
      const changesCompany = previous?.taxId && typeof patch.taxId === 'string' &&
        previous.taxId !== patch.taxId.toUpperCase()
      if (changesCompany && previous.accounts.length)
        return refuse('COMPANY_ACCOUNT_MISMATCH', '请先核对并移除已有银行账户，再更正信用代码。')
      const tax = changesCompany ? { province: '', city: '', ...Object.fromEntries(taxFields.map(field => [field.key, ''])) } : {}
      const saved = this.save(step, revision, { ...current, ...tax, ...patch }, false, true)
      if (saved.accepted && record.correction && patch[record.correction]) {
        const updated = this.record()
        delete updated.correction
        this.store.saveCompanyOnboarding(updated)
      }
      return saved
    })
  }

  /** Save only missing fields. Existing data, including account details, stays in the draft. */
  private saveFields(record: OnboardingRecord, fields: readonly FormField[], values: unknown, step = record.step): OnboardingView | Refusal {
    if (step === 4) return refuse('STEP_UNAVAILABLE', '请通过对话里的确认卡继续。')
    let patch: Record<string, unknown>
    try {
      patch = fieldPatch(fields, object(values), todayInChina(this.now()))
      if (!Object.keys(patch).length) throw Error('请先填写一项资料。')
    } catch (error) {
      return refuse('DRAFT_INPUT_INVALID', error instanceof Error ? error.message : '请核对当前资料。')
    }
    return this.save(step, record.revision, { ...this.stepValues(record, step), ...patch }, false)
  }

  private editCard(record: OnboardingRecord, step: EditableStep): CardContent {
    const current = this.stepValues(record, step)
    const fields = onboardingFields[step].filter(({ key }) =>
      !isOfficialField(key, record.enterprise?.officialTax) &&
      (key !== 'lastMonth' || current.history === 'previous') &&
      (key !== 'payday' || current.payroll === 'scheduled'))
    const initialValues = Object.fromEntries(fields.filter(field => current[field.key] !== undefined)
      .map(field => [field.key, field.key === 'payday' ? String(current[field.key]) : current[field.key]]))
    return { kind: 'fields', title: { 1: '更正企业资料', 2: '更正记账准备', 3: '更正工资社保' }[step], step, fields, initialValues }
  }

  private correctionCard(record: OnboardingRecord, key: CorrectionField) {
    const { step } = editableSections[correctionSections[key]]
    const field = onboardingFields[step].find(field => field.key === key)!
    const fields = [field, ...taxFields.filter(item => item.requiredWhen === key)]
    const current = this.stepValues(record, step)
    return {
      kind: 'fields' as const, step, correction: true as const,
      title: '更正' + field.label, fields,
      initialValues: Object.fromEntries(fields.map(item => [item.key, current[item.key] ?? (item.type === 'multi' ? [] : '')])),
    }
  }

  private blockerCard(record: OnboardingRecord): CardContent | undefined {
    const { enterprise } = record
    if (!enterprise || !record.mode || record.step !== 1 || (record.mode === 'scan' && !enterprise.officialTax) ||
      validateEnterprise(enterprise, todayInChina(this.now()))?.code !== 'ENTERPRISE_UNSUPPORTED') return
    const [blocker] = unsupportedEnterpriseFields(enterprise)
    if (!blocker) return
    const message = `当前资料显示${blocker.reason}，该情况暂不能建档。`
    if (isOfficialField(blocker.key, enterprise.officialTax)) {
      return { kind: 'blocked', locked: true, title: '请核对官方税务资料',
        message: message + '这项来自电子税务局，请在官网核对登记信息。' }
    }
    return {
      ...this.correctionCard(record, blocker.key), recheck: true,
      message: message + '请按实际情况核对，发现录入有误时再更正。',
    }
  }

  private prepareCorrection(record: OnboardingRecord, key: unknown, values: Record<string, unknown>) {
    if (!record.mode || !isCorrectionField(key)) return refuse('DRAFT_INPUT_INVALID', '请选择一项要更正的建档资料。')
    if (isOfficialField(key, record.enterprise?.officialTax))
      return refuse('DRAFT_INPUT_INVALID', '这是从税务机关读取的资料。如需更正，请核对税务资料。')
    if (key === 'lastMonth' && record.accounting?.history !== 'previous')
      return refuse('DRAFT_INPUT_INVALID', '请先确认有旧账，再核对旧账做到的月份。')
    const card = this.correctionCard(record, key)
    try {
      Object.assign(card.initialValues, fieldPatch(card.fields, values, todayInChina(this.now())))
    } catch (error) {
      return refuse('DRAFT_INPUT_INVALID', error instanceof Error ? error.message : '请核对当前资料。')
    }
    if (record.correction !== key) {
      record.correction = key
      record.revision++
      this.store.saveCompanyOnboarding(record)
    }
    return { accepted: true as const, card }
  }

  private documentCard(record: OnboardingRecord): DocumentCard | undefined {
    if (record.step !== 1 || !record.mode || (record.mode === 'scan' && !record.enterprise?.officialTax)) return
    const { companyName, taxId = '', establishedOn = '' } = record.enterprise ?? {}
    const missingCompany = {
      companyName: !companyName,
      taxId: !TAX_ID.test(taxId),
      establishedOn: !isCalendarDate(establishedOn) || establishedOn > todayInChina(this.now()),
    }
    const company = onboardingFields[1].filter(field =>
      companyDocumentKeys.includes(field.key) && missingCompany[field.key as keyof typeof missingCompany])
    if (company.length) return { kind: 'document', documentKind: 'license', fields: company }
    const current = this.stepValues(record)
    const missing = new Set(missingTaxFields(current).map(field => field.key))
    if (!missing.size) return
    for (const field of taxFields) {
      if (missing.has(field.key) && field.requiredWhen && !isOfficialField(field.requiredWhen, record.enterprise?.officialTax))
        missing.add(field.requiredWhen)
    }
    const fields = taxFields.filter(field => missing.has(field.key) || (field.requiredWhen && missing.has(field.requiredWhen)))
    const initialValues = Object.fromEntries(taxFields.filter(field => (missing.has(field.key) ||
      fields.some(item => item.requiredWhen === field.key)) && current[field.key]).map(field => [field.key, current[field.key]]))
    return { kind: 'document', documentKind: 'tax', fields, ...(Object.keys(initialValues).length ? { initialValues } : {}) }
  }

  private documentPreview(record: OnboardingRecord, card: DocumentCard, values: Record<string, unknown>) {
    const { enterprise } = record
    const { companyName, taxId } = values
    const normalizedTaxId = typeof taxId === 'string' ? taxId.trim().toUpperCase() : ''
    if ((typeof companyName === 'string' && enterprise?.companyName &&
        normalizeCompanyName(companyName) !== normalizeCompanyName(enterprise.companyName)) ||
        (TAX_ID.test(normalizedTaxId) && enterprise?.taxId && normalizedTaxId !== enterprise.taxId))
      return refuse('DOCUMENT_SUBJECT_MISMATCH', '资料中的企业名称或信用代码与建档草稿不一致。请核对企业后再继续。')

    const fields: Record<string, unknown> = {}
    const today = todayInChina(this.now())
    for (const field of card.fields) {
      if (!Object.hasOwn(values, field.key)) continue
      try {
        Object.assign(fields, fieldPatch([field], { [field.key]: values[field.key] }, today))
      } catch {
        // An unreadable field stays empty so the user can fill it in.
      }
    }
    if (!Object.keys(fields).length)
      return refuse('DOCUMENT_EMPTY', '没有读到可核对的缺项。可以换一份清晰资料，或直接在卡片上填写。')
    return { accepted: true as const, fields }
  }

  private nextCard(record: OnboardingRecord): CardContent | undefined {
    if (record.completedAt) return undefined
    if (record.correction) return this.correctionCard(record, record.correction)
    if (!record.mode) return { kind: 'mode' }
    const today = todayInChina(this.now())
    const enterprise = record.enterprise
    if (record.mode === 'scan' && !enterprise?.officialTax) {
      if (!enterprise?.province || !enterprise.city) return { kind: 'region' }
      if (!taxPortalFor(enterprise.province, enterprise.city))
        return { kind: 'region', message: '该辖区暂未接入扫码取数。您可以核对地区，或在聊天里告诉我改为手动填写。' }
      return { kind: 'tax-scan', province: enterprise.province, city: enterprise.city }
    }
    if (record.step === 1) {
      const blocker = this.blockerCard(record)
      if (blocker) return blocker
      const document = this.documentCard(record)
      if (document) return document
      const fields = availableFields(1, this.stepValues(record))
      const error = validateEnterprise(enterprise, today)
      if (fields.some(field => field.key === 'business')) return { kind: 'fields', title: '确认实际经营', fields: fields.filter(field => field.key === 'business') }
      if (fields.some(field => field.key === 'bankStatus')) return { kind: 'fields', title: '确认账户情况', fields: fields.filter(field => field.key === 'bankStatus') }
      if (enterprise?.bankStatus === 'provided' && !enterprise.accounts.length) return { kind: 'bank' }
      if (error) return { kind: 'blocked', message: error.message }
    } else if (record.step === 2 || record.step === 3) {
      const current = this.stepValues(record)
      const error = record.step === 2 ? validateAccounting(record.accounting, record.enterprise, today) : validatePayroll(record.payroll)
      if (error) {
        const missing = availableFields(record.step, current)
        const applicable = onboardingFields[record.step].filter(({ key }) =>
          (key !== 'lastMonth' || current.history === 'previous') && (key !== 'payday' || current.payroll === 'scheduled'))
        const fieldSet = record.step === 2 && !current.history ? applicable.filter(({ key }) => key === 'history')
          : missing.length ? missing : applicable
        const initialValues = Object.fromEntries(fieldSet.filter(({ key }) => current[key] !== undefined)
          .map(({ key }) => [key, key === 'payday' ? String(current[key]) : current[key]]))
        const expected = ['ACCOUNTING_REQUIRED', 'PAYROLL_REQUIRED'].includes(error.code)
        return { kind: 'fields', title: record.step === 2 ? '确认记账准备' : '确认工资社保', fields: fieldSet,
          ...(Object.keys(initialValues).length ? { initialValues } : {}), ...(!expected ? { message: error.message } : {}) }
      }
    } else {
      if (enterprise?.taxpayerIdentity !== 'small-scale') return {
        kind: 'fields', title: '确认纳税人类型', step: 1, message: '建档前请核实企业的纳税人类型。',
        fields: onboardingFields[1].filter(field => field.key === 'taxpayerIdentity'),
      }
      return { kind: 'confirm', replacesSampleBook: this.store.company()?.isSample === true }
    }
    // Complete stages advance once the existing domain validations pass.
    if (record.step < 4) {
      const saved = this.save(record.step as EditableStep, record.revision, this.stepValues(record))
      if (!saved.accepted) return { kind: 'blocked', message: saved.message }
      return this.nextCard(this.record())
    }
  }

  private issueCard(sessionId: string, content: CardContent, { reissue = false } = {}) {
    const record = this.record()
    const current = this.activeCard(record, sessionId)
    if (!reissue && current && JSON.stringify(this.cardContent(current.card)) === JSON.stringify(content)) return current.card
    const card: OnboardingCard = { id: randomUUID(), draftId: record.draftId, revision: record.revision, ...content }
    record.cards = [...(record.cards ?? []), { sessionId, card }]
    this.store.saveCompanyOnboarding(record)
    return card
  }

  private cardContent(card: OnboardingCard): CardContent {
    const content = { ...card } as Partial<CardBase> & CardContent
    delete content.id
    delete content.draftId
    delete content.revision
    return content
  }

  private cardResult(record: OnboardingRecord, item: StoredCard) {
    const profile = item.card.kind === 'fields' && item.card.maintenance
    return {
      accepted: true as const, view: this.view(record), stale: false,
      ...(profile ? { cardState: item.receipt ? 'saved' as const : 'active' as const } : {}),
      ...(item.receipt ? { receipt: item.receipt } : { card: item.card }),
    }
  }

  private keepCard(record: OnboardingRecord, cardId: string, content: CardContent) {
    const stored = record.cards!.find(item => item.card.id === cardId)!
    if (stored.card.revision === record.revision) record.revision++
    stored.card = { ...content, id: cardId, draftId: record.draftId, revision: record.revision }
    this.store.saveCompanyOnboarding(record)
    return { ...this.cardResult(record, stored), incomplete: true as const }
  }

  private transition(sessionId: string, cardId: string, receipt: CardReceipt, choose: () => CardContent | undefined) {
    // Close the answered card first. The next card can have the same draft revision.
    const record = this.record()
    const stored = record.cards!.find(candidate => candidate.card.id === cardId)!
    stored.receipt = receipt
    this.store.saveCompanyOnboarding(record)
    const next = choose()
    if (next) this.issueCard(sessionId, next)
    return this.cardResult(this.record(), stored)
  }

  private activeCard(record: OnboardingRecord, sessionId: string) {
    const latest = record.cards?.filter(item => item.sessionId === sessionId && item.card.revision === record.revision).at(-1)
    return latest?.receipt ? undefined : latest
  }

  private saveTaxRegion(record: OnboardingRecord, values: unknown) {
    const { province, city } = values && typeof values === 'object' ? values as Record<string, unknown> : {}
    if (typeof province !== 'string' || typeof city !== 'string' || !Object.hasOwn(cities, province) || !cities[province]?.includes(city))
      return refuse('DRAFT_INPUT_INVALID', '请先确认省份和对应的城市或地区。')
    const saved = this.save(1, record.revision, { ...record.enterprise, province, city }, false)
    if (!saved.accepted) return saved
    const content: CardContent = taxPortalFor(province, city) ? { kind: 'tax-scan', province, city, autoStart: true }
      : { kind: 'region', message: '该辖区暂未接入扫码取数。您可以核对地区，或在聊天里告诉我改为手动填写。' }
    return { ...saved, content }
  }

  hasGuide(sessionId: string): boolean {
    const record = this.store.companyOnboarding()
    return !!record && !record.completedAt && record.cards?.some(item => item.sessionId === sessionId) === true
  }

  private activeProfile() {
    const record = this.store.companyOnboarding()
    const company = this.store.company()
    if (!record?.completedAt || !record.enterprise || !company || company.isSample ||
      company.taxId !== record.enterprise.taxId || normalizeCompanyName(company.name) !== normalizeCompanyName(record.enterprise.companyName))
      return undefined
    return { ...record, enterprise: record.enterprise }
  }

  private maintainProfile(sessionId: string, edit: boolean, fields: unknown, values: unknown, currentAccountTail: unknown, accountId?: string) {
    const record = this.activeProfile()
    if (!record) return refuse('PROFILE_UNAVAILABLE', '当前账本没有已完成建档的企业档案。')
    const key = Array.isArray(fields) && fields.length === 1 ? fields[0] : undefined
    const { enterprise, accounting, payroll } = record
    const accountField = profileAccountFields.find(field => field.key === key)
    const field = accountField ?? profileFields.find(field => field.key === key)
    if (!field && key !== 'bankAccounts')
      return refuse('PROFILE_FIELD_REQUIRED', '请指定要查阅或更正的那一项企业档案资料。')
    if (currentAccountTail !== undefined && (typeof currentAccountTail !== 'string' || !/^\d{4}$/.test(currentAccountTail)))
      return refuse('PROFILE_ACCOUNT_TAIL_INVALID', '请用四位数字指定现有账户的尾号。')
    const accounts = enterprise.accounts.filter(account => accountId !== undefined
      ? account.id === accountId : currentAccountTail === undefined || accountTail(account) === currentAccountTail)
    if ((accountField || key === 'bankAccounts') && currentAccountTail !== undefined && !accounts.length)
      return refuse('PROFILE_ACCOUNT_NOT_FOUND', '企业档案中没有这个尾号的银行账户。')
    const current: Record<string, unknown> = { ...enterprise, ...accounting, ...payroll }
    if (!edit) {
      if (key === 'bankAccounts') return {
        accepted: true as const, completed: true, field: 'bankAccounts', label: '已登记的银行账户', value: accounts.map(accountLabel),
      }
      if (!field) return refuse('PROFILE_FIELD_REQUIRED', '请指定要查阅的那一项企业档案资料。')
      const labelOf = (value: unknown) => field.options?.find(option => option.value === String(value))?.label ?? value
      const value = current[field.key]
      return {
        accepted: true as const, completed: true, field: field.key, label: field.label,
        value: accountField ? accounts.map(account => ({
          account: accountLabel(account), value: (field.key === 'accountTail' ? accountTail(account) : account[field.key as keyof Account]) || null,
        })) : field.key === 'taxId' && enterprise.taxId ? '尾号 ' + enterprise.taxId.slice(-4)
          : Array.isArray(value) ? value.map(labelOf) : value ? labelOf(value) : null,
      }
    }
    if (!field || profileReadOnly.has(field.key))
      return refuse('PROFILE_FIELD_LOCKED', '这一项关联已建立的账本或账户清单，目前可查阅。')
    if (isOfficialField(field.requiredWhen ?? field.key, enterprise.officialTax))
      return refuse('PROFILE_FIELD_LOCKED', '这一项来自已核对的官方税务资料，请先核对官方记录。')
    if (field.requiredWhen && current[field.requiredWhen] !== '其他')
      return refuse('PROFILE_FIELD_NOT_APPLICABLE', '选为「其他」时才需要填写这项说明。')
    if (field.key === 'lastMonth' && accounting?.history !== 'previous')
      return refuse('PROFILE_FIELD_NOT_APPLICABLE', '当前档案未登记旧账，无需填写旧账截止月。')

    const proposed = values && typeof values === 'object' && !Array.isArray(values) ? { ...values } as Record<string, unknown> : {}
    let content: FieldsCard & { title: string; message?: string }
    if (accountField) {
      if (!accounts.length) return refuse('PROFILE_ACCOUNT_NOT_FOUND', accountId
        ? '这张卡对应的账户已不在企业档案里。' : '企业档案还没有登记银行账户。')
      content = accounts.length === 1 ? this.profileAccountCard(accountField, accounts[0]!, proposed)
        : {
          kind: 'fields', title: '选择要更正的银行账户', message: '请先确认要改哪一个账户。',
          fields: [{ key: 'accountChoice', label: '银行账户', type: 'select', options: accounts.map((account, index) => ({
            value: account.id, label: `${index + 1}. ${accountLabel(account)} · ${account.holder} · ${account.currency}`,
          })) }],
          maintenance: { field: accountField.key,
            ...(typeof proposed[accountField.key] === 'string' && this.validProfileProposal(accountField, proposed[accountField.key])
              ? { proposed: { [accountField.key]: proposed[accountField.key] } } : {}) },
        }
    } else {
      const standalone = { ...field }
      delete standalone.requiredWhen
      const input = field.key === 'payroll' ? profilePayrollField : standalone
      const form = [input, ...taxFields.filter(item => item.requiredWhen === field.key)]
      if (field.key === 'payroll') {
        current.payroll = payroll?.payroll === 'scheduled' ? payroll.payday : payroll?.payroll
        if (proposed.payroll === 'scheduled') proposed.payroll = proposed.payday ?? ''
      }
      content = this.profileFieldCard(form, current, proposed, { field: field.key })
    }
    // A previously shown card belongs to its original reply. Each new request gets
    // a fresh ID, even when the current values and requested field are identical.
    return {
      accepted: true as const, completed: true, cardState: 'active' as const,
      card: this.issueCard(sessionId, content, { reissue: true }),
    }
  }

  reopenProfileCard(sessionId: string, cardId: string) {
    return this.store.transaction(() => {
      const record = this.activeProfile()
      const previous = record?.cards?.find(item => item.sessionId === sessionId && item.card.id === cardId)?.card
      if (previous?.kind !== 'fields' || !previous.maintenance)
        return refuse('CARD_UNAVAILABLE', '这张卡无法重新打开企业档案更正。')
      const { field, accountId } = previous.maintenance
      if (field === 'addBankAccount') return this.bankAccountCard(sessionId)
      if (field === 'historicalHandoff') return this.historyScopeCard(sessionId, previous.maintenance.proposed?.handoffId)
      return this.maintainProfile(sessionId, true, [field], undefined, undefined, accountId)
    })
  }

  private bankAccountCard(sessionId: string, values?: unknown) {
    const record = this.activeProfile()
    if (!record) return refuse('PROFILE_UNAVAILABLE', '请先完成企业建档，再登记对公账户。')
    const proposed = values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {}
    const fields = [...profileAccountFields]
    const card = this.profileFieldCard(fields, { holder: record.enterprise.companyName, currency: 'CNY' }, proposed,
      { field: 'addBankAccount' }, '请按银行资料核对开户行和账号后四位。开户日期用于判断需要核对哪段流水。')
    return {
      accepted: true as const, completed: true, cardState: 'active' as const,
      card: this.issueCard(sessionId, { ...card, title: '登记对公银行账户' }, { reissue: true }),
    }
  }

  private saveNewBankAccount(sessionId: string, card: OnboardingCard & FieldsCard, record: NonNullable<ReturnType<CompanyOnboarding['activeProfile']>>, values: unknown) {
    const { enterprise } = record
    const today = todayInChina(this.now())
    let patch: Record<string, unknown>
    try {
      patch = fieldPatch(card.fields, object(values), today)
    } catch (error) {
      return refuse('PROFILE_INPUT_INVALID', error instanceof Error ? error.message : '请核对填写的账户资料。')
    }
    const holder = String(patch.holder ?? '')
    const number = String(patch.accountTail ?? '')
    const bank = String(patch.bank ?? '')
    const currency = String(patch.currency ?? '').toUpperCase()
    const openedOn = String(patch.openedOn ?? '')
    if (!/^\d{4}$/.test(number))
      return refuse('PROFILE_ACCOUNT_TAIL_INVALID', '请输入账号末尾四位数字。', { field: 'accountTail' })
    if (normalizeCompanyName(holder) !== normalizeCompanyName(enterprise.companyName))
      return refuse('PROFILE_ACCOUNT_OWNER_MISMATCH', '账户户名与本公司不符。请核对对公账户的户名。', { field: 'holder' })
    if (!bank) return refuse('BANK_ACCOUNT_REQUIRED', '请填写开户行。', { field: 'bank' })
    if (enterprise.accounts.some(account => account.number === number ||
      (accountTail(account) === number && normalizeCompanyName(account.bank) === normalizeCompanyName(bank))))
      return refuse('BANK_NUMBER_DUPLICATE', '已经登记过同一开户行和尾号，请在原账户下继续办理。', { field: 'accountTail' })
    const account = { id: randomUUID(), holder, number, bank, currency, openedOn }
    const problem = validateAccountValues([account], today, true)
    if (problem) return problem
    enterprise.accounts = [...enterprise.accounts, account]
    enterprise.bankStatus = 'provided'
    record.revision++
    this.store.saveCompanyOnboarding(record)
    const start = record.accounting?.startMonth
    const next = !openedOn ? '给这个账户补上开户日期后，就能确定需要核对哪段流水。'
      : start && openedOn < start + '-01' ? `请核对从 ${start} 起这张账户是否有遗漏的流水。`
        : `从 ${openedOn} 起核对这个账户的流水即可。`
    return this.transition(sessionId, card.id, {
      labels: ['银行账户'], choice: 'account-added', notice: `已登记${accountLabel(account)}。${next}`,
    }, () => undefined)
  }

  private historyScopeCard(sessionId: string, raw: unknown) {
    const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
      return refuse('HISTORICAL_HANDOFF_NOT_FOUND', '请先核对本公司的历史交接范围。')
    const review = readHistoricalHandoff(this.store, id)
    if (!review.accepted) return review
    const { plan } = review
    if (plan.state === 'confirmed') return { accepted: true as const, completed: true, handoff: plan }
    const message = [
      plan.missingMonths.length ? '待核对 ' + plan.missingMonths.join('、') + '。' : '资料范围内没有缺失的旧账月份。',
      ...(plan.overlapMonths.length ? ['与起账后重复的月份 ' + plan.overlapMonths.join('、') + ' 将单独留作核对。'] : []),
      '原账与起账月保留。确认范围后仍需逐项核对余额及凭据。',
    ].join('')
    return { accepted: true as const, completed: true, cardState: 'active' as const, card: this.issueCard(sessionId, {
      kind: 'fields', title: '核对历史交接月份', message,
      fields: [{ key: 'historyScopeDecision', label: '这个交接范围怎么处理', type: 'select', options: [
        { value: 'confirmed', label: '按这个范围继续核对' }, { value: 'deferred', label: '稍后处理' },
      ] }],
      maintenance: { field: 'historicalHandoff', proposed: { handoffId: id } },
    }, { reissue: true }) }
  }

  private validProfileProposal(field: FormField, value: unknown) {
    if (field.key === 'accountTail' && (typeof value !== 'string' || !/^\d{4}$/.test(value.trim()))) return false
    try {
      return Object.hasOwn(fieldPatch([field], { [field.key]: value }, todayInChina(this.now())), field.key)
    } catch {
      return false
    }
  }

  private profileFieldCard(fields: FormField[], current: Record<string, unknown>, proposed: Record<string, unknown>,
    maintenance: NonNullable<FieldsCard['maintenance']>, message?: string): FieldsCard & { title: string; message?: string } {
    return {
      kind: 'fields', title: '更正' + fields[0]!.label, fields, maintenance, ...(message ? { message } : {}),
      initialValues: Object.fromEntries(fields.map(field => {
        const key = field.key
        const value = current[key]
        const saved = typeof value === 'number' ? String(value) : value
        return [key, Object.hasOwn(proposed, key) ? (this.validProfileProposal(field, proposed[key]) ? proposed[key] : '') : saved ?? '']
      })),
    }
  }

  private profileAccountCard(field: FormField, account: Account, proposed: Record<string, unknown>) {
    const current = field.key === 'accountTail' ? accountTail(account) : account[field.key as keyof Account]
    return this.profileFieldCard([field], { [field.key]: current }, proposed,
      { field: field.key, accountId: account.id }, '当前登记为「' + accountLabel(account) + '」。')
  }

  private applyProfileAccount(enterprise: Enterprise, account: Account, key: string, value: string, today: string) {
    if (key === 'accountTail' && !/^\d{4}$/.test(value))
      return refuse('PROFILE_ACCOUNT_TAIL_INVALID', '请输入四位数字，开头的 0 也要保留。', { field: key })
    const updated = { ...account, ...(key === 'accountTail' ? { number: account.number.slice(0, -4) + value }
      : { [key]: key === 'currency' ? value.toUpperCase() : value }) }
    if (accountTail(updated) !== accountTail(account) &&
      enterprise.accounts.some(other => other.id !== account.id && accountTail(other) === accountTail(updated)))
      return refuse('PROFILE_ACCOUNT_TAIL_COLLIDES', '这个尾号已用于另一个登记账户，请核对。', { field: key })
    if (accountLabel(account) !== accountLabel(updated)) {
      const related = this.store.statementCoverage().some(({ accountRef }) => {
        const digits = accountRef.replace(/\D/g, '')
        return digits.length >= 4 && (account.number.endsWith(digits) || updated.number.endsWith(digits))
      })
      if (related) return refuse('PROFILE_ACCOUNT_HAS_STATEMENTS', '该账户或新尾号关联已导入流水。请先核对账户归属，再处理登记资料。', { field: key })
    }
    const accounts = enterprise.accounts.map(other => other.id === account.id ? updated : other)
    const problem = validateAccountValues(accounts, today)
    if (problem) return { ...problem, details: { field: key } }
    enterprise.accounts = accounts
  }

  private submitProfileCard(sessionId: string, card: OnboardingCard & FieldsCard, values: unknown) {
    const record = this.activeProfile()
    const maintenance = card.maintenance
    if (!record || !maintenance) return refuse('PROFILE_UNAVAILABLE', '当前账本没有可维护的企业档案。')
    if (maintenance.field === 'addBankAccount') return this.saveNewBankAccount(sessionId, card, record, values)
    if (maintenance.field === 'historicalHandoff') {
      const input = values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {}
      const decision = input.historyScopeDecision
      const handoffId = maintenance.proposed?.handoffId
      if (Object.keys(input).length !== 1 || (decision !== 'confirmed' && decision !== 'deferred') || typeof handoffId !== 'number')
        return refuse('HISTORICAL_DECISION_REQUIRED', '请选择继续核对或稍后处理。', { field: 'historyScopeDecision' })
      const result = confirmHistoricalHandoff(this.store, handoffId, decision, this.now())
      if (!result.accepted) return result
      return this.transition(sessionId, card.id, {
        labels: ['历史交接范围'], choice: 'history-' + result.state,
        notice: result.state === 'confirmed' ? '已确认交接范围，核对完余额和凭据后再处理。' : '历史交接已暂缓，当前业务可以继续。',
      }, () => undefined)
    }
    const { enterprise } = record
    const key = maintenance.field
    const field = card.fields[0]!
    const today = todayInChina(this.now())
    let patch: Record<string, unknown>
    try {
      patch = fieldPatch(card.fields, object(values), today)
      if (!Object.hasOwn(patch, field.key)) throw Error('请填写' + field.label + '。')
      const reason = card.fields.find(item => item.requiredWhen === key)
      if (reason) {
        if (patch[key] === '其他' && !patch[reason.key]) return refuse('PROFILE_INPUT_INVALID', '请填写' + reason.label + '。', { field: reason.key })
        if (patch[key] !== '其他') patch[reason.key] = ''
      }
    } catch (error) {
      return refuse('PROFILE_INPUT_INVALID', error instanceof Error ? error.message : '请核对填写的资料。', { field: field.key })
    }
    if (field.key === 'accountChoice') {
      const account = enterprise.accounts.find(item => item.id === patch.accountChoice)
      const accountField = profileAccountFields.find(item => item.key === key)
      if (!account || !accountField) return refuse('PROFILE_ACCOUNT_NOT_FOUND', '账户列表已更新，请重新指定要更正的账户。')
      return this.keepCard(record, card.id, this.profileAccountCard(accountField, account, maintenance.proposed ?? {}))
    }

    const before = JSON.stringify(record)
    if (maintenance.accountId) {
      const account = enterprise.accounts.find(item => item.id === maintenance.accountId)
      if (!account) return refuse('PROFILE_ACCOUNT_NOT_FOUND', '账户列表已更新，请重新指定要更正的账户。')
      const problem = this.applyProfileAccount(enterprise, account, key, patch[key] as string, today)
      if (problem) return problem
    } else if (onboardingFields[3].some(item => item.key === key)) {
      if (key === 'payroll') {
        const payday = Number(patch.payroll)
        patch = patch.payroll === 'none' ? { payroll: 'none' } : { payroll: 'scheduled', payday }
      } else if (key === 'payday') patch.payroll = 'scheduled'
      const updated = parsePayroll({ ...record.payroll, ...patch })
      const problem = validatePayroll(updated)
      if (problem) return problem
      record.payroll = updated
    } else if (key === 'lastMonth') {
      const updated = parseAccounting({ ...record.accounting, ...patch })
      const problem = validateAccounting(updated, enterprise, today)
      if (problem) return { ...problem, details: { field: key } }
      record.accounting = updated
    } else {
      const updated = { ...enterprise, ...patch }
      const unsupported = unsupportedEnterpriseFields(updated).find(item => item.key === key)
      if (unsupported) return refuse('ENTERPRISE_UNSUPPORTED', '当前版本暂不能承接' + unsupported.reason + '的企业，请按实际情况核对。', { field: key })
      if (key === 'establishedOn') {
        const problem = validateAccounting(record.accounting, updated, today)
        if (problem) return { ...problem, details: { field: key } }
      }
      if (key === 'companyName' && updated.companyName !== enterprise.companyName)
        this.store.updateCompanyName(updated.companyName)
      record.enterprise = updated
    }
    const changed = before !== JSON.stringify(record)
    if (changed) {
      record.revision++
      this.store.saveCompanyOnboarding(record)
    }
    return this.transition(sessionId, card.id, {
      labels: [field.label], notice: changed ? '已更新企业档案中的' + field.label + '。' : field.label + '与现有登记一致。',
    }, () => undefined)
  }

  guide(sessionId: string, action: OnboardingGuideAction, fields?: unknown, values?: unknown, mode?: unknown, documentKind?: unknown, currentAccountTail?: unknown) {
    return this.store.transaction(() => {
      if (action === 'read-profile' || action === 'edit-profile')
        return this.maintainProfile(sessionId, action === 'edit-profile', fields, values, currentAccountTail)
      if (action === 'add-bank-account') return this.bankAccountCard(sessionId, values)
      if (action === 'review-handoff') {
        const raw = values && typeof values === 'object' ? (values as Record<string, unknown>).handoffId : undefined
        return this.historyScopeCard(sessionId, raw)
      }
      if (action === 'defer-entry') {
        const entry = this.entryState()
        if (entry === 'start' || entry === 'continue') {
          const draft = this.record()
          draft.entryDeferred = true
          this.store.saveCompanyOnboarding(draft)
        }
        return { accepted: true as const, entry: this.entryState() }
      }
      let record = this.record()
      if (record.completedAt) return { accepted: true as const, completed: true }
      if (record.entryDeferred && (action === 'start' || action === 'continue')) {
        delete record.entryDeferred
        this.store.saveCompanyOnboarding(record)
      }
      let content: CardContent | undefined
      const supplied = values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {}
      if (action === 'correct' || (record.correction && action === 'fill')) {
        const field = action === 'correct' ? (Array.isArray(fields) && fields.length === 1 ? fields[0] : undefined) : record.correction
        const blocker = !record.correction ? this.blockerCard(record) : undefined
        if (blocker?.kind === 'fields' && blocker.fields[0]?.key === field) content = blocker
        else {
          const correction = this.prepareCorrection(record, field, supplied)
          if (!correction.accepted) return correction
          content = correction.card
          record = this.record()
        }
      } else if (action === 'switch-mode') {
        if (mode !== 'scan' && mode !== 'manual') return refuse('DRAFT_INPUT_INVALID', '请指定改用扫码建档或手动填写。')
        const changed = record.mode !== mode
        const saved = this.setMode(record.revision, mode)
        if (!saved.accepted) return saved
        record = this.record()
        if (changed && mode === 'scan' && !record.correction && !record.enterprise?.officialTax) content = { kind: 'region' }
      } else if (record.correction && action === 'review-document') {
        return correctionPending()
      }
      const before = this.activeCard(record, sessionId)?.card
      if (!record.correction && (action === 'review-document' || action === 'fill')) {
        const document = this.documentCard(record)
        if (action === 'review-document' || document) {
          if (!document || (action === 'review-document' && documentKind !== document.documentKind))
            return refuse('DOCUMENT_STEP', '请先完成当前建档步骤，再核对这份资料。')
          const reviewed = this.documentPreview(record, document, supplied)
          if (!reviewed.accepted) return reviewed
          const earlier = before?.kind === 'document' && before.documentKind === document.documentKind ? before.initialValues : undefined
          content = { ...document, initialValues: { ...earlier, ...reviewed.fields } }
        } else if (before?.kind === 'tax-scan' && Object.keys(supplied).length === 2 &&
          supplied.province === before.province && supplied.city === before.city) {
          content = this.cardContent(before)
        } else if (record.mode === 'scan' && (before?.kind === 'region' || (!before && this.nextCard(record)?.kind === 'region'))) {
          const saved = this.saveTaxRegion(record, values)
          if (!saved.accepted) return saved
          record = this.record()
          content = saved.content
        } else {
          if (record.step === 4) return refuse('STEP_UNAVAILABLE', '请通过对话里的确认卡继续。')
          if (!record.mode || (record.mode === 'scan' && !record.enterprise?.officialTax))
            return refuse('DOCUMENT_STEP', '请先选择建档方式，或完成当前扫码步骤。')
          const saved = this.saveFields(record, availableFields(record.step, this.stepValues(record)), values)
          if (!saved.accepted) return saved
          record = this.record()
        }
      }
      const stored = this.activeCard(record, sessionId)?.card
      const legacyBlocker = !record.correction && ((stored?.kind === 'blocked' && !stored.locked) ||
        (stored?.kind === 'fields' && stored.title === '核对企业情况'))
      if (legacyBlocker) {
        content ??= this.blockerCard(record)
        if (content) {
          // This legacy card may already be visible in history. Its replacement needs a fresh projection.
          record.revision++
          this.store.saveCompanyOnboarding(record)
        }
      }
      const active = stored?.kind === 'source' || stored?.kind === 'upload' ? undefined : stored
      if (!active) content ??= this.nextCard(record)
      const card = content ? this.issueCard(sessionId, content) : active
      const needsDocumentConfirmation = card?.kind === 'document' && Boolean(card.initialValues)
      const latest = this.record()
      const { enterprise, accounting, payroll } = latest
      const draftSummary = {
        ...(enterprise ? { enterprise: {
          companyName: enterprise.companyName, establishedOn: enterprise.establishedOn,
          ...(latest.mode === 'scan' ? { province: enterprise.province, city: enterprise.city } : {}),
          ...Object.fromEntries(taxFields.map(field => [field.key, enterprise[field.key as keyof Enterprise]])),
          business: enterprise.business, bankStatus: enterprise.bankStatus,
        } } : {}),
        ...(accounting ? { accounting } : {}),
        ...(payroll ? { payroll } : {}),
      }
      return { accepted: true as const, step: latest.step, ...(latest.mode ? { mode: latest.mode } : {}), draftSummary,
        ...(card ? { card } : {}), ...(needsDocumentConfirmation ? { needsDocumentConfirmation } : {}),
        ...(latest.correction ? { correctionPending: latest.correction } : {}) }
    })
  }

  claimTaxAutoStart(sessionId: string, cardId: string, revision: number) {
    return this.store.transaction(() => {
      const record = this.store.companyOnboarding()
      const item = record && this.activeCard(record, sessionId)
      if (!record || record.mode !== 'scan' || record.completedAt || revision !== record.revision ||
        item?.card.id !== cardId || item.card.kind !== 'tax-scan' || !item.card.autoStart || item.autoStartClaimed)
        return { accepted: true as const, start: false }
      item.autoStartClaimed = true
      this.store.saveCompanyOnboarding(record)
      return { accepted: true as const, start: true }
    })
  }

  isTaxScanCurrent(sessionId: string, draftId: string, cardId: string): boolean {
    const record = this.store.companyOnboarding()
    if (!record || record.draftId !== draftId || record.mode !== 'scan' || record.completedAt) return false
    const card = this.activeCard(record, sessionId)?.card
    return card?.id === cardId && card.kind === 'tax-scan'
  }

  cardStatus(sessionId: string, cardId: string) {
    return this.store.transaction(() => {
      const record = this.store.companyOnboarding() && this.record()
      const item = record?.cards?.find(item => item.sessionId === sessionId && item.card.id === cardId)
      if (!record || !item) return { accepted: true as const, stale: true }
      if (item.receipt) return this.cardResult(record, item)
      if (item.card.kind === 'tax-scan' && record.taxFlowId === cardId)
        return this.transition(sessionId, cardId, { labels: ['已回填官方税务资料'] }, () => this.nextCard(this.record()))
      const maintenance = item.card.kind === 'fields' && item.card.maintenance
      if (Boolean(record.completedAt) !== Boolean(maintenance) || item.card.kind === 'source' ||
        item.card.kind === 'upload' || this.activeCard(record, sessionId)?.card.id !== cardId)
        return { accepted: true as const, stale: true, ...(maintenance ? { cardState: 'stale' as const } : {}) }
      return this.cardResult(record, item)
    })
  }

  private activeRecognitionCard(record: OnboardingRecord, sessionId: string, cardId: string, revision: number) {
    const card = this.activeCard(record, sessionId)?.card
    return !record.completedAt && (card?.kind === 'document' || card?.kind === 'bank') &&
      card.id === cardId && card.revision === revision ? card : undefined
  }

  documentKindForCard(sessionId: string, cardId: string, revision: number) {
    const card = this.activeRecognitionCard(this.record(), sessionId, cardId, revision)
    return card?.kind === 'document' ? card.documentKind : card?.kind === 'bank' ? 'bank' : undefined
  }

  previewDocumentCard(sessionId: string, cardId: string, revision: number, fields: Record<string, unknown>) {
    const record = this.record()
    const card = this.activeRecognitionCard(record, sessionId, cardId, revision)
    if (card?.kind === 'document') return this.documentPreview(record, card, fields)
    if (card?.kind === 'bank') return { accepted: true as const, fields }
    return refuse('CARD_UNAVAILABLE', '建档资料已更新，请继续建档后重新识别。')
  }

  submitCard(sessionId: string, cardId: string, revision: number, choice: unknown, values: unknown, replaceSampleBook = false) {
    return this.store.transaction(() => {
      const record = this.record()
      const item = record.cards?.find(item => item.sessionId === sessionId && item.card.id === cardId)
      if (!item) return refuse('CARD_UNAVAILABLE', '这张建档卡已失效，请在当前对话继续建档。')
      if (item.receipt) return this.cardResult(record, item)
      const card = item.card
      const maintenance = card.kind === 'fields' && card.maintenance
      if (card.revision !== revision || Boolean(record.completedAt) !== Boolean(maintenance) || this.activeCard(record, sessionId)?.card.id !== cardId)
        return refuse('DRAFT_STALE', maintenance ? '企业档案已更新，请在对话中重新提出要更正的项目。' : '资料已更新，请发送「继续建档」刷新当前步骤。')
      if (card.kind === 'fields' && card.maintenance) return this.submitProfileCard(sessionId, card, values)
      const invalid = () => refuse('DRAFT_INPUT_INVALID', '请按当前建档卡片继续。')
      const next = (receipt: CardReceipt, content?: CardContent) =>
        this.transition(sessionId, cardId, receipt, () => content ?? this.nextCard(this.record()))
      const rechecking = card.kind === 'fields' && card.recheck
      if (record.correction || rechecking) {
        const key = record.correction ?? (card.kind === 'fields' ? card.fields[0]?.key : undefined)
        if (card.kind !== 'fields' || !card.correction || !isCorrectionField(key) || card.fields[0]?.key !== key)
          return correctionPending()
        let patch: Record<string, unknown>
        try {
          patch = fieldPatch(card.fields, object(values), todayInChina(this.now()))
          if (!Object.hasOwn(patch, key)) throw Error('请填写要核对的资料。')
          const missing = card.fields.find(field => field.requiredWhen === key && patch[key] === '其他' && !patch[field.key])
          if (missing) throw Error('请填写' + missing.label + '。')
        } catch (error) {
          return refuse('DRAFT_INPUT_INVALID', error instanceof Error ? error.message : '请核对当前资料。')
        }
        const saved = this.editSection(revision, correctionSections[key], patch)
        if (!saved.accepted) return saved
        const updated = this.record()
        if (updated.correction) {
          delete updated.correction
          updated.revision++
          this.store.saveCompanyOnboarding(updated)
        }
        const blocker = rechecking ? this.blockerCard(updated) : undefined
        if (blocker?.kind === 'fields' && blocker.fields[0]?.key === key) return this.keepCard(updated, cardId, blocker)
        return next({ labels: [card.fields[0].label], notice: '已核对并保存' + card.fields[0].label + '。' })
      }
      if (card.kind === 'mode') {
        if (choice !== 'scan' && choice !== 'manual') return invalid()
        const saved = this.setMode(revision, choice)
        return saved.accepted ? next({ labels: ['建档方式'], mode: choice },
          choice === 'scan' && !record.enterprise?.officialTax ? { kind: 'region' } : undefined) : saved
      }
      if (card.kind === 'source' || card.kind === 'upload')
        return refuse('CARD_UNAVAILABLE', '这张建档卡已更新，请按最新资料继续建档。')
      if (card.kind === 'region') {
        const saved = this.saveTaxRegion(record, values)
        if (!saved.accepted) return saved
        return next({ labels: ['税务地区'], ...(saved.content.message ? { notice: saved.content.message } : {}) }, saved.content)
      }
      if (card.kind === 'fields' || card.kind === 'document') {
        const saved = this.saveFields(record, card.fields, values, card.kind === 'document' ? 1 : card.step)
        if (!saved.accepted) return saved
        const latest = this.record()
        const blocker = this.blockerCard(latest)
        if (blocker?.kind === 'fields' && card.fields.some(field => field.key === blocker.fields[0]?.key))
          return this.keepCard(latest, cardId, blocker)
        if (card.kind === 'document') {
          const remaining = this.documentCard(latest)
          if (remaining?.documentKind === card.documentKind) {
            return this.keepCard(latest, cardId, {
              ...remaining,
              message: '已保存本次填写。还需补齐' + (remaining.documentKind === 'tax' ? missingTaxFields(this.stepValues(latest)) : remaining.fields)
                .map(field => field.label).join('、') + '。',
            })
          }
        }
        return next({ labels: card.fields.filter(field => Object.hasOwn(values as object, field.key)).map(field => field.label) })
      }
      if (card.kind === 'bank') {
        const data = values && typeof values === 'object' ? values as Record<string, unknown> : {}
        if (choice === 'skip') {
          const saved = this.save(1, revision, { ...record.enterprise, bankStatus: 'pending' }, false)
          return saved.accepted ? next({ labels: ['银行资料待补'] }) : saved
        }
        if (!record.enterprise) return invalid()
        const previous = record.enterprise.accounts
        const accounts = [...previous, {
          holder: data.holder, number: data.number, bank: data.bank, currency: data.currency || 'CNY', openedOn: data.openedOn,
        }]
        try {
          const problem = validateAccountValues(parseAccounts(accounts, previous), todayInChina(this.now()), true)
          if (problem) return problem
        } catch (error) {
          if (error instanceof InputError) return refuse('DRAFT_INPUT_INVALID', error.message)
          throw error
        }
        const saved = this.save(1, revision, { ...record.enterprise, accounts }, false)
        return saved.accepted ? next({ labels: ['已保存银行账户'] }, { kind: 'bank-next' }) : saved
      }
      if (card.kind === 'bank-next' && (choice === 'add' || choice === 'continue'))
        return next({ labels: [choice === 'add' ? '继续补充账户' : '银行账户已核对'] }, choice === 'add' ? { kind: 'bank' } : undefined)
      if (card.kind === 'confirm' && choice === 'confirm') {
        const saved = this.confirm(revision, replaceSampleBook)
        return saved.accepted ? next({ labels: ['建档已完成'], choice: 'confirm', notice: '建档已完成。' }) : saved
      }
      if (card.kind === 'confirm') {
        const step = choice === 'edit-company' ? 1 : choice === 'edit-accounting' ? 2 : choice === 'edit-payroll' ? 3 : undefined
        if (step)
          return next({ labels: ['请核对要更正的资料'] }, this.editCard(record, step))
      }
      if (card.kind === 'blocked' && choice === 'edit' && record.step === 1) {
        const blocker = this.blockerCard(record)
        if (!card.locked && blocker) return this.keepCard(record, cardId, blocker)
        return refuse('DRAFT_INPUT_INVALID', blocker?.message ?? card.message)
      }
      return invalid()
    })
  }

  save(step: EditableStep, revision: number, input: unknown, advance = true, editingDraft = false): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.record()
      if (revision !== record.revision) return refuse('DRAFT_STALE', '资料已更新，请刷新后继续。')
      if (record.completedAt) return refuse('ONBOARDING_COMPLETE', '企业已经完成建档。')
      if (advance && record.correction) return correctionPending()
      if (![1, 2, 3].includes(step) || (step > record.step && !editingDraft)) return refuse('STEP_UNAVAILABLE', '请先完成前面的步骤。')
      const today = todayInChina(this.now())
      let error: Refusal | undefined
      try {
        if (step === 1) {
          const previous = record.enterprise
          record.enterprise = parseEnterprise(input, previous)
          error = validateEnterprise(record.enterprise, today)
          const sameIdentity = editingDraft && previous && TAX_ID.test(previous.taxId) && previous.taxId === record.enterprise.taxId
          if (previous && !sameIdentity && ((previous.taxId && previous.taxId !== record.enterprise.taxId)
              || (previous.companyName && previous.companyName !== record.enterprise.companyName))) {
            delete record.accounting
            delete record.payroll
            record.step = 1
          }
        } else if (step === 2) {
          record.accounting = parseAccounting(input)
          error = validateAccounting(record.accounting, record.enterprise, today)
        } else {
          record.payroll = parsePayroll(input)
          error = validatePayroll(record.payroll)
        }
      } catch (error) {
        if (error instanceof InputError) return refuse('DRAFT_INPUT_INVALID', error.message)
        throw error
      }
      if (error && advance) return error
      if (error && step <= record.step) {
        record.step = step
      } else if (step === 1 && record.step > 2 && validateAccounting(record.accounting, record.enterprise, today)) {
        record.step = 2
      } else if (advance && step === record.step) {
        record.step = (step + 1) as Step
      }
      record.revision++
      this.store.saveCompanyOnboarding(record)
      return this.view(record)
    })
  }

  applyTaxProfile(draftId: string, province: string, city: string, profile: TaxProfile, flowId?: string, sessionId?: string): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.store.companyOnboarding()
      const enterprise = record?.enterprise
      if (!record || record.completedAt || record.mode === 'manual' || record.draftId !== draftId || !enterprise
        || (sessionId && this.activeCard(record, sessionId)?.card.id !== flowId)
        || enterprise.province !== province || enterprise.city !== city
        || !TAX_ID.test(profile.taxId) || !profile.companyName.trim()
        || (enterprise.taxId && enterprise.taxId !== profile.taxId)
        || (enterprise.companyName && normalizeCompanyName(enterprise.companyName) !== normalizeCompanyName(profile.companyName)))
        return refuse('TAX_DRAFT_CHANGED', '企业或地区已变化，请核对当前资料后重新读取。')
      enterprise.taxId ||= profile.taxId
      enterprise.companyName ||= profile.companyName
      if (!enterprise.establishedOn && profile.establishedOn && isCalendarDate(profile.establishedOn)) enterprise.establishedOn = profile.establishedOn
      if (flowId) record.taxFlowId = flowId
      const qualification = profile.taxpayerQualification ?? ''
      const taxpayerIdentity = qualification.includes('一般纳税人') ? 'general'
        : qualification.includes('小规模纳税人') ? 'small-scale' : 'unknown'
      const statuses = [profile.taxpayerStatus, profile.registrationStatus]
        .filter((status): status is string => !!status && !['待核实', '尚未读取', '未知'].includes(status))
      const taxStatus = statuses.find(isBlockedStatus) ?? statuses[0] ?? ''
      const incomeMethod = profile.incomeMethod && Object.hasOwn(incomeMethodChoices, profile.incomeMethod)
        ? profile.incomeMethod : undefined
      const accountingSystem = profile.accountingSystem && Object.hasOwn(accountingSystemChoices, profile.accountingSystem)
        ? profile.accountingSystem : undefined
      enterprise.officialTax = {
        province, city,
        taxpayerIdentity, taxStatus, taxAuthority: profile.authority,
        ...(incomeMethod ? { incomeMethod } : {}), ...(accountingSystem ? { accountingSystem } : {}),
        obligations: profile.obligations, obligationCoverage: profile.obligationCoverage,
        observedAt: profile.observedAt, sourceUrl: profile.sourceUrl,
      }
      if (taxpayerIdentity !== 'unknown') enterprise.taxpayerIdentity = taxpayerIdentity
      if (taxStatus) {
        if (Object.hasOwn(taxStatusChoices, taxStatus)) {
          enterprise.taxStatus = taxStatus
          if (taxStatus !== '其他') enterprise.taxStatusOther = ''
        } else {
          enterprise.taxStatus = '其他'
          enterprise.taxStatusOther = taxStatus
        }
      }
      if (incomeMethod) enterprise.incomeMethod = incomeMethod
      if (accountingSystem) {
        enterprise.accountingSystem = accountingSystem
        if (accountingSystem !== '其他') enterprise.accountingSystemOther = ''
      }
      enterprise.taxAuthority = profile.authority
      const today = todayInChina(this.now())
      if (validateEnterprise(enterprise, today)) record.step = 1
      record.revision++
      this.store.saveCompanyOnboarding(record)
      return this.view(record)
    })
  }

  confirm(revision: number, replaceSampleBook: boolean): OnboardingView | Refusal {
    return this.store.transaction(() => {
      const record = this.record()
      if (record.completedAt && (revision === record.revision || revision === record.revision - 1)) return this.view(record)
      if (revision !== record.revision) return refuse('DRAFT_STALE', '资料已更新，请刷新后核对。')
      if (record.correction) return correctionPending()
      if (record.step !== 4) return refuse('STEP_UNAVAILABLE', '请先填写并核对所有步骤。')
      const now = this.now()
      const today = todayInChina(now)
      const { enterprise, accounting, payroll } = record
      const error = validateEnterprise(enterprise, today) ?? validateAccounting(accounting, enterprise, today) ?? validatePayroll(payroll)
      if (error) return error
      if (!enterprise || !accounting || enterprise.taxpayerIdentity !== 'small-scale')
        return refuse('TAX_IDENTITY_UNCONFIRMED', '资料已保存。请先核实纳税人类型，再完成建档并接账。', { step: 1 })
      const company = this.store.company()
      if (company && !company.isSample) {
        const exactMatch = company.taxId?.toUpperCase() === enterprise.taxId
          && normalizeCompanyName(company.name) === normalizeCompanyName(enterprise.companyName)
          && company.accountingStartMonth === accounting.startMonth
        if (!exactMatch) return refuse('BOOK_EXISTS', '本机已有正式账本。请核对企业、信用代码和起账月份，原账本已保留。')
      } else {
        const result = openBook(this.store, {
          companyName: enterprise.companyName,
          taxId: enterprise.taxId,
          accountingStartMonth: accounting.startMonth,
          replaceSampleBook,
        })
        if (!result.accepted) return result
      }
      record.completedAt = now.toISOString()
      record.revision++
      this.store.saveCompanyOnboarding(record)
      return this.view(record)
    })
  }
}
