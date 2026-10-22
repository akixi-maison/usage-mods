import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { BackgroundTask, Schedule, Work } from '../types'
import {
  appendLine,
  ASK_FRESH_MS,
  backgroundNote,
  backgroundParts,
  backgroundRow,
  bar,
  BAR_PX,
  barSvg,
  canCompact,
  costText,
  deletedScheduleId,
  describePrompt,
  describeTool,
  elapsed,
  endedTaskIds,
  fireSchedule,
  hasCompacted,
  hoverParts,
  hoverText,
  isBusyAgent,
  isHeadlessRefusal,
  LOG_FILE,
  meterColor,
  meters,
  OFF_HINT,
  promptWords,
  QUEUE_TIMEOUT,
  reconcileSchedules,
  reconcileTasks,
  runningFor,
  scheduleFromCall,
  scheduleRow,
  shouldSendCompact,
  SNAPSHOT_GRACE_MS,
  statusRows,
  stoppedTaskId,
  stopsWakeups,
  taskFromCall,
  timeTo,
  triggerOf,
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
    // A subscription (the 7-day limit) is not billed by the cost, so it is left out.
    expect(await ui.find({ type: 'Text', text: /\$0\.50/ })).toBeUndefined()
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

// Three days of minute ticks run one by one on the mocked clock: more than the default 5 s.
test('draws the countdown beside the 7-day bar, with no cost on a subscription, and moves it every minute', { timeoutMs: 60_000 }, async ($, on) => {
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
    expect(drawn).not.toContain('0.50')
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

test('the cost shows only where no subscription limit bounds the use', async () => {
  expect(costText({ usd: 0.5, limits: [] })).toBe('$0.50')
  expect(costText({ usd: 0.5, limits: [{ kind: 'spend_limit', percentUsed: 10 }] })).toBe('$0.50')
  expect(costText({ usd: 0.5, limits: [{ kind: 'five_hour', percentUsed: 10 }] })).toBeNull()
  expect(costText({ usd: 0.5, limits: [{ kind: 'seven_day', percentUsed: 10 }] })).toBeNull()
  expect(costText({ limits: [] })).toBeNull()
})

test('draws the cost for an API key and leaves it out on a subscription', async ($, on) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const context = { window: 200000, tokens: 60000, percent: 30 }
  await $.session.measure({ context, rateLimits: [], cost: { usd: 0.5 }, changed: ['context', 'rateLimits', 'cost'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: '$0.50' })).toBeDefined()
    await ui.unmount()
  }
  await $.session.measure({
    context,
    rateLimits: [{ kind: 'five_hour', percentUsed: 20 }],
    cost: { usd: 0.5 },
    changed: ['rateLimits'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: '$0.50' })).toBeUndefined()
    await ui.unmount()
  }
})

// --- Work status --------------------------------------------------------------------------------

test('a tool call in plain words: what it does and what it works on', async () => {
  expect(describeTool('Bash', { command: 'npm test', description: 'Run tests' })).toEqual({ label: '명령 실행', detail: 'Run tests', needsMe: false })
  expect(describeTool('Bash', { command: 'npm   test\n--watch' }).detail).toBe('npm test --watch')
  expect(describeTool('Edit', { file_path: 'C:\\work\\src\\app.tsx' }).detail).toBe('app.tsx')
  expect(describeTool('WebFetch', { url: 'https://example.com/a/b' }).detail).toBe('example.com')
  expect(describeTool('AskUserQuestion', {})).toEqual({ label: '질문에 답해 주세요', detail: '', needsMe: true })
  expect(describeTool('mcp__ccd_turn__update_plan', {}).label).toBe('도구 사용: update_plan')
  expect(describeTool('Mystery', null).label).toBe('도구 사용: Mystery')
})

test('elapsed time in seconds, then minutes, then hours', async () => {
  expect(elapsed(0)).toBe('0초')
  expect(elapsed(45_400)).toBe('45초')
  expect(elapsed(60_000)).toBe('1분')
  expect(elapsed(83_000)).toBe('1분 23초')
  expect(elapsed(3_720_000)).toBe('1시간 2분')
  expect(elapsed(-5)).toBe('0초')
})

const T0 = 1_000_000
const WORKING: Work = { phase: 'working', startedAt: T0, durationMs: 0, tools: 0, running: [], stopReason: '' }
const STATUS = { work: WORKING, isWorking: true, now: T0, beat: true, helpers: 0, helperAsks: [], isViewingHelper: false }
const call = (over: Partial<Work['running'][number]> = {}) => ({
  id: 'c1', tool: 'Bash', label: '명령 실행', detail: 'Run tests', needsMe: false, startedAt: T0, askedAt: null, ...over,
})
const texts = (rows: { text: string }[]) => rows.map(r => r.text)

test('the status rows while the main turn works', async () => {
  expect(statusRows({ ...STATUS, work: { ...WORKING, phase: 'idle' }, isWorking: false })).toEqual([])
  expect(texts(statusRows({ ...STATUS, now: T0 + 83_000 }))).toEqual(['● 작업 중 · 1분 23초', '생각하거나 답을 쓰는 중…'])
  const busy = { ...WORKING, tools: 7, running: [call({ startedAt: T0 + 68_000 }), call({ id: 'c2' })] }
  const rows = statusRows({ ...STATUS, work: busy, now: T0 + 83_000, beat: false, helpers: 2 })
  expect(texts(rows)).toEqual(['○ 작업 중 · 1분 23초 · 도구 7회 · 도우미 2명 일하는 중', '지금 (15초째): 명령 실행 — Run tests 외 1개'])
  expect(rows.map(r => r.tone)).toEqual(['claude', 'dim'])
  // Loaded mid-turn: the engine says it works, the mod knows nothing more.
  expect(texts(statusRows({ ...STATUS, work: { ...WORKING, phase: 'idle' } }))).toEqual(['작업 중…'])
  expect(texts(statusRows({ ...STATUS, isViewingHelper: true }))[0]).toBe('메인 대화 · ● 작업 중 · 0초')
})

test('waiting on the person turns the rows yellow and stops the dot', async () => {
  const asking = { ...WORKING, running: [call({ id: 'q', tool: 'AskUserQuestion', label: '질문에 답해 주세요', detail: '', needsMe: true })] }
  const rows = statusRows({ ...STATUS, work: asking, now: T0 + 5_000 })
  expect(texts(rows)).toEqual(['! 나를 기다리는 중 · 5초째', '질문에 답해 주세요'])
  expect(rows.map(r => r.tone)).toEqual(['warning', 'warning'])
  // The time is how long it has waited, not how long the turn has run.
  const late = { ...WORKING, running: [call({ id: 'q', tool: 'AskUserQuestion', label: '질문에 답해 주세요', detail: '', needsMe: true, startedAt: T0 + 180_000 })] }
  expect(texts(statusRows({ ...STATUS, work: late, now: T0 + 182_000 }))[0]).toBe('! 나를 기다리는 중 · 2초째')

  const asked = { ...WORKING, running: [call({ askedAt: T0 + 5_000 })] }
  expect(texts(statusRows({ ...STATUS, work: asked, now: T0 + 5_000 }))).toEqual(['! 승인 요청이 떴어요 · 방금', '명령 실행 — Run tests · 승인했다면 실행 중이에요'])
  expect(texts(statusRows({ ...STATUS, work: asked, now: T0 + 15_000 }))[0]).toBe('! 승인 요청이 떴어요 · 10초 전')
  // Past the window the call may well be running: a dim note, ahead of the words a narrow band cuts.
  const stale = statusRows({ ...STATUS, work: asked, now: T0 + 5_000 + ASK_FRESH_MS })
  expect(texts(stale)).toEqual(['● 작업 중 · 35초', '지금 (35초째, 승인 요청이 떴었어요): 명령 실행 — Run tests'])

  const helperAsk = { agentId: 'a1', tool: 'Bash', label: '명령 실행', detail: 'npm install', at: T0 }
  expect(texts(statusRows({ ...STATUS, helperAsks: [helperAsk], now: T0 + 1_000 }))).toEqual(['! 도우미가 승인 요청을 띄웠어요 · 1초 전', '명령 실행 — npm install · 승인했다면 실행 중이에요'])
  // Once it is stale and the main turn has ended, the helpers' row keeps a note of it.
  const ended = { ...WORKING, phase: 'done' as const, durationMs: 5_000 }
  expect(texts(statusRows({ ...STATUS, isWorking: false, work: ended, helpers: 1, helperAsks: [helperAsk], now: T0 + ASK_FRESH_MS })))
    .toEqual(['✓ 끝났어요 · 5초 걸림 · 다음 지시를 기다려요', '● 백그라운드 도우미 1명은 아직 일하는 중 · 승인 요청이 떴었어요'])
})

test('the status rows once the turn has ended', async () => {
  const ended = (over: Partial<Work>) => texts(statusRows({ ...STATUS, isWorking: false, work: { ...WORKING, durationMs: 125_000, tools: 12, ...over } }))
  expect(ended({ phase: 'done' })).toEqual(['✓ 끝났어요 · 2분 5초 걸림 · 도구 12회 · 다음 지시를 기다려요'])
  expect(ended({ phase: 'aborted', durationMs: 63_000, tools: 0 })).toEqual(['■ 중단했어요 · 1분 3초 동안 작업함'])
  expect(ended({ phase: 'error', stopReason: 'error' })).toEqual(['✕ 오류로 멈췄어요 · 대화에 뜬 안내를 확인해 주세요'])
  expect(ended({ phase: 'error', stopReason: 'refusal' })).toEqual(['✕ 요청을 거절했어요 · 다르게 말해 보세요'])
  expect(texts(statusRows({ ...STATUS, isWorking: false, beat: false, helpers: 2, work: { ...WORKING, phase: 'done', durationMs: 5_000 } })))
    .toEqual(['✓ 끝났어요 · 5초 걸림 · 다음 지시를 기다려요', '○ 백그라운드 도우미 2명은 아직 일하는 중'])
})

// --- Background work ------------------------------------------------------------------------------

const MIN = 60_000
const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 'b1', kind: 'shell', label: '명령 실행', detail: 'Run dev server', startedAt: T0, endsBy: 0, seenAt: T0, ...over,
})

test('the background tools in plain words', async () => {
  expect(describeTool('Bash', { command: 'npm run dev', description: 'Run dev server', run_in_background: true }).label).toBe('백그라운드로 명령 실행')
  expect(describeTool('Bash', { command: 'npm test', run_in_background: false }).label).toBe('명령 실행')
  expect(describeTool('Monitor', { description: 'Watch CI until green', timeout_ms: 300_000 })).toEqual({ label: '지켜보기 시작', detail: 'Watch CI until green', needsMe: false })
  expect(describeTool('TaskStop', { task_id: 'b1' })).toEqual({ label: '백그라운드 작업 멈추기', detail: 'b1', needsMe: false })
  expect(describeTool('TaskStop', { shell_id: 'b2' }).detail).toBe('b2')
})

test('a settled call\'s record tells which background task it started', async () => {
  const bash = { command: 'npm run dev', description: 'Run dev server' }
  expect(taskFromCall('Bash', bash, { stdout: '', backgroundTaskId: 'b1' }, T0, T0 + 10)).toEqual(task({ seenAt: T0 + 10 }))
  // Ctrl+B and a timeout move it with the same id; the time runs from the call's start.
  expect(taskFromCall('Bash', bash, { backgroundTaskId: 'b2', backgroundedByUser: true }, T0, T0 + 20 * MIN)?.startedAt).toBe(T0)
  expect(taskFromCall('PowerShell', bash, { backgroundTaskId: 'p1' }, T0, T0)?.kind).toBe('shell')
  expect(taskFromCall('Bash', bash, { stdout: 'ok' }, T0, T0)).toBeNull()
  // One that ends with its caller's final response is never left running.
  expect(taskFromCall('Bash', bash, { backgroundTaskId: 'b3', backgroundEndsWithFinalResponse: true }, T0, T0)).toBeNull()

  const monitor = { description: 'Watch CI', timeout_ms: 300_000 }
  expect(taskFromCall('Monitor', monitor, { taskId: 'm1', timeoutMs: 300_000 }, T0, T0)).toEqual(
    task({ id: 'm1', kind: 'monitor', label: '지켜보기', detail: 'Watch CI', endsBy: T0 + 300_000 }))
  expect(taskFromCall('Monitor', monitor, { taskId: 'm2', timeoutMs: 0, persistent: true }, T0, T0)?.endsBy).toBe(0)

  expect(taskFromCall('Workflow', {}, { status: 'async_launched', taskId: 'w1', taskType: 'local_workflow', workflowName: 'code-review' }, T0, T0))
    .toEqual(task({ id: 'w1', kind: 'workflow', label: '워크플로', detail: 'code-review' }))
  expect(taskFromCall('Workflow', {}, { status: 'remote_launched', taskId: 'w2' }, T0, T0)?.label).toBe('원격 워크플로')
  expect(taskFromCall('Read', { file_path: 'a' }, { taskId: 'x' }, T0, T0)).toBeNull()
  expect(stoppedTaskId('TaskStop', { message: 'stopped', task_id: 'b1', task_type: 'local_bash' })).toBe('b1')
  expect(stoppedTaskId('Bash', { task_id: 'b1' })).toBeNull()
})

test('a notification ends the tasks whose status says so', async () => {
  const note = (id: string, status: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>…</summary>\n</task-notification>`
  expect(endedTaskIds(note('b1', 'completed'))).toEqual(['b1'])
  expect(endedTaskIds(`${note('b1', 'failed')}\n${note('b2', 'killed')}`)).toEqual(['b1', 'b2'])
  expect(endedTaskIds(note('m1', 'running'))).toEqual([])
  expect(endedTaskIds('<task-notification><task-id>m1</task-id><event>line</event></task-notification>')).toEqual([])
  expect(endedTaskIds('the build finished')).toEqual([])
})

test('a stop\'s snapshot drops what ended unannounced and adds what the band did not see start', async () => {
  const at = T0 + 10 * MIN
  const tracked = [task(), task({ id: 'b2' }), task({ id: 'b3', seenAt: at - 500 })]
  const snapshot = [
    { id: 'b1', type: 'shell', status: 'running', description: 'Run dev server' },
    { id: 'b9', type: 'shell', status: 'running', description: '', command: 'npm run watch' },
    { id: 'm9', type: 'monitor', status: 'running', description: 'Watch deploy ... [+40 chars]' },
    { id: 'w9', type: 'workflow', status: 'running', description: 'Review', name: 'code-review' },
    { id: 'a9', type: 'subagent', status: 'running', description: 'helper', agent_type: 'general-purpose' },
  ]
  const after = reconcileTasks(tracked, snapshot, at)
  // b2 is gone; b3 was recorded too recently for the snapshot to list it.
  expect(after.map(t => t.id)).toEqual(['b1', 'b3', 'b9', 'm9', 'w9'])
  expect(after.find(t => t.id === 'b9')).toEqual({ id: 'b9', kind: 'shell', label: '명령 실행', detail: 'npm run watch', startedAt: 0, endsBy: 0, seenAt: at })
  expect(after.find(t => t.id === 'm9')?.detail).toBe('Watch deploy')
  expect(after.find(t => t.id === 'w9')?.detail).toBe('code-review')
  expect(reconcileTasks(tracked, [], at + SNAPSHOT_GRACE_MS).map(t => t.id)).toEqual([])
  // A command-run monitor comes as a 'shell': the kind the mod saw it start with says what it is.
  const watched = reconcileTasks([], [{ id: 'm5', type: 'shell', status: 'running', description: 'Watch the log', command: 'tail -f app.log' }], at, new Map([['m5', 'monitor' as const]]))
  expect(watched).toEqual([{ id: 'm5', kind: 'monitor', label: '지켜보기', detail: 'Watch the log', startedAt: 0, endsBy: 0, seenAt: at }])
  expect(reconcileTasks([], [{ id: 'a9', type: 'subagent', status: 'running', description: '' }], at, new Map([['a9', 'monitor' as const]]))).toEqual([])
})

test('the background rows: one task with its time, several by kind, helpers keeping their dot', async () => {
  expect(runningFor(59_000)).toBe('')
  expect(runningFor(12 * MIN + 30_000)).toBe('12분째')
  expect(runningFor(62 * MIN)).toBe('1시간 2분째')
  expect(backgroundParts(2, [task(), task({ id: 'm1', kind: 'monitor' }), task({ id: 'b2' })])).toEqual(['도우미 2명', '명령 2개', '모니터 1개'])

  const now = T0 + 12 * MIN
  expect(backgroundRow(0, false, [task()], now, '●')).toEqual({ text: '◌ 백그라운드 (12분째): 명령 실행 — Run dev server', tone: 'dim', bold: false })
  expect(backgroundRow(0, false, [task({ startedAt: 0 })], now, '●')?.text).toBe('◌ 백그라운드: 명령 실행 — Run dev server')
  expect(backgroundRow(0, false, [task({ startedAt: now - 30_000 })], now, '●')?.text).toBe('◌ 백그라운드: 명령 실행 — Run dev server')
  const monitor = task({ id: 'm1', kind: 'monitor', label: '지켜보기', detail: 'Watch CI', endsBy: now - 1 })
  expect(backgroundRow(0, false, [monitor], now, '●')?.text).toBe('◌ 백그라운드 (곧 끝나요): 지켜보기 — Watch CI')
  expect(backgroundRow(0, false, [task(), monitor], now, '●')?.text).toBe('◌ 백그라운드에서 아직 일하는 중 · 명령 1개 · 모니터 1개')
  expect(backgroundRow(2, true, [task()], now, '○')).toEqual({ text: '○ 백그라운드에서 아직 일하는 중 · 도우미 2명 · 명령 1개 · 승인 요청이 떴었어요', tone: 'claude', bold: false })
  // Helpers alone keep the words they had.
  expect(backgroundRow(2, false, [], now, '○')?.text).toBe('○ 백그라운드 도우미 2명은 아직 일하는 중')
  expect(backgroundRow(0, false, [], now, '●')).toBeNull()
  expect(backgroundNote([task(), task({ id: 'b2' }), monitor], [], now)?.text).toBe('◌ 백그라운드: 명령 2개 · 모니터 1개')
  expect(backgroundNote([], [], now)).toBeNull()
})

test('the status rows with background work: a dim third row while working, below the end after', async () => {
  const now = T0 + 3 * MIN
  const working = texts(statusRows({ ...STATUS, now, tasks: [task()] }))
  expect(working).toEqual(['● 작업 중 · 3분', '생각하거나 답을 쓰는 중…', '◌ 백그라운드 (3분째): 명령 실행 — Run dev server'])
  expect(statusRows({ ...STATUS, now, tasks: [task()] })[2]?.tone).toBe('dim')
  // Waiting on the person keeps to its two rows.
  const asking = { ...WORKING, running: [call({ id: 'q', tool: 'AskUserQuestion', label: '질문에 답해 주세요', detail: '', needsMe: true })] }
  expect(statusRows({ ...STATUS, work: asking, now, tasks: [task()] })).toHaveLength(2)

  const ended = { ...WORKING, phase: 'done' as const, durationMs: 5_000 }
  expect(texts(statusRows({ ...STATUS, isWorking: false, work: ended, now, tasks: [task()] })))
    .toEqual(['✓ 끝났어요 · 5초 걸림 · 다음 지시를 기다려요', '◌ 백그라운드 (3분째): 명령 실행 — Run dev server'])
  expect(texts(statusRows({ ...STATUS, isWorking: false, work: ended, now, helpers: 1, tasks: [task(), task({ id: 'b2' })] })))
    .toEqual(['✓ 끝났어요 · 5초 걸림 · 다음 지시를 기다려요', '● 백그라운드에서 아직 일하는 중 · 도우미 1명 · 명령 2개'])
  // A helper's fresh ask takes the second row; the background goes dim below it.
  const helperAsk = { agentId: 'a1', tool: 'Bash', label: '명령 실행', detail: 'npm install', at: now }
  expect(texts(statusRows({ ...STATUS, isWorking: false, work: ended, now, helpers: 1, helperAsks: [helperAsk], tasks: [task()] })))
    .toEqual(['✓ 끝났어요 · 5초 걸림 · 다음 지시를 기다려요', '! 도우미가 승인 요청을 띄웠어요 · 방금 · 명령 실행 — npm install', '◌ 백그라운드 (3분째): 명령 실행 — Run dev server'])
  // Before any turn, after a /clear: the background row alone.
  expect(texts(statusRows({ ...STATUS, isWorking: false, work: { ...WORKING, phase: 'idle' }, now, tasks: [task({ startedAt: 0 })] })))
    .toEqual(['◌ 백그라운드: 명령 실행 — Run dev server'])
})

// --- Schedules -----------------------------------------------------------------------------------

const plan = (over: Partial<Schedule> = {}): Schedule => ({
  id: 'c1', kind: 'cron', recurring: false, nextAt: T0 + 4 * MIN, detail: 'check the deploy', prompt: 'check the deploy', seenAt: T0, ...over,
})

test('the schedule tools in plain words', async () => {
  expect(describeTool('CronCreate', { cron: '*/5 * * * *', prompt: 'check the deploy' })).toEqual({ label: '예약 만들기', detail: 'check the deploy', needsMe: false })
  expect(describeTool('CronDelete', { id: 'c1' }).label).toBe('예약 지우기')
  expect(describeTool('ScheduleWakeup', { delaySeconds: 240, reason: 'watching the build', prompt: '/loop check' })).toEqual({ label: '다음 실행 예약', detail: 'watching the build', needsMe: false })
  expect(describeTool('ScheduleWakeup', { stop: true }).label).toBe('반복 멈추기')
})

test('a settled call\'s record tells which schedule it stored, deleted or ended', async () => {
  expect(scheduleFromCall('CronCreate', { cron: '*/5 * * * *', prompt: 'check the deploy' }, { id: 'c1', humanSchedule: 'every 5 minutes', recurring: true, nextFireAt: T0 + 4 * MIN }, T0))
    .toEqual(plan({ recurring: true }))
  expect(scheduleFromCall('CronCreate', { cron: '0 9 * * *', prompt: 'p' }, { id: 'c2', humanSchedule: '', recurring: false }, T0)?.nextAt).toBe(0)
  expect(scheduleFromCall('ScheduleWakeup', { delaySeconds: 240, reason: 'watching the build', prompt: '<<autonomous-loop-dynamic>>' }, { scheduledFor: T0 + 4 * MIN, clampedDelaySeconds: 240, wasClamped: false }, T0))
    .toEqual({ id: `wakeup@${T0 + 4 * MIN}`, kind: 'wakeup', recurring: false, nextAt: T0 + 4 * MIN, detail: 'watching the build', prompt: '<<autonomous-loop-dynamic>>', seenAt: T0 })
  expect(scheduleFromCall('ScheduleWakeup', { prompt: '<<autonomous-loop-dynamic>>' }, { scheduledFor: T0 + MIN }, T0)?.detail).toBe('/loop')
  expect(scheduleFromCall('ScheduleWakeup', { stop: true }, { scheduledFor: 0, stopped: true, cancelledWakeups: 1 }, T0)).toBeNull()
  expect(scheduleFromCall('Bash', {}, { id: 'x' }, T0)).toBeNull()
  expect(deletedScheduleId('CronDelete', { id: 'c1' })).toBe('c1')
  expect(deletedScheduleId('CronCreate', { id: 'c1' })).toBeNull()
  expect(stopsWakeups('ScheduleWakeup', { stopped: true })).toBe(true)
  expect(stopsWakeups('ScheduleWakeup', { scheduledFor: T0 })).toBe(false)
  expect(promptWords('<<autonomous-loop>>')).toBe('/loop')
  expect(promptWords('<<loop.md>>')).toBe('/loop')
  expect(describeTool('CronCreate', { cron: '*/10 * * * *', prompt: '<<autonomous-loop>>' }).detail).toBe('/loop')
  expect(describeTool('ScheduleWakeup', { delaySeconds: 60, prompt: '<<autonomous-loop-dynamic>>' }).detail).toBe('/loop')
  expect(promptWords('  /loop 5m   check ... [+20 chars]')).toBe('/loop 5m check')
})

test('a fired prompt ends its one-shot schedule and leaves a recurring one with no known next run', async () => {
  const list = [plan(), plan({ id: 'c2', recurring: true, prompt: 'every hour', detail: 'every hour', nextAt: T0 + 60 * MIN })]
  expect(fireSchedule(list, 'check the deploy', T0 + 4 * MIN).map(one => one.id)).toEqual(['c2'])
  expect(fireSchedule(list, 'every hour', T0 + 60 * MIN)).toEqual([list[0], { ...list[1], nextAt: 0 }])
  // A prompt that came changed: the one-shot due within the minute is the one that fired.
  expect(fireSchedule(list, 'something else', T0 + 4 * MIN - 30_000).map(one => one.id)).toEqual(['c2'])
  // Nothing due and nothing matching: nothing goes; a recurring one is never taken by time alone.
  expect(fireSchedule(list, 'something else', T0)).toEqual(list)
  expect(fireSchedule([list[1]!], 'something else', T0 + 60 * MIN)).toEqual([list[1]])
  // A /loop's job stores a sentinel and fires as the loop's own text: the one due within the minute ran.
  const loop = plan({ id: 'l1', recurring: true, prompt: '<<autonomous-loop>>', detail: '/loop', nextAt: T0 + 30_000 })
  expect(fireSchedule([loop], 'check the build and report', T0)).toEqual([{ ...loop, nextAt: 0 }])
})

test('a stop\'s snapshot keeps the listed schedules, names a wakeup, and drops or adds the rest', async () => {
  const at = T0 + 10 * MIN
  const wakeup = plan({ id: `wakeup@${T0 + 14 * MIN}`, kind: 'wakeup', prompt: '<<autonomous-loop-dynamic>>', detail: 'watching the build', nextAt: T0 + 14 * MIN })
  const tracked = [plan(), wakeup, plan({ id: 'gone' }), plan({ id: 'fresh', seenAt: at - 500 })]
  const after = reconcileSchedules(tracked, [
    { id: 'c1', schedule: '4 * * * *', recurring: true, prompt: 'check the deploy' },
    { id: 'w7', schedule: '14 10 21 10 *', recurring: false, prompt: '<<autonomous-loop-dynamic>>' },
    { id: 'c9', schedule: '0 * * * *', recurring: true, prompt: 'hourly report ... [+500 chars]' },
  ], at)
  expect(after.map(one => one.id)).toEqual(['c1', 'w7', 'fresh', 'c9'])
  expect(after[0]?.recurring).toBe(true)
  // The wakeup keeps its time and words under the job's id.
  expect(after[1]).toEqual({ ...wakeup, id: 'w7' })
  expect(after[3]).toEqual({ id: 'c9', kind: 'cron', recurring: true, nextAt: 0, detail: 'hourly report', prompt: 'hourly report', seenAt: at })
  // A recurring job whose run the band missed loses its past time; a one-shot still due keeps it.
  const missed = reconcileSchedules([plan({ recurring: true, nextAt: at - MIN }), plan({ id: 'c2', nextAt: at - MIN })], [
    { id: 'c1', schedule: '* * * * *', recurring: true, prompt: 'check the deploy' },
    { id: 'c2', schedule: '1 2 3 4 *', recurring: false, prompt: 'check the deploy' },
  ], at)
  expect(missed.map(one => one.nextAt)).toEqual([0, at - MIN])
})

test('the schedule rows: one with its time and words, several with the next run', async () => {
  expect(timeTo(0, T0)).toBe('')
  expect(timeTo(T0 + 4 * MIN, T0)).toBe('4분 후')
  expect(timeTo(T0 + 62 * MIN, T0)).toBe('1시간 2분 후')
  expect(timeTo(T0 + 30_000, T0)).toBe('곧')
  expect(timeTo(T0 - MIN, T0)).toBe('곧')
  expect(scheduleRow([plan()], T0)).toEqual({ text: '◷ 4분 후 실행 · check the deploy', tone: 'dim', bold: false })
  expect(scheduleRow([plan({ nextAt: T0 + 20_000 })], T0)?.text).toBe('◷ 곧 실행 · check the deploy')
  expect(scheduleRow([plan({ nextAt: 0, recurring: true })], T0)?.text).toBe('◷ 반복 예약 · check the deploy')
  expect(scheduleRow([plan({ nextAt: 0 })], T0)?.text).toBe('◷ 예약 · check the deploy')
  expect(scheduleRow([plan(), plan({ id: 'c2', nextAt: T0 + 40_000 }), plan({ id: 'c3', nextAt: 0 })], T0)?.text).toBe('◷ 예약 3개 · 다음은 곧 실행')
  expect(scheduleRow([plan(), plan({ id: 'c2', nextAt: T0 + 9 * MIN })], T0)?.text).toBe('◷ 예약 2개 · 다음은 4분 후')
  expect(scheduleRow([plan({ nextAt: 0 }), plan({ id: 'c2', nextAt: 0 })], T0)?.text).toBe('◷ 예약 2개')
  expect(scheduleRow([], T0)).toBeNull()
  // A recurring one long past its time ran unseen: no time; a one-shot past its time is about to run.
  expect(scheduleRow([plan({ recurring: true, nextAt: T0 - 2 * MIN })], T0)?.text).toBe('◷ 반복 예약 · check the deploy')
  expect(scheduleRow([plan({ nextAt: T0 - 2 * MIN })], T0)?.text).toBe('◷ 곧 실행 · check the deploy')
  // Beside a turn at work, schedules join the background row, or stand alone.
  expect(backgroundNote([task()], [plan()], T0)?.text).toBe('◌ 백그라운드: 명령 1개 · 예약 1개 (4분 후)')
  expect(backgroundNote([], [plan()], T0)?.text).toBe('◷ 4분 후 실행 · check the deploy')
})

test('the status rows with schedules: in the dim row while working, a row of their own after', async () => {
  expect(texts(statusRows({ ...STATUS, now: T0, schedules: [plan()] })))
    .toEqual(['● 작업 중 · 0초', '생각하거나 답을 쓰는 중…', '◷ 4분 후 실행 · check the deploy'])
  const ended = { ...WORKING, phase: 'done' as const, durationMs: 42_000, tools: 1 }
  expect(texts(statusRows({ ...STATUS, isWorking: false, work: ended, now: T0, tasks: [task({ startedAt: T0 - 3 * MIN })], schedules: [plan({ nextAt: T0 + 60 * MIN })] })))
    .toEqual(['✓ 끝났어요 · 42초 걸림 · 도구 1회 · 다음 지시를 기다려요', '◌ 백그라운드 (3분째): 명령 실행 — Run dev server', '◷ 1시간 0분 후 실행 · check the deploy'])
  expect(texts(statusRows({ ...STATUS, isWorking: false, work: { ...WORKING, phase: 'idle' }, now: T0, schedules: [plan()] })))
    .toEqual(['◷ 4분 후 실행 · check the deploy'])
})

test('a teammate in a pane of its own is not counted as at work', async () => {
  expect(isBusyAgent({ id: 'a1', status: 'running' })).toBe(true)
  expect(isBusyAgent({ id: 'a1', status: 'waiting' })).toBe(true)
  expect(isBusyAgent({ id: 'a1', status: 'completed' })).toBe(false)
  expect(isBusyAgent({ id: 'bob@team', teammateId: 'bob@team', status: 'running' })).toBe(false)
})

// The engine's side of a turn: the clock, the agents, the notification channel, and tool calls
// that run until the test finishes them.
type WorldOptions = {
  now?: number
  /** What the tasks list says, asked afresh each time. */
  agents?: () => AgentInfo[]
  /** A tool's record for a call, answered at once; absent, calls run until the test finishes them. */
  answer?: (e: { tool: string } & Record<string, unknown>) => unknown
  /** What lies beneath a submitted prompt; absent, it enters as it came. */
  submit?: (e: { text: string }) => unknown
}
const workWorld = (on: TestArgs[1], { now = T0, agents = () => [], answer, submit }: WorldOptions = {}) => {
  const clock = mock.clock(on, { now })
  const toasts: string[] = []
  const finishers: Array<() => void> = []
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: agents() }))
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('classic.PermissionRequest', () => ({}))
  on('classic.Stop', () => ({}))
  on('prompt.submit', ($, e) => (submit === undefined ? { text: e.text } : (submit(e) as never)))
  on('tool.call', ($, e) =>
    answer !== undefined
      ? ({ result: answer(e as never) } as never)
      : new Promise(resolve => finishers.push(() => resolve({ result: {} }))))
  return { clock, toasts, finish: () => finishers.shift()?.() }
}

const NOTIFY = (id: string, status: string) => ({
  text: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>`,
  origin: { kind: 'task-notification' as const },
  wait: false,
})
const drawnText = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

type Drawn = { findAll: (query: { type: string }) => Promise<{ text?: string }[]> }
const statusTexts = async (ui: Drawn) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').filter(t => /작업 중|기다리|끝났어요|지금|승인|생각하거나/.test(t))

test('the band puts the work status above the meters, on the terminal and the desktop', async ($, on) => {
  const world = workWorld(on)
  await $.session.measure(MEASURE)

  // Before the first turn the band is the meters alone.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ key: 'status' })).toBeUndefined()
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  const bash = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests' })
  await world.clock.advance(5_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
    const rows = await statusTexts(ui)
    expect(rows[0]).toMatch(/^[●○] 작업 중 · 5초 · 도구 1회$/)
    expect(rows[1]).toBe('지금 (5초째): 명령 실행 — Run tests')
    expect(await ui.find({ key: 'status' })).toBeDefined()
    expect(await ui.find({ key: 'usage' })).toBeDefined()
    expect(await ui.find({ key: 'compact-off' })).toBeDefined()
    await ui.unmount()
  }

  // The dot changes every second.
  const dots: string[] = []
  for (let i = 0; i < 2; i += 1) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
    dots.push((await statusTexts(ui))[0]!.slice(0, 1))
    await ui.unmount()
    await world.clock.advance(1_000)
  }
  expect(new Set(dots).size).toBe(2)

  // A permission prompt for it.
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
    expect(await statusTexts(ui)).toEqual(['! 승인 요청이 떴어요 · 방금', '명령 실행 — Run tests · 승인했다면 실행 중이에요'])
    await ui.unmount()
  }
  await world.clock.advance(ASK_FRESH_MS)
  const later = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
  expect((await statusTexts(later))[1]).toBe('지금 (37초째, 승인 요청이 떴었어요): 명령 실행 — Run tests')
  await later.unmount()

  world.finish()
  await bash
  await $.turn.complete({ answer: 'done', durationMs: 42_000, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await statusTexts(ui)).toEqual(['✓ 끝났어요 · 42초 걸림 · 도구 1회 · 다음 지시를 기다려요'])
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    await ui.unmount()
  }

  // A turn of 30 s or more is announced a moment later; with no channel here, as a toast.
  expect(world.toasts).toEqual([])
  await world.clock.advance(2_000)
  expect(world.toasts).toEqual(['작업이 끝났어요 (42초 걸림)'])
})

test('a short turn is not announced, nor one followed right away by another', async ($, on) => {
  const world = workWorld(on)
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'b', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 60_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await $.turn.start({ text: 'c', turnId: 't3' })
  await world.clock.advance(3_000)
  expect(world.toasts).toEqual([])
})

test('a helper asking for permission shows, and the ask goes when the helper stops', async ($, on) => {
  const world = workWorld(on)
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'go', turnId: 'main' })
  await $.turn.start({ text: 'sub', turnId: 'sub', agentId: 'agent-1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm install' }, agent_id: 'agent-1' })
  await world.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
  expect(await statusTexts(ui)).toEqual(['! 도우미가 승인 요청을 띄웠어요 · 1초 전', '명령 실행 — npm install · 승인했다면 실행 중이에요'])
  await ui.unmount()

  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 'sub', agentId: 'agent-1', reason: 'answer' })
  const after = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
  expect((await statusTexts(after))[0]).toMatch(/^[●○] 작업 중 · 1초$/)
  await after.unmount()
})

test('a helper\'s settled call lets go of its own ask only, not another call\'s of the same tool', async ($, on) => {
  const world = workWorld(on)
  on('classic.PostToolUse', () => ({}))
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'go', turnId: 'main' })
  await $.turn.start({ text: 'sub', turnId: 'sub', agentId: 'agent-1' })
  await $.classic.PermissionRequest({ tool_name: 'Grep', tool_input: { pattern: 'outside' }, agent_id: 'agent-1' })
  await $.classic.PostToolUse({ tool_name: 'Grep', tool_input: { pattern: 'inside' }, tool_response: {}, tool_use_id: 'g1', agent_id: 'agent-1' })
  await world.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
  expect((await statusTexts(ui))[1]).toBe('내용 찾기 — outside · 승인했다면 실행 중이에요')
  await ui.unmount()

  await $.classic.PostToolUse({ tool_name: 'Grep', tool_input: { pattern: 'outside' }, tool_response: {}, tool_use_id: 'g2', agent_id: 'agent-1' })
  const after = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
  expect((await statusTexts(after))[0]).toMatch(/^[●○] 작업 중/)
  await after.unmount()
})

test('a helper whose turn ended but still waits on its own background work stays in the band', async ($, on) => {
  let status: AgentInfo['status'] = 'waiting'
  const world = workWorld(on, { agents: () => [{ id: 'agent-1', description: 'watch the build', type: 'general-purpose', status }] })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'go', turnId: 'main' })
  await $.turn.start({ text: 'sub', turnId: 'sub', agentId: 'agent-1' })
  await $.turn.complete({ answer: 'done', durationMs: 5_000, isAborted: false, turnId: 'main', reason: 'answer' })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 'sub', agentId: 'agent-1', reason: 'answer' })
  await world.clock.advance(5_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(JSON.stringify(await ui.drawn())).toMatch(/[●○] 백그라운드 도우미 1명은 아직 일하는 중/)
    await ui.unmount()
  }

  // Once the list says it is done, the next tick lets go of it.
  status = 'completed'
  await world.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(JSON.stringify(await ui.drawn())).not.toContain('백그라운드 도우미')
  await ui.unmount()
})

test('a helper\'s turn leaves the compact button as the main loop left it', async ($, on) => {
  workWorld(on)
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'background work', turnId: 'sub', agentId: 'agent-1' })
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  expect((await statusTexts(ui)).length).toBe(0)
  await ui.unmount()
})

// A session as the band lives in it: the minute clock running, the usage known.
const startSession = async ($: TestArgs[0], on: TestArgs[1]) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: T0, context: MEASURE.context, rateLimits: MEASURE.rateLimits } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure(MEASURE)
}

const bashRecord = (id: string) => ({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: id })

test('a command left in the background shows past the turn\'s end, and its notification ends it', async ($, on) => {
  const world = workWorld(on, { answer: e => (e.tool === 'Bash' ? bashRecord('b1') : {}) })
  await startSession($, on)
  await $.turn.start({ text: 'start the server', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Run dev server', run_in_background: true })
  const working = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
  expect(await statusTexts(working)).toEqual([expect.stringMatching(/^[●○] 작업 중 · 0초 · 도구 1회$/), '생각하거나 답을 쓰는 중…'])
  expect(await drawnText(working)).toContain('◌ 백그라운드: 명령 실행 — Run dev server')
  await working.unmount()

  await $.turn.complete({ answer: 'started', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: PROPS })
    expect(await statusTexts(ui)).toEqual(['✓ 끝났어요 · 5초 걸림 · 도구 1회 · 다음 지시를 기다려요'])
    expect(await drawnText(ui)).toContain('◌ 백그라운드: 명령 실행 — Run dev server')
    await ui.unmount()
  }

  // Between turns the minute clock moves its time on.
  await world.clock.advance(12 * MIN)
  const later = await $.ui.mount({ plugin: 'usage-mods', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await drawnText(later)).toContain('◌ 백그라운드 (12분째): 명령 실행 — Run dev server')
  await later.unmount()

  await $.prompt.submit(NOTIFY('b1', 'completed'))
  const done = await $.ui.mount({ plugin: 'usage-mods', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await drawnText(done)).not.toContain('백그라운드')
  await done.unmount()
})

test('a running background command names itself as one in the now row', async ($, on) => {
  const world = workWorld(on)
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'start', turnId: 't1' })
  const bash = $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Run dev server', run_in_background: true })
  await world.clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
  expect((await statusTexts(ui))[1]).toBe('지금: 백그라운드로 명령 실행 — Run dev server')
  await ui.unmount()
  world.finish()
  await bash
})

test('TaskStop, a stop\'s snapshot and a /clear each let go of background work', async ($, on) => {
  const world = workWorld(on, {
    answer: e =>
      e.tool === 'Bash'
        ? bashRecord(String(e['description']))
        : e.tool === 'TaskStop'
          ? { message: 'stopped', task_id: String(e['task_id']), task_type: 'local_bash' }
          : {},
  })
  on('session.end', () => ({ sessionId: 's1' }))
  await startSession($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'a', description: 'one', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'b', description: 'two', run_in_background: true })
  await $.tool.call({ tool: 'TaskStop', task_id: 'one' })
  await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const shown = async () => {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
    const text = await drawnText(ui)
    await ui.unmount()
    return text
  }
  expect(await shown()).toContain('◌ 백그라운드: 명령 실행 — two')
  expect(await shown()).not.toContain('— one')

  // A snapshot without the field changes nothing, and a helper's stop is not the main loop's.
  await world.clock.advance(SNAPSHOT_GRACE_MS)
  await $.classic.Stop({ stop_hook_active: false })
  await $.classic.Stop({ stop_hook_active: false, agent_id: 'agent-1', background_tasks: [] })
  expect(await shown()).toContain('— two')
  // The main loop's stop lists what is in flight: 'two' ended unannounced, a watcher it never saw start runs.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b9', type: 'shell', status: 'running', description: '', command: 'npm run watch' }] })
  expect(await shown()).toContain('◌ 백그라운드: 명령 실행 — npm run watch')
  expect(await shown()).not.toContain('— two')

  await $.session.end({ reason: 'clear' })
  expect(await shown()).not.toContain('백그라운드')
})

test('a long turn\'s announcement counts the background work still running', async ($, on) => {
  const world = workWorld(on, { answer: e => (e.tool === 'Bash' ? bashRecord('b1') : {}) })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Run dev server', run_in_background: true })
  await $.turn.complete({ answer: '', durationMs: 42_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await world.clock.advance(2_000)
  expect(world.toasts).toEqual(['작업이 끝났어요 (42초 걸림) · 백그라운드에서 아직 일하는 중 (명령 1개)'])
})

test('a helper\'s background command is left to the snapshot, but its TaskStop still counts', async ($, on) => {
  workWorld(on, {
    answer: e =>
      e.tool === 'TaskStop'
        ? { message: 'stopped', task_id: String(e['task_id']), task_type: 'local_bash' }
        : bashRecord(e['agentId'] === undefined ? 'b1' : 'h1'),
  })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const helperBash = { tool: 'Bash', command: 'npm run watch', description: 'Watch', run_in_background: true, agentId: 'agent-1' }
  await $.tool.call(helperBash as never)
  const shown = async () => {
    const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
    const text = await drawnText(ui)
    await ui.unmount()
    return text
  }
  expect(await shown()).not.toContain('◌ 백그라운드')

  // The main loop's command shows; the helper stopping it lets it go.
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Run dev server', run_in_background: true })
  expect(await shown()).toContain('◌ 백그라운드: 명령 실행 — Run dev server')
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1', agentId: 'agent-1' } as never)
  expect(await shown()).not.toContain('◌ 백그라운드')
})

const scheduleRecords = (e: { tool: string } & Record<string, unknown>, now: number) =>
  e.tool === 'CronCreate'
    ? { id: 'c1', humanSchedule: 'every hour', recurring: e['recurring'] !== false, nextFireAt: now + 4 * MIN }
    : e.tool === 'CronDelete'
      ? { id: String(e['id']) }
      : e.tool === 'ScheduleWakeup'
        ? e['stop'] === true
          ? { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 }
          : { scheduledFor: now + 4 * MIN, clampedDelaySeconds: 240, wasClamped: false }
        : {}

const bandText = async ($: TestArgs[0], surface: 'terminal' | 'desktop' = 'desktop', isWorking = false) => {
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: { ...PROPS, isWorking } })
  const text = await drawnText(ui)
  await ui.unmount()
  return text
}

test('a cron job shows with its next run, beside a turn at work and after it, until it is deleted', async ($, on) => {
  workWorld(on, { answer: e => scheduleRecords(e, T0) })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'remind me', turnId: 't1' })
  await $.tool.call({ tool: 'CronCreate', cron: '4 * * * *', prompt: 'check the deploy', recurring: false })
  expect(await bandText($, 'desktop', true)).toContain('◷ 4분 후 실행 · check the deploy')
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandText($, surface)).toContain('◷ 4분 후 실행 · check the deploy')
  }
  await $.tool.call({ tool: 'CronDelete', id: 'c1' })
  expect(await bandText($)).not.toContain('◷')
})

test('a wakeup shows until its prompt fires, and the loop\'s stop ends wakeups but not a recurring job', async ($, on) => {
  workWorld(on, { answer: e => scheduleRecords(e, T0) })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: '/loop', turnId: 't1' })
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 240, reason: 'watching the build', prompt: '<<autonomous-loop-dynamic>>' })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await bandText($)).toContain('◷ 4분 후 실행 · watching the build')

  await $.prompt.submit({ text: '<<autonomous-loop-dynamic>>', origin: { kind: 'scheduled-trigger' }, wait: false })
  expect(await bandText($)).not.toContain('◷')

  await $.tool.call({ tool: 'CronCreate', cron: '0 * * * *', prompt: 'hourly report' })
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 240, reason: 'watching the build', prompt: '<<autonomous-loop-dynamic>>' })
  expect(await bandText($)).toContain('◷ 예약 2개 · 다음은 4분 후')
  await $.tool.call({ tool: 'ScheduleWakeup', stop: true })
  expect(await bandText($)).toContain('◷ 4분 후 실행 · hourly report')
})

test('a stop\'s snapshot names a wakeup by its job and brings back schedules after a /clear', async ($, on) => {
  const world = workWorld(on, { answer: e => scheduleRecords(e, T0) })
  on('session.end', () => ({ sessionId: 's1' }))
  await $.session.measure(MEASURE)
  await $.turn.start({ text: '/loop', turnId: 't1' })
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 240, reason: 'watching the build', prompt: '<<autonomous-loop-dynamic>>' })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await world.clock.advance(SNAPSHOT_GRACE_MS)
  const crons = [{ id: 'w7', schedule: '4 * * * *', recurring: false, prompt: '<<autonomous-loop-dynamic>>' }]
  await $.classic.Stop({ stop_hook_active: false, session_crons: crons })
  // Still the wakeup with its time, now under the job's id: a later snapshot keeps it.
  await world.clock.advance(SNAPSHOT_GRACE_MS)
  await $.classic.Stop({ stop_hook_active: false, session_crons: crons })
  expect(await bandText($)).toContain('◷ 4분 후 실행 · watching the build')

  await $.session.end({ reason: 'clear' })
  expect(await bandText($)).not.toContain('◷')
  await $.classic.Stop({ stop_hook_active: false, session_crons: [{ id: 'c9', schedule: '0 * * * *', recurring: true, prompt: 'hourly report' }] })
  expect(await bandText($)).toContain('◷ 반복 예약 · hourly report')
})

test('the band turns a schedule to 곧 실행 on time, with no minute clock to wait for', async ($, on) => {
  const world = workWorld(on, { answer: e => scheduleRecords(e, T0) })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'remind me', turnId: 't1' })
  await $.tool.call({ tool: 'CronCreate', cron: '4 * * * *', prompt: 'check the deploy', recurring: false })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await world.clock.advance(2_000)
  expect(await bandText($)).toContain('◷ 4분 후 실행')
  await world.clock.advance(3 * MIN)
  expect(await bandText($)).toContain('◷ 곧 실행 · check the deploy')
})

test('the head says when a notification or a stored prompt started the turn', async () => {
  expect(texts(statusRows({ ...STATUS, work: { ...WORKING, trigger: 'task' }, now: T0 + 5_000 }))[0]).toBe('● 알림 받고 작업 중 · 5초')
  expect(texts(statusRows({ ...STATUS, work: { ...WORKING, trigger: 'schedule' }, now: T0 + 12_000 }))[0]).toBe('● 예약 작업 중 · 12초')
  expect(texts(statusRows({ ...STATUS, work: { ...WORKING, trigger: '' } }))[0]).toBe('● 작업 중 · 0초')
  expect(triggerOf('task-notification', undefined)).toBe('task')
  expect(triggerOf('scheduled-trigger', undefined)).toBe('schedule')
  // Delivered into a running turn, it starts nothing of its own.
  expect(triggerOf('task-notification', 't1')).toBe('')
  expect(triggerOf('composer', undefined)).toBe('')
})

// The engine may settle a prompt's `next(e)` before its turn's start reaches the hooks: these tests
// submit the prompt first and start its turn after.
const headOf = async ($: TestArgs[0], surface: 'terminal' | 'desktop' = 'desktop') => {
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface, component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
  const head = (await statusTexts(ui))[0]
  await ui.unmount()
  return head
}

test('a turn a notification opened says so, and the next one the person starts does not', async ($, on) => {
  workWorld(on)
  await $.session.measure(MEASURE)
  await $.prompt.submit(NOTIFY('b1', 'completed'))
  await $.turn.start({ text: 'b1 done', turnId: 't1' })
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await headOf($, surface)).toMatch(/^[●○] 알림 받고 작업 중 · 0초$/)
  }
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.prompt.submit({ text: 'next', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await headOf($)).toMatch(/^[●○] 작업 중 · 0초$/)
})

test('a stored prompt\'s turn says so and, however long, is not announced', async ($, on) => {
  const world = workWorld(on)
  await $.session.measure(MEASURE)
  await $.prompt.submit({ text: 'check the deploy', origin: { kind: 'scheduled-trigger' }, wait: false })
  await $.turn.start({ text: 'check the deploy', turnId: 't1' })
  expect(await headOf($)).toMatch(/^[●○] 예약 작업 중 · 0초$/)
  await $.turn.complete({ answer: '', durationMs: 42_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await world.clock.advance(2_000)
  expect(world.toasts).toEqual([])
})

test('a notification delivered into a running turn leaves the waiting trigger alone', async ($, on) => {
  workWorld(on)
  await $.session.measure(MEASURE)
  await $.prompt.submit({ text: 'check the deploy', origin: { kind: 'scheduled-trigger' }, wait: false })
  await $.prompt.submit({ ...NOTIFY('b1', 'completed'), turnId: 't0' })
  await $.turn.start({ text: 'check the deploy', turnId: 't1' })
  expect(await headOf($)).toMatch(/^[●○] 예약 작업 중 · 0초$/)
})

test('a dropped notification leaves the next turn as the person\'s', async ($, on) => {
  workWorld(on, { submit: () => ({ drop: 'not now' }) })
  await $.session.measure(MEASURE)
  await $.prompt.submit(NOTIFY('b1', 'completed'))
  await $.turn.start({ text: 'mine', turnId: 't2' })
  expect(await headOf($)).toMatch(/^[●○] 작업 중 · 0초$/)
})

test('a schedule weeks away still turns to 곧 실행 on time: the clock wakes within the hour and looks again', { timeoutMs: 60_000 }, async ($, on) => {
  const far = T0 + 64 * 24 * 60 * MIN
  const world = workWorld(on, { answer: e => (e.tool === 'CronCreate' ? { id: 'xmas', humanSchedule: '', recurring: false, nextFireAt: far } : {}) })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'remind me at christmas', turnId: 't1' })
  await $.tool.call({ tool: 'CronCreate', cron: '0 9 25 12 *', prompt: 'christmas morning', recurring: false })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await world.clock.advance(2_000)
  expect(await bandText($)).toContain('◷ 64일 0시간 후 실행 · christmas morning')
  await world.clock.advance(far - T0 - 30_000)
  expect(await bandText($)).toContain('◷ 곧 실행 · christmas morning')
})

test('a helper\'s monitor shows as one from the stop\'s snapshot, though the snapshot calls it a shell', async ($, on) => {
  const world = workWorld(on, { answer: e => (e.tool === 'Monitor' ? { taskId: 'm5', timeoutMs: 300_000 } : {}) })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Monitor', description: 'Watch the log', timeout_ms: 300_000, command: 'tail -f app.log', agentId: 'agent-1' } as never)
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await bandText($)).not.toContain('◌ 백그라운드')
  await world.clock.advance(SNAPSHOT_GRACE_MS)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'm5', type: 'shell', status: 'running', description: 'Watch the log', command: 'tail -f app.log' }] })
  expect(await bandText($)).toContain('◌ 백그라운드: 지켜보기 — Watch the log')
})
