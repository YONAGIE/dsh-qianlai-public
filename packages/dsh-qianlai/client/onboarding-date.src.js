// This module is inlined into the DSH browser module by build-client.mjs.
const chinaDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/
const monthKey = (year, month) => String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0')
const parts = value => value.split('-').map(Number)
const clamp = (value, min, max) => value < min ? min : value > max ? max : value

function shiftMonth(value, delta) {
  const [year, month] = parts(value)
  const index = year * 12 + month - 1 + delta
  return monthKey(Math.floor(index / 12), (index + 12) % 12 + 1)
}

function dateAt(year, month, day) {
  const result = new Date(0)
  result.setUTCFullYear(year, month - 1, day)
  return result
}

export function onboardingDateBounds(type, name, today, establishedOn, lastMonth) {
  if (type === 'date') return { min: '0001-01-01', max: today }
  const current = today.slice(0, 7)
  const established = establishedOn?.slice(0, 7)
  const cutoff = name === 'startMonth' && monthPattern.test(lastMonth) ? shiftMonth(lastMonth, 1) : ''
  const min = [monthPattern.test(established) ? established : '0001-01', cutoff].sort().at(-1)
  return { min, max: name === 'startMonth' ? shiftMonth(current, 1) : current }
}

export function onboardingCalendarDays(year, month) {
  const start = (dateAt(year, month, 1).getUTCDay() + 6) % 7
  const length = dateAt(year, month + 1, 0).getUTCDate()
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - start + 1
    return day > 0 && day <= length ? day : null
  })
}

const dateAccent = 'var(--dsw-static-deepseek-600, #1b6f4a)'
const dateMuted = 'var(--dsw-alias-label-secondary, #54665e)'
const dateDanger = 'var(--dsw-alias-label-danger, #ad3939)'
const datePickerStyles = [
  '.qianlai-date-picker {',
  '  --ql-accent: var(--dsw-static-deepseek-600, #1b6f4a);',
  '  --ql-border: color-mix(in srgb, currentColor 17%, transparent);',
  '  position: fixed; inset: auto; margin: 0; box-sizing: border-box;',
  '  width: min(21rem, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow: auto;',
  '  padding: 12px; border: 1px solid var(--ql-border); border-radius: 14px;',
  '  background: var(--dsw-alias-background-primary, Canvas); color: var(--dsw-alias-label-primary, CanvasText);',
  '  box-shadow: 0 12px 32px #0003; font: inherit; font-size: 13px;',
  '}',
  '.qianlai-date-picker button {',
  '  padding: 0 6px; margin: 0; border: 1px solid transparent; border-radius: 7px;',
  '  font: inherit; background: transparent; color: inherit; min-height: 32px; cursor: pointer;',
  '}',
  '.qianlai-date-picker button:hover:not(:disabled) { background: color-mix(in srgb, var(--ql-accent) 10%, transparent); }',
  '.qianlai-date-picker button:focus-visible { outline: 2px solid var(--ql-accent); outline-offset: -2px; }',
  '.qianlai-date-picker button:disabled { opacity: .38; cursor: default; }',
  '.qianlai-date-picker button[aria-current] { border-color: var(--ql-accent); }',
  '.qianlai-date-picker button[aria-pressed="true"] {',
  '  color: #fff; background: var(--ql-accent); font-weight: 650;',
  '}',
  '.qianlai-date-picker button[aria-pressed="true"]:hover:not(:disabled) {',
  '  background: color-mix(in srgb, var(--ql-accent) 90%, #000);',
  '}',
  '.qianlai-date-picker button[aria-pressed="true"]:focus-visible {',
  '  box-shadow: inset 0 0 0 2px currentColor; outline: 1px solid var(--ql-accent); outline-offset: 0;',
  '}',
  '.qianlai-date-picker .ql-date-bar { display: flex; align-items: center; justify-content: space-between; gap: 4px; }',
  '.qianlai-date-picker .ql-date-heading { border-bottom: 1px solid var(--ql-border); padding-bottom: 6px; }',
  '.qianlai-date-picker .ql-date-heading strong { display: flex; align-items: center; gap: 7px; }',
  '.qianlai-date-picker .ql-date-nav { margin: 8px 0 6px; }',
  '.qianlai-date-picker .ql-date-nav button[data-step], .qianlai-date-picker .ql-date-close { min-width: 30px; font-size: 17px; }',
  '.qianlai-date-picker .ql-date-jump {',
  '  margin: 0 2px; color: var(--ql-accent); font-weight: 650; min-height: 28px;',
  '}',
  '.qianlai-date-picker .ql-date-grid { display: grid; gap: 3px; text-align: center; }',
  '.qianlai-date-picker .ql-date-grid button { min-width: 0; padding-inline: 2px; font-variant-numeric: tabular-nums; }',
  '.qianlai-date-picker .ql-date-week { font-size: 11px; margin-bottom: 3px; }',
  '.qianlai-date-picker .ql-date-footer { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--ql-border); }',
  '.qianlai-date-picker .ql-date-footer button { color: var(--ql-accent); }',
].join('\n')

const dateProxy = {
  position: 'absolute', width: 1, height: 1, padding: 0, overflow: 'hidden',
  clipPath: 'inset(50%)', pointerEvents: 'none',
}

function positionDatePopover(popover, trigger) {
  const anchor = trigger.getBoundingClientRect()
  const { clientWidth: width, clientHeight: height } = trigger.ownerDocument.documentElement
  if (anchor.bottom <= 0 || anchor.top >= height) return false
  const x = clamp(anchor.left, 8, Math.max(8, width - popover.offsetWidth - 8))
  const below = anchor.bottom + 6
  const above = anchor.top - popover.offsetHeight - 6
  const y = clamp(below + popover.offsetHeight + 8 <= height ? below : above,
    8, Math.max(8, height - popover.offsetHeight - 8))
  Object.assign(popover.style, { left: x + 'px', top: y + 'px' })
  return true
}

function moveDateGridFocus(event, columns) {
  const { currentTarget: grid, target } = event
  const cell = target.closest('[data-cell]')
  if (!cell) return
  const shift = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key]
  if (!shift) return
  event.preventDefault()
  event.stopPropagation()
  const count = columns === 7 ? 42 : 12
  for (let i = Number(cell.dataset.cell) + shift; i >= 0 && i < count; i += shift) {
    const next = grid.querySelector('[data-cell="' + i + '"]:not(:disabled)')
    if (!next) continue
    grid.querySelector('[tabindex="0"]')?.setAttribute('tabindex', '-1')
    next.tabIndex = 0
    next.focus()
    break
  }
}

export function createOnboardingDateInput({ jsx, useState, useRef, useEffect }, supportsPopover) {
  if (!supportsPopover) {
    return function NativeDateInput({ label: _label, establishedOn: _establishedOn, lastMonth: _lastMonth, ...input }) {
      return jsx('input', input)
    }
  }

  return function OnboardingDateInput({ id, name, type, label, value, required, disabled, onChange, onBlur, style,
    establishedOn, lastMonth, min: minOverride, max: maxOverride, 'aria-invalid': invalid, 'aria-describedby': describedBy }) {
    const trigger = useRef(null)
    const popover = useRef(null)
    const nextFocus = useRef('')
    const [picker, setPicker] = useState(null)
    const [missing, setMissing] = useState(false)
    const isDay = type === 'date'
    const today = chinaDate.format(new Date())
    const todayValue = isDay ? today : today.slice(0, 7)
    const dates = onboardingDateBounds(type, name, today, establishedOn, lastMonth)
    const min = minOverride ?? dates.min
    const max = maxOverride ?? dates.max
    const hasChoices = min <= max
    const initial = isDay ? /^\d{4}-\d{2}-\d{2}$/.test(value) : monthPattern.test(value)
    const cursor = clamp(picker?.value ?? (initial ? value : todayValue), min, max)
    const [year, month] = parts(cursor)
    const popupId = id + '-picker'
    const popupTitle = '选择' + label.replace('（选填）', '')
    const open = Boolean(picker && !disabled)
    const mode = picker?.mode
    const isYearView = mode === 'year'
    const isDayView = mode === 'day'

    function close(restoreFocus) {
      setPicker(null)
      if (restoreFocus) trigger.current?.focus({ preventScroll: true })
    }

    useEffect(() => {
      if (!open) return
      const panel = popover.current
      const button = trigger.current
      const doc = button?.ownerDocument
      if (!doc || !panel) return
      function reposition() {
        if (!positionDatePopover(panel, button)) setPicker(null)
      }
      function dismiss(event) {
        if (!panel.contains(event.target) && !button.contains(event.target)) setPicker(null)
      }
      panel.showPopover()
      reposition()
      const view = doc.defaultView
      const Resize = view?.ResizeObserver
      const Intersection = view?.IntersectionObserver
      const resize = Resize ? new Resize(reposition) : undefined
      resize?.observe(panel)
      resize?.observe(button)
      const intersection = Intersection ? new Intersection(([entry]) => {
        if (!entry.isIntersecting) setPicker(null)
      }) : undefined
      intersection?.observe(button)
      view?.addEventListener('resize', reposition)
      doc.addEventListener('scroll', reposition, true)
      doc.addEventListener('pointerdown', dismiss, true)
      doc.addEventListener('focusin', dismiss)
      return () => {
        intersection?.disconnect()
        resize?.disconnect()
        view?.removeEventListener('resize', reposition)
        doc.removeEventListener('scroll', reposition, true)
        doc.removeEventListener('pointerdown', dismiss, true)
        doc.removeEventListener('focusin', dismiss)
        if (panel.matches(':popover-open')) panel.hidePopover()
      }
    }, [open])

    useEffect(() => {
      if (!open || !popover.current) return
      const panel = popover.current
      const step = nextFocus.current && panel.querySelector('[data-step="' + nextFocus.current + '"]:not(:disabled)')
      const target = step || panel.querySelector('[data-cell][tabindex="0"]') || panel.querySelector('.ql-date-close')
      target?.focus({ preventScroll: true })
    }, [open, picker])

    useEffect(() => {
      if (disabled) setPicker(null)
    }, [disabled])

    function toggle() {
      if (open) return close(true)
      nextFocus.current = ''
      setPicker({ mode: isDay ? 'day' : 'month', value: cursor })
    }

    function onEscape(event) {
      if (open && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close(true)
      }
    }

    function apply(next) {
      setMissing(false)
      onChange({ target: { value: next } })
      close(true)
    }

    function jump(mode, period, focus = '') {
      nextFocus.current = focus
      setPicker({ mode, value: clamp(period, min, max) })
    }

    const yearStart = Math.floor((year - 1) / 12) * 12 + 1
    const [minYear] = parts(min)
    const [maxYear] = parts(max)
    const monthCursor = cursor.slice(0, 7)
    const minMonth = min.slice(0, 7)
    const maxMonth = max.slice(0, 7)
    const display = initial ? parts(value) : []
    const dateLabel = initial
      ? display[0] + ' 年 ' + display[1] + ' 月' + (isDay ? ' ' + display[2] + ' 日' : '')
      : isDay ? '选择日期' : '选择月份'
    const action = (text, onClick, props = {}) => jsx('button', { type: 'button', onClick, ...props, children: text })
    const primaryMode = isDay ? 'day' : 'month'
    const periodFor = period => isDay ? period + '-01' : period
    const group = isDayView ? '月' : '年'
    const columns = isDayView ? 7 : 3
    const gridStyle = { gridTemplateColumns: 'repeat(' + columns + ', minmax(0, 1fr))' }

    function step(delta) {
      if (isYearView) return periodFor(monthKey(clamp(yearStart + delta * 12, minYear, maxYear), 1))
      return periodFor(shiftMonth(monthCursor, delta * (isDayView ? 1 : 12)))
    }

    const rawOptions = !open || !hasChoices ? [] : isDayView ? onboardingCalendarDays(year, month)
      : Array.from({ length: 12 }, (_, i) => isYearView ? yearStart + i : i + 1)
    const options = rawOptions.map((number, index) => {
      if (!number) return null
      if (isYearView) return { index, number, allowed: number >= minYear && number <= maxYear, current: number === year }
      if (!isDayView) {
        const period = monthKey(year, number)
        return { index, number, value: period, allowed: period >= minMonth && period <= maxMonth, current: month === number }
      }
      const dayValue = monthCursor + '-' + String(number).padStart(2, '0')
      return { index, number, value: dayValue, allowed: dayValue >= min && dayValue <= max, current: dayValue === cursor }
    })
    const focusedCell = options.find(option => option?.current && option.allowed) ?? options.find(option => option?.allowed)

    function choose(option) {
      if (isYearView) return jump(primaryMode, periodFor(monthKey(option.number, month)))
      if (isDay && !isDayView) return jump('day', periodFor(option.value))
      apply(option.value)
    }

    const dateErrorId = id + '-date-required'
    const showMissing = missing && required && !value
    const icon = jsx('span', { 'aria-hidden': true, style: {
      width: 15, height: 14, flex: 'none', boxSizing: 'border-box', border: '1.5px solid currentColor',
      borderRadius: 3, color: dateAccent, display: 'grid', alignContent: 'start',
    }, children: jsx('span', { style: { borderTop: '1px solid currentColor', marginTop: 3 } }) })

    return jsx('div', { style: { minWidth: 0, position: 'relative' }, children: [
      // Preserve native FormData and required-field validation while the button is the visible control.
      jsx('input', {
        name, type, value, required, disabled, onChange, style: dateProxy, 'aria-hidden': true, tabIndex: -1,
        onFocus: () => trigger.current?.focus({ preventScroll: true }),
        onInvalid: event => {
          event.preventDefault()
          setMissing(true)
          trigger.current?.focus()
        },
      }),
      jsx('button', {
        ref: trigger, id, type: 'button', disabled, onClick: toggle, onKeyDown: onEscape, onBlur,
        'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? popupId : undefined,
        'aria-label': label + '，' + dateLabel, 'aria-invalid': invalid || showMissing || undefined,
        'aria-describedby': [describedBy, showMissing && dateErrorId].filter(Boolean).join(' ') || undefined,
        style: { ...style, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          textAlign: 'start', cursor: disabled ? 'default' : 'pointer', color: initial ? 'inherit' : dateMuted,
          ...(showMissing ? { borderColor: dateDanger } : {}) },
        children: [jsx('span', { children: dateLabel }), icon],
      }),
      showMissing ? jsx('span', { role: 'alert', id: dateErrorId,
        style: { color: dateDanger, fontSize: '0.875em' }, children: '请选择' + label + '。' }) : null,
      open ? jsx('div', {
        ref: popover, id: popupId, popover: 'manual', role: 'dialog', 'aria-labelledby': popupId + '-title',
        className: 'qianlai-date-picker', onKeyDown: onEscape, children: [
          jsx('style', { children: datePickerStyles }),
          jsx('div', { className: 'ql-date-bar ql-date-heading', children: [
            jsx('strong', { id: popupId + '-title', children: [icon, popupTitle] }),
            action('×', () => close(true), { 'aria-label': '关闭日期选择', className: 'ql-date-close' }),
          ] }),
          hasChoices ? [
            jsx('div', { className: 'ql-date-bar ql-date-nav', children: [
              action('‹', () => jump(mode, step(-1), 'previous'), { 'data-step': 'previous',
                'aria-label': isYearView ? '上一组年份' : '上一' + group,
                disabled: isYearView ? yearStart <= minYear : isDayView ? monthCursor <= minMonth : year <= minYear }),
              isYearView ? jsx('span', { 'aria-live': 'polite', children: yearStart + '–' + (yearStart + 11) + ' 年' })
                : jsx('div', { children: [
                  action(year + ' 年 ⌄', () => jump('year', cursor), { 'aria-label': '跳到年份', className: 'ql-date-jump' }),
                  isDayView ? action(month + ' 月 ⌄', () => jump('month', cursor),
                    { 'aria-label': '跳到月份', className: 'ql-date-jump' }) : null,
                ] }),
              action('›', () => jump(mode, step(1), 'next'), { 'data-step': 'next',
                'aria-label': isYearView ? '下一组年份' : '下一' + group,
                disabled: isYearView ? yearStart + 11 >= maxYear : isDayView ? monthCursor >= maxMonth : year >= maxYear }),
            ] }),
            isDayView ? jsx('div', { className: 'ql-date-grid ql-date-week', style: gridStyle, 'aria-hidden': true,
              children: [...'一二三四五六日'].map(day => jsx('span', { children: day }, day)) }) : null,
            jsx('div', {
              className: 'ql-date-grid', style: gridStyle, role: 'group',
              'aria-label': isYearView ? '选择年份' : isDayView ? year + ' 年 ' + month + ' 月' : '选择月份',
              onKeyDown: event => moveDateGridFocus(event, columns),
              children: options.map((option, index) => {
                if (!option) return jsx('span', { 'aria-hidden': true }, index)
                const { number, allowed } = option
                return jsx('button', {
                  type: 'button', 'data-cell': index, disabled: !allowed, tabIndex: option === focusedCell ? 0 : -1,
                  'aria-label': isDayView ? year + ' 年 ' + month + ' 月 ' + number + ' 日' : undefined,
                  'aria-pressed': isDayView || (!isDay && !isYearView) ? option.value === value : option.current,
                  'aria-current': isDayView && option.value === todayValue ? 'date' : undefined,
                  onClick: () => choose(option), children: isYearView ? number + ' 年' : isDayView ? number : number + ' 月',
                }, index)
              }),
            }),
          ] : jsx('p', { children: '请先核对成立日期和旧账月份。' }),
          jsx('div', { className: 'ql-date-bar ql-date-footer', children: [
            action('清空', () => apply(''), { disabled: !value }),
            action(isDay ? '今天' : '本月', () => apply(todayValue), { disabled: todayValue < min || todayValue > max }),
          ] }),
        ],
      }) : null,
    ] })
  }
}
