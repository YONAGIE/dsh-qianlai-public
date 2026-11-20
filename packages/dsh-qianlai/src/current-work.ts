import { readFileSync } from 'node:fs'

import { onboardingBookStatus } from './company-onboarding.js'
import { dueSoon } from './deadlines.js'
import type { LoadedPack } from './pack.js'
import { todayInChina } from './period.js'
import type { BookStore } from './store.js'

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export function currentWork(store: BookStore, pack: LoadedPack, now: Date) {
  const company = store.company()
  const identity = { company: company?.name ?? null, version: metadata.version, scope: 'current-local-book' as const }
  const date = todayInChina(now)
  if (!company || company.isSample) return { date, identity, reminders: [],
    nextAction: { kind: 'onboarding' as const, message: '可以开始企业建档。' } }
  if (company.accountingStartMonth > date.slice(0, 7)) return { date, identity, reminders: [],
    nextAction: { kind: 'scheduled-start' as const, message: '已约定从 ' + company.accountingStartMonth + ' 开始记账。' } }

  const reminders = dueSoon(store, pack, now)
  const onboarding = onboardingBookStatus(store)
  if (onboarding?.completed === false) return { date, identity, reminders: [],
    nextAction: { kind: 'onboarding' as const, message: onboarding.guidance } }
  if (!store.openingBalancesSetAt()) return { date, identity, reminders: [],
    nextAction: { kind: 'opening' as const, message: onboarding?.completed ? onboarding.guidance : '请核对起账月初的余额。' } }
  const due = reminders[0]
  if (due) return { date, identity, reminders, nextAction: {
    kind: 'deadline' as const, message: due.label, period: due.period, source: due.source,
  } }
  const unresolved = store.pendingWorkMatters().find(matter => matter.missing.length > 0 && (!matter.period || matter.period <= date.slice(0, 7)))
  if (unresolved) return { date, identity, reminders, nextAction: {
    kind: 'material' as const, matterId: unresolved.id, message: '请补「' + unresolved.title + '」的' + unresolved.missing[0] + '。',
  } }
  return { date, identity, reminders, nextAction: {
    kind: 'ready' as const, message: '当前没有要您处理的待补事项。收到新的发票、流水或工资资料后，我会接着办。',
  } }
}
