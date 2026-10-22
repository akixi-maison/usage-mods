import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Work } from '../types'
import {
  appendLine,
  ASK_FRESH_MS,
  bar,
  BAR_PX,
  barSvg,
  canCompact,
  costText,
  describePrompt,
  describeTool,
  elapsed,
  hasCompacted,
  hoverParts,
  hoverText,
  isBusyAgent,
  isHeadlessRefusal,
  LOG_FILE,
  meterColor,
  meters,
  OFF_HINT,
  QUEUE_TIMEOUT,
  shouldSendCompact,
  statusRows,
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

test('draws the countdown beside the 7-day bar, with no cost on a subscription, and moves it every minute', async ($, on) => {
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

test('a teammate in a pane of its own is not counted as at work', async () => {
  expect(isBusyAgent({ id: 'a1', status: 'running' })).toBe(true)
  expect(isBusyAgent({ id: 'a1', status: 'waiting' })).toBe(true)
  expect(isBusyAgent({ id: 'a1', status: 'completed' })).toBe(false)
  expect(isBusyAgent({ id: 'bob@team', teammateId: 'bob@team', status: 'running' })).toBe(false)
})

// The engine's side of a turn: the clock, the agents, the notification channel, and tool calls
// that run until the test finishes them.
const workWorld = (on: TestArgs[1], now = T0) => {
  const clock = mock.clock(on, { now })
  const toasts: string[] = []
  const finishers: Array<() => void> = []
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: [] }))
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', () => new Promise(resolve => finishers.push(() => resolve({ result: {} }))))
  return { clock, toasts, finish: () => finishers.shift()?.() }
}

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

test('a helper\'s turn leaves the compact button as the main loop left it', async ($, on) => {
  workWorld(on)
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'background work', turnId: 'sub', agentId: 'agent-1' })
  const ui = await $.ui.mount({ plugin: 'usage-mods', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  expect((await statusTexts(ui)).length).toBe(0)
  await ui.unmount()
})
