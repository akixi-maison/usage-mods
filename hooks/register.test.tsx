import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  appendLine,
  bar,
  BAR_PX,
  barSvg,
  canCompact,
  describePrompt,
  hasCompacted,
  hoverParts,
  hoverText,
  isHeadlessRefusal,
  LOG_FILE,
  meterColor,
  meters,
  OFF_HINT,
  QUEUE_TIMEOUT,
  shouldSendCompact,
  weeklyReset,
} from './register'

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

test('the theme\'s success below 80, warning from 80, error from 90', async () => {
  expect(meterColor(79.9)).toBe('success')
  expect(meterColor(80)).toBe('warning')
  expect(meterColor(89.9)).toBe('warning')
  expect(meterColor(90)).toBe('error')
  expect(meterColor(120)).toBe('error')
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
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: '███░░░░░░░' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '█████████░' })).toBeDefined()
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    } else {
      expect(await ui.find({ type: 'Text', text: /█|░/ })).toBeUndefined()
      const bars = await ui.findAll({ type: 'Svg' })
      expect(bars.map(b => b.props.alt)).toEqual(['컨텍스트 30%', '7일 85%'])
      expect(bars[1]?.props).toMatchObject({ source: barSvg(85, 'warning'), ...BAR_PX })
    }
    expect(await ui.find({ key: 'seven_day-bar' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /사용량/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /85%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$0\.50/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the desktop bar fills in proportion, clamped, and shows a dot for a little use', async () => {
  const fill = (svg: string) => [...svg.matchAll(/<rect width="([\d.]+)"/g)].map(m => Number(m[1]))
  expect(fill(barSvg(0, 'success'))).toEqual([96])
  expect(fill(barSvg(24, 'success'))).toEqual([96, 23])
  expect(fill(barSvg(1, 'success'))).toEqual([96, 6])
  expect(fill(barSvg(100, 'error'))).toEqual([96, 96])
  expect(fill(barSvg(130, 'error'))).toEqual([96, 96])
  expect(barSvg(24, 'success')).toContain('fill="#2f9e57"')
  expect(barSvg(95, 'error')).toContain('fill="#d93f3f"')
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
    expect((await busy.find({ key: 'compact-off' }))?.props).toMatchObject({ label: '압축', dimColor: true })
    await busy.unmount()

    const idle = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await idle.find({ key: 'compact' })).toBeDefined()
    await idle.unmount()
  }
})

test('pressing the button while it is off only says why', async ($, on) => {
  const clock = mock.clock(on)
  let asked = 0
  const toasts: string[] = []
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked += 1
    return { result: {} } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.measure(MEASURE)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
    await ui.press({ key: 'compact-off' })
    await clock.advance(0)
    await ui.unmount()
  }
  expect(toasts).toEqual([OFF_HINT, OFF_HINT])
  expect(asked).toBe(0)
})

for (const [answer, expected] of [['예', 1], ['아니오', 0]] as const) {
  test(`pressing it asks first and compacts only on 예 (${answer})`, async ($, on) => {
    const clock = mock.clock(on)
    let compactions = 0
    const asked: string[] = []
    const toasts: string[] = []
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      const q = e.questions[0]!
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
    await clock.advance(0)
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

test('draws the countdown beside the 7-day bar, before the cost, and moves it every minute', async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: /^ ?초기화까지 3일 0시간$/ })).toBeDefined()
    expect(JSON.stringify(await ui.find({ key: 'seven_day' }))).toContain('초기화까지 3일 0시간')
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.indexOf('초기화까지')).toBeLessThan(drawn.indexOf('0.50'))
    await ui.unmount()
  }
  await clock.advance(72 * 3600_000 - 13 * 60_000)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /^ ?초기화까지 13분$/ })).toBeDefined()
  await ui.unmount()
})

test('hovering a limit meter tells when it resets, with the 7-day countdown rules', async () => {
  const u = {
    contextPercent: 30,
    limits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-11T08:13:00Z' },
      { kind: 'seven_day', percentUsed: 40, resetsAt: RESETS_AT },
    ],
  }
  const [context, five, seven] = meters(u)
  expect(hoverText(u, five!, NOW)).toBe('23% · 2시간 13분 후 초기화')
  expect(hoverText(u, five!, NOW + 2 * 3600_000)).toBe('23% · 13분 후 초기화')
  expect(hoverText(u, seven!, NOW)).toBe('40% · 3일 0시간 후 초기화')
  expect(hoverParts(u, seven!, NOW)).toEqual({ percent: '40%', reset: '3일 0시간 후 초기화' })
  expect(hoverText(u, context!, NOW)).toBe('30%')
  expect(hoverText({ limits: [{ kind: 'five_hour', percentUsed: 23 }] }, five!, NOW)).toBe('23%')
})

const RESET_MEASURE = {
  context: { window: 200000, tokens: 60000, percent: 30 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-11T08:13:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: RESETS_AT },
  ],
  changed: ['context', 'rateLimits'] as ('context' | 'rateLimits')[],
}

test('the terminal reverses the hover over the bar cells', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure(RESET_MEASURE)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await ui.find({ type: 'Text', text: '23% · 2시간 13분 후 초기화' }))?.props.inverse).toBe(true)
  expect(await ui.find({ type: 'Text', text: '40% · 3일 0시간 후 초기화' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^ *30% *$/ }))?.props.inverse).toBe(true)
  await ui.unmount()
})

test('the desktop hover card holds plain text: the percent in its color, then when it resets', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure(RESET_MEASURE)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const percent = await ui.find({ type: 'Text', text: '23%' })
  expect(percent?.props).toMatchObject({ bold: true, color: 'success' })
  expect(percent?.props.inverse).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ' · 2시간 13분 후 초기화' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · 3일 0시간 후 초기화' })).toBeDefined()
  // No padding to the bar's width around a short percent.
  expect(await ui.find({ type: 'Text', text: '30%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ +30%/ })).toBeUndefined()
  await ui.unmount()
})

test('recognises the desktop app refusing to compact outside a turn', async () => {
  expect(isHeadlessRefusal('$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on')).toBe(true)
  expect(isHeadlessRefusal('a hook said no')).toBe(false)
})

test('the compaction still runs when the band is redrawn away right after the press', async ($, on) => {
  const clock = mock.clock(on)
  let compactions = 0
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = e.questions[0]!
    return { result: { questions: e.questions, answers: { [q.question]: '예' } } } as never
  })
  on('session.compact', () => {
    compactions += 1
    return { skip: 'a hook said no' }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'compact' })
  await ui.unmount()
  await clock.advance(0)
  expect(compactions).toBe(1)
})

test('a second press while the question is open does not ask twice', async ($, on) => {
  const clock = mock.clock(on)
  let asked = 0
  let answer: (value: unknown) => void = () => {}
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    asked += 1
    await new Promise(resolve => {
      answer = resolve
    })
    const q = e.questions[0]!
    return { result: { questions: e.questions, answers: { [q.question]: '아니오' } } } as never
  })
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'compact' })
  await clock.advance(0)
  await clock.advance(0)
  answer(undefined)
  expect(asked).toBe(1)
  await ui.unmount()
})

test('a refused compaction becomes /compact where no person is at the prompt, or when it says headless', async () => {
  expect(shouldSendCompact('a turn is running', false)).toBe(true)
  expect(shouldSendCompact('not available in a headless (-p / SDK) session yet', true)).toBe(true)
  expect(shouldSendCompact('a turn is running', true)).toBe(false)
})

type TestArgs = Parameters<TestBody>
// The desktop app's world: an SDK session (no person at the prompt) whose $.session.compact refuses,
// and whose /compact command runs until `endCommand` and prints `output`; `compactConversation`
// empties the context as a compaction does.
const desktopCompaction = async ($: TestArgs[0], on: TestArgs[1], output = '') => {
  const commands: string[] = []
  const toasts: string[] = []
  let context: { window: number; tokens?: number; percent?: number } = MEASURE.context
  let endCommand = () => {}
  const commandEnded = new Promise<void>(resolve => {
    endCommand = resolve
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context, rateLimits: MEASURE.rateLimits } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = e.questions[0]!
    return { result: { questions: e.questions, answers: { [q.question]: '예' } } } as never
  })
  on('command.run', { command: 'compact' }, async ($, e) => {
    commands.push(`/${e.command} from ${e.origin.kind}`)
    await commandEnded
    return { text: output }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.session.measure(MEASURE)
  return {
    commands,
    toasts,
    compactConversation: () => {
      context = { window: 200000 }
    },
    endCommand,
  }
}

test('in the desktop app it runs /compact and stays compacting until the compaction lands', async ($, on) => {
  const clock = mock.clock(on)
  const world = await desktopCompaction($, on)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'compact' })
  await clock.advance(0)
  expect(world.commands).toEqual(['/compact from plugin'])
  expect(world.toasts).toEqual(['압축을 요청했어요'])
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
  expect((await ui.find({ key: 'compact-off' }))?.props.label).toBe('압축 중…')

  // The command compacts the conversation, then ends.
  world.compactConversation()
  world.endCommand()
  await clock.advance(0)
  expect(world.toasts).toEqual(['압축을 요청했어요', '컨텍스트를 압축했어요'])
  // Out of compacting, and off until the model answers again (the context fill is unknown).
  expect((await ui.find({ key: 'compact-off' }))?.props.label).toBe('압축')

  // Letting go of the wait went with it.
  await clock.advance(QUEUE_TIMEOUT)
  expect(world.toasts).toEqual(['압축을 요청했어요', '컨텍스트를 압축했어요'])
  await ui.unmount()
})

test('a /compact that compacts nothing says so and frees the button', async ($, on) => {
  const clock = mock.clock(on)
  const world = await desktopCompaction($, on, 'Not enough messages to compact.')
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'compact' })
  await clock.advance(0)
  world.endCommand()
  await clock.advance(0)
  expect(world.toasts).toEqual(['압축을 요청했어요', '압축되지 않았어요: Not enough messages to compact.'])
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await ui.unmount()
})

test('a /compact still queued after the wait lets go of the button', async ($, on) => {
  const clock = mock.clock(on)
  const world = await desktopCompaction($, on)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'compact' })
  await clock.advance(0)
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
  expect((await ui.find({ key: 'compact-off' }))?.props.label).toBe('압축 중…')
  await clock.advance(QUEUE_TIMEOUT)
  expect(world.toasts).toEqual(['압축을 요청했어요', '압축되지 않았어요. 입력창에 /compact를 보내 주세요'])
  expect(await ui.find({ key: 'compact' })).toBeDefined()

  // The command ending later changes nothing more.
  world.endCommand()
  await clock.advance(0)
  expect(world.toasts).toHaveLength(2)
  await ui.unmount()
})

test('the command compacted when the context fill dropped or is unknown again', async () => {
  expect(hasCompacted(30, 4)).toBe(true)
  expect(hasCompacted(30, undefined)).toBe(true)
  expect(hasCompacted(30, 30)).toBe(false)
  expect(hasCompacted(30, 31)).toBe(false)
})

test('the button is off while a turn runs even when the band is told it is idle', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'hello', turnId: 't1' })
  const busy = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await busy.find({ key: 'compact' })).toBeUndefined()
  await busy.unmount()

  // A subagent's turn ending does not end the main one.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' })
  const still = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await still.find({ key: 'compact' })).toBeUndefined()
  await still.unmount()

  await $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const idle = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await idle.find({ key: 'compact' })).toBeDefined()
  await idle.unmount()
})

test('the trace keeps the newest lines and names no prompt but /compact', async () => {
  expect(appendLine('', 'a')).toBe('a\n')
  expect(appendLine('a\nb\n', 'c')).toBe('a\nb\nc\n')
  expect(appendLine('a\nb\nc\n', 'd', 3)).toBe('b\nc\nd\n')
  expect(describePrompt('/compact')).toBe('/compact')
  expect(describePrompt('my secret plan')).toBe('prompt of 14 chars')
})

test('each step of a press is written to the trace file under HOME', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/someone' })
  let file = ''
  const paths: string[] = []
  on('fs.read', () => ({ value: file }))
  on('fs.write', ($, e) => {
    paths.push(e.path)
    file = e.text
    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = e.questions[0]!
    return { result: { questions: e.questions, answers: { [q.question]: '아니오' } } } as never
  })
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'compact' })
  await clock.advance(0)
  for (let i = 0; i < 20 && !file.includes('declined'); i += 1) {
    await clock.advance(0)
  }
  expect(new Set(paths)).toEqual(new Set([`/home/someone/${LOG_FILE}`]))
  expect(file).toMatch(/pressed: band isWorking=false, turn running=false, context=30%\n.*declined\n$/)
  await ui.unmount()
})
