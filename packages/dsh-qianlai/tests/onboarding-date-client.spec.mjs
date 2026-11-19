import { describe, expect, it } from 'vitest'

import { onboardingCalendarDays, onboardingDateBounds } from '../client/onboarding-date.src.js'

describe('建档日历', () => {
  it('按周一开头并保留真实闰日，跨世纪也按公历计算', () => {
    const leapMonth = onboardingCalendarDays(2016, 2)
    expect(leapMonth).toHaveLength(42)
    expect(leapMonth.slice(0, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(leapMonth.at(28)).toBe(29)
    expect(onboardingCalendarDays(1900, 2)).not.toContain(29)
    expect(onboardingCalendarDays(2026, 11).slice(0, 7)).toEqual([null, null, null, null, null, null, 1])
  })

  it('按公司成立日、旧账月份与当前业务日期界定可选范围', () => {
    const today = '2026-12-23'
    expect(onboardingDateBounds('date', 'establishedOn', today)).toEqual({ min: '0001-01-01', max: today })
    expect(onboardingDateBounds('month', 'lastMonth', today, '2016-02-29')).toEqual({ min: '2016-02', max: '2026-12' })
    expect(onboardingDateBounds('month', 'startMonth', today, '2016-02-29', '2026-12'))
      .toEqual({ min: '2027-01', max: '2027-01' })
    expect(onboardingDateBounds('month', 'startMonth', today, '2025-03-14', '2024-10'))
      .toEqual({ min: '2025-03', max: '2027-01' })
  })
})
