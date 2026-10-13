import { expect, mock, test } from 'claude-code/testing'

import { bar, canCompact, isHeadlessRefusal, hoverText, meterColor, meters, weeklyReset } from './register'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

test('fills the bar in proportion and clamps it', async () => {
  expect(bar(0)).toBe('░░░░░░░░░░')
  expect(bar(42)).toBe('████░░░░░░')
  expect(bar(100)).toBe('██████████')
  expect(bar(130)).toBe('██████████')
})

test('green below 80, yellow from 80, red from 90', async () => {
  expect(meterColor(79.9)).toBe('green')
  expect(meterColor(80)).toBe('yellow')
  expect(meterColor(89.9)).toBe('yellow')
  expect(meterColor(90)).toBe('red')
  expect(meterColor(120)).toBe('red')
})

test('one meter per known percentage', async () => {
  expect(meters({ contextPercent: 42, limits: [{ kind: 'five_hour', percentUsed: 23.5 }] }))
    .toEqual([
      { key: 'context', label: '컨텍스트', percent: 42 },
      { key: 'five_hour', label: '5시간', percent: 23.5 },
    ])
})

test('draws bars with the percent hidden until hovered', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200000, tokens: 60000, percent: 30 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 85 }],
    cost: { usd: 0.5 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: '███░░░░░░░' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '█████████░' })).toBeDefined()
    expect(await ui.find({ key: 'seven_day-bar' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /85%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$0\.50/ })).toBeDefined()
    await ui.unmount()
  }
})

const MEASURE = {
  context: { window: 200000, tokens: 60000, percent: 30 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 20 }],
  changed: ['context', 'rateLimits'] as ('context' | 'rateLimits')[],
}

test('compaction is possible only between turns once the model has answered', async () => {
  expect(canCompact({ contextPercent: 30, limits: [] }, false, false)).toBe(true)
  expect(canCompact({ contextPercent: 30, limits: [] }, true, false)).toBe(false)
  expect(canCompact({ contextPercent: 30, limits: [] }, false, true)).toBe(false)
  expect(canCompact({ limits: [] }, false, false)).toBe(false)
})

test('the button is disabled while a turn runs and enabled between turns', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure(MEASURE)
  for (const surface of ['terminal', 'desktop'] as const) {
    const busy = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
    expect(await busy.find({ key: 'compact' })).toBeUndefined()
    expect(await busy.find({ type: 'Text', text: '[ 압축 ]' })).toBeDefined()
    await busy.unmount()

    const idle = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await idle.find({ key: 'compact' })).toBeDefined()
    await idle.unmount()
  }
})

for (const [answer, expected] of [['예', 1], ['아니오', 0]] as const) {
  test(`pressing it asks first and compacts only on 예 (${answer})`, async ($, on) => {
    let compactions = 0
    const asked: string[] = []
    const toasts: string[] = []
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      const [q] = e.questions
      asked.push(`${q.question} ${q.options.map(o => o.label).join(' / ')}`)
      return { result: { questions: e.questions, answers: { [q.question]: answer } } } as never
    })
    on('session.compact', () => {
      compactions += 1
      return { skip: 'a hook said no' }
    })
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await $.session.measure(MEASURE)
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: 'compact' })
    expect(asked).toEqual(['압축하시겠습니까? 예 / 아니오'])
    expect(compactions).toBe(expected)
    expect(toasts).toEqual(expected === 1 ? ['압축하지 않았어요: a hook said no'] : [])
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    await ui.unmount()
  })
}

test('the button stays off after a compaction until the model answers again', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({ ...MEASURE, context: { window: 200000 } })
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '░░░░░░░░░░' })).toBeDefined()
  await ui.unmount()
})

// 2026-10-11 06:00 UTC; the 7-day window resets 2026-10-14 06:00 UTC.
const NOW = Date.parse('2026-10-11T06:00:00Z')
const RESETS_AT = '2026-10-14T06:00:00Z'

test('counts down to the 7-day reset in days, then hours, then minutes', async () => {
  const u = { limits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: RESETS_AT }] }
  expect(weeklyReset(u, NOW)).toBe('초기화까지 3일 0시간')
  expect(weeklyReset(u, NOW + 25 * 3600_000 + 13 * 60_000)).toBe('초기화까지 1일 22시간')
  expect(weeklyReset(u, NOW + 49 * 3600_000 + 13 * 60_000)).toBe('초기화까지 22시간 47분')
  expect(weeklyReset(u, NOW + 72 * 3600_000 - 13 * 60_000)).toBe('초기화까지 13분')
  expect(weeklyReset({ limits: [{ kind: 'seven_day', percentUsed: 40 }] }, NOW)).toBeNull()
  expect(weeklyReset({ limits: [] }, NOW)).toBeNull()
})

test('draws the countdown after the cost and moves it every minute', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200000, tokens: 60000, percent: 30 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: RESETS_AT }],
      cost: { usd: 0.5 },
    },
  }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: '초기화까지 3일 0시간' })).toBeDefined()
    await ui.unmount()
  }
  await clock.advance(72 * 3600_000 - 13 * 60_000)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '초기화까지 13분' })).toBeDefined()
  await ui.unmount()
})

test('hovering the 5-hour meter tells when it resets, with the 7-day countdown rules', async () => {
  const u = {
    limits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-11T08:13:00Z' },
      { kind: 'seven_day', percentUsed: 40, resetsAt: RESETS_AT },
    ],
  }
  const [, five, seven] = meters(u)
  expect(hoverText(u, five!, NOW)).toBe('23% · 2시간 13분 후 재설정')
  expect(hoverText(u, five!, NOW + 2 * 3600_000)).toBe('23% · 13분 후 재설정')
  expect(hoverText(u, seven!, NOW)).toBe('40%')
  expect(hoverText({ limits: [{ kind: 'five_hour', percentUsed: 23 }] }, five!, NOW)).toBe('23%')
})

test('draws the 5-hour reset time in the hover card', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200000, tokens: 60000, percent: 30 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-11T08:13:00Z' }],
    changed: ['context', 'rateLimits'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: '23% · 2시간 13분 후 재설정' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ *30% *$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('recognises the desktop app refusing to compact outside a turn', async () => {
  expect(isHeadlessRefusal('$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on')).toBe(true)
  expect(isHeadlessRefusal('a hook said no')).toBe(false)
})
