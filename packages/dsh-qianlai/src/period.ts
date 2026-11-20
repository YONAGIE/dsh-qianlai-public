export const PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

export type Refusal = { readonly accepted: false; readonly code: string; readonly message: string; readonly details?: unknown }

export const refuse = (code: string, message: string, details?: unknown): Refusal =>
  details === undefined ? { accepted: false, code, message } : { accepted: false, code, message, details }

/** `YYYY-MM-DD` 且是日历上真有的一天。 */
export function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

/** 某月的第一天与最后一天。 */
export function monthRange(periodKey: string): { from: string; to: string } {
  const [year, month] = periodKey.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${periodKey}-01`, to: `${periodKey}-${String(last).padStart(2, '0')}` }
}

export function previousPeriod(periodKey: string): string {
  const [year, month] = periodKey.split('-').map(Number) as [number, number]
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
}

export function nextPeriod(periodKey: string): string {
  const [year, month] = periodKey.split('-').map(Number) as [number, number]
  return month === 12 ? String(year + 1).padStart(4, '0') + '-01'
    : periodKey.slice(0, 5) + String(month + 1).padStart(2, '0')
}

/** 记账按北京时间算日子：`now` 在北京时间是哪一天，YYYY-MM-DD。 */
export function todayInChina(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
