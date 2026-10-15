import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, Timer } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'usage-mods', key: 'usage' } as const, null)
const isCompacting = atom({ plugin: 'usage-mods', key: 'isCompacting' } as const, false)
const isTurnRunning = atom({ plugin: 'usage-mods', key: 'isTurnRunning' } as const, false)
const clockNow = atom({ plugin: 'usage-mods', key: 'now' } as const, 0)

const LABELS: Record<string, string> = { five_hour: '5시간', seven_day: '7일', spend_limit: '한도' }

const toUsage = (m: Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>): Usage => ({
  contextPercent: m.context.percent,
  limits: m.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  usd: m.cost?.usd,
})

const BAR_WIDTH = 10

export type Meter = { key: string; label: string; percent: number }

export const meters = (u: Usage): Meter[] => [
  { key: 'context', label: '컨텍스트', percent: u.contextPercent ?? 0 },
  ...u.limits.map(l => ({ key: l.kind, label: LABELS[l.kind] ?? l.kind, percent: l.percentUsed })),
]

export const bar = (percent: number): string => {
  const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * BAR_WIDTH)
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

export const meterColor = (percent: number): 'red' | 'yellow' | 'green' =>
  percent >= 90 ? 'red' : percent >= 80 ? 'yellow' : 'green'

const center = (text: string): string => {
  const pad = Math.max(BAR_WIDTH - text.length, 0)
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + text + ' '.repeat(pad - left)
}

/** `$.session.compact` refuses in a headless (SDK) session, which is how the desktop app runs Claude Code. */
export const isHeadlessRefusal = (message: string): boolean => /headless/i.test(message)

/**
 * Whether a refused compaction is sent as a /compact prompt instead: in a session with no person at
 * the prompt (the desktop app, an SDK host) whatever the reason, or when the refusal says headless.
 */
export const shouldSendCompact = (message: string, isInteractive: boolean): boolean =>
  !isInteractive || isHeadlessRefusal(message)

/**
 * Compaction runs between turns over a conversation the model has answered:
 * not while a turn runs, not while one is under way, and not before the live
 * window's first response (a fresh or just-compacted session has no fill yet).
 */
export const canCompact = (u: Usage, isWorking: boolean, compacting: boolean): boolean =>
  !isWorking && !compacting && (u.contextPercent ?? 0) > 0

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** `3일 0시간` from a day out, `2시간 13분` within one, `13분` within the hour. */
export const timeLeft = (resetsAt: string, now: number): string => {
  const ms = Math.max(0, Date.parse(resetsAt) - now)
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  return days > 0 ? `${days}일 ${hours}시간` : hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`
}

/** `초기화까지 3일 0시간`; null while the 7-day window has no reset time. */
export const weeklyReset = (u: Usage, now: number): string | null => {
  const resetsAt = u.limits.find(l => l.kind === 'seven_day')?.resetsAt
  return resetsAt === undefined ? null : `초기화까지 ${timeLeft(resetsAt, now)}`
}

export type Hover = { percent: string; reset?: string }

/** What hovering a meter shows: the percent, and when its window resets where it has a reset time. */
export const hoverParts = (u: Usage, m: Meter, now: number): Hover => {
  const resetsAt = u.limits.find(l => l.kind === m.key)?.resetsAt
  return { percent: `${m.percent}%`, reset: resetsAt === undefined ? undefined : `${timeLeft(resetsAt, now)} 후 재설정` }
}

/** The hover as one line, `23% · 2시간 13분 후 재설정`. */
export const hoverText = (u: Usage, m: Meter, now: number): string => {
  const { percent, reset } = hoverParts(u, m, now)
  return reset === undefined ? percent : `${percent} · ${reset}`
}

// Moves the clock the countdown reads, so the band redraws once a minute.
const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await update($, clockNow, () => now)
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// --- Compaction trace (temporary) -------------------------------------------------------------
// Kept while checking that the compact button really compacts in the desktop app, where the
// debug log is out of reach: each step is also appended to ~/.claude/usage-mods-compact.log.
// Remove this block and the trace() calls once compaction is confirmed.

export const LOG_FILE = '.claude/usage-mods-compact.log'
const LOG_LIMIT = 300

export const logLine = (time: number, session: string, text: string): string =>
  `${new Date(time).toISOString()} [${session.slice(0, 8)}] ${text}`

/** The log's text with `line` added, keeping the newest `limit` lines. */
export const appendLine = (text: string, line: string, limit = LOG_LIMIT): string =>
  [...text.split('\n').filter(l => l !== ''), line].slice(-limit).join('\n') + '\n'

/** A prompt as the trace names it: `/compact` itself, otherwise only its length. */
export const describePrompt = (text: string): string =>
  text.trim() === '/compact' ? '/compact' : `prompt of ${text.length} chars`

// One write at a time, so one session's lines keep their order; every session shares the file.
let traceQueue: Promise<void> = Promise.resolve()

const writeTrace = async ($: EngineInterface, text: string) => {
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') {
    return
  }
  const path = `${home}/${LOG_FILE}`
  const [now, session, before] = await Promise.all([
    $.clock.now(),
    $.session.id().catch(() => '?'),
    $.fs.read(path).catch(() => ''),
  ])
  await $.fs.write(path, appendLine(before, logLine(now, session, text)))
}

const trace = ($: EngineInterface, text: string) => {
  $.ui.log(`usage-mods: ${text}`, { to: 'debug' })
  traceQueue = traceQueue.then(() => writeTrace($, text)).catch(() => {})
}

// The band's isWorking as last drawn, for the trace to set beside the plugin's own turn tracking.
let lastIsWorking: boolean | undefined
// --- end of compaction trace -------------------------------------------------------------------

export const QUESTION = '압축하시겠습니까?'
export const YES = '예'
export const NO = '아니오'

/** How long the /compact the band ran may wait for its compaction before the band lets go. */
export const QUEUE_TIMEOUT = 10 * MINUTE

// Dismissing the dialog counts as 아니오.
const confirmCompact = async ($: EngineInterface): Promise<boolean> => {
  try {
    return (await $.ui.ask(QUESTION, { header: '압축', options: [YES, NO] })) === YES
  } catch {
    return false
  }
}

// One compaction at a time across redraws and repeated presses; the module's own, so a reload clears it.
let isBusy = false

// Whether a person is at the prompt, as session.start said: false in the desktop app.
let isInteractive = true

// A /compact the band sent, waiting for the compaction it asked for; `timer` lets go of it.
let waiting: { timer: Timer | null } | null = null

const finishWaiting = async ($: EngineInterface, toast: string) => {
  if (waiting === null) {
    return
  }
  waiting.timer?.cancel()
  waiting = null
  await update($, isCompacting, () => false)
  $.ui.toast(toast)
}

/**
 * After the /compact command: whether it compacted, read from the context fill (it drops, or is
 * unknown until the next answer) in case no `session.compact` reached this plugin.
 */
export const hasCompacted = (before: number, after: number | undefined): boolean => (after ?? 0) < before

const endCompactCommand = async ($: EngineInterface, before: number, output: string) => {
  const now = await $.session.usage()
  await update($, usage, () => toUsage(now))
  trace($, `/compact command ended, context ${before}% → ${now.context.percent}%: ${output || '(no output)'}`)
  if (hasCompacted(before, now.context.percent)) {
    await finishWaiting($, '컨텍스트를 압축했어요')
  } else {
    await finishWaiting($, output ? `압축되지 않았어요: ${output}` : '압축되지 않았어요')
  }
}

/**
 * The desktop app and other SDK hosts compact only inside a turn: runs /compact as if the person
 * typed it (`$.prompt.submit` refuses a text that starts with `/`), queued until the session is idle.
 * The band keeps compacting until the compaction lands (`session.compact`), the command ends
 * (compacted or not), or the wait runs out.
 */
const sendCompact = ($: EngineInterface, before: number) => {
  waiting = {
    timer: $.clock.after(QUEUE_TIMEOUT, () => {
      trace($, `no compaction within ${QUEUE_TIMEOUT / MINUTE} minutes; letting go`)
      void finishWaiting($, '압축되지 않았어요. 입력창에 /compact를 보내 주세요')
    }),
  }
  $.ui.toast('압축을 요청했어요')
  void (async () => {
    try {
      const result = await $.command.run({ command: 'compact' })
      await endCompactCommand($, before, result.text ?? '')
    } catch (error) {
      const message = errorMessage(error)
      trace($, `/compact command failed: ${message}`)
      await finishWaiting($, `압축하지 못했어요: ${message}`)
    }
  })()
}

/**
 * Asks, then compacts. Runs on a timer, not inside the press: the band redraws often (usage updates,
 * the minute clock), and work tied to the drawn Button or its press dispatch is lost with it.
 */
const runCompact = async ($: EngineInterface) => {
  let isWaiting = false
  try {
    const [u, turnRunning] = await Promise.all([read($, usage), read($, isTurnRunning)])
    trace($, `pressed: band isWorking=${lastIsWorking}, turn running=${turnRunning}, context=${u?.contextPercent}%`)
    if (!(await confirmCompact($))) {
      trace($, 'declined')
      return
    }
    await update($, isCompacting, () => true)
    try {
      const result = await $.session.compact()
      if (result.skip !== undefined) {
        trace($, `compact skipped: ${result.skip}`)
        $.ui.toast(`압축하지 않았어요: ${result.skip}`)
      } else {
        trace($, 'compacted')
        const after = await $.session.usage()
        await update($, usage, () => toUsage(after))
        $.ui.toast('컨텍스트를 압축했어요')
      }
    } catch (error) {
      const message = errorMessage(error)
      trace($, `compact refused: ${message}`)
      if (shouldSendCompact(message, isInteractive)) {
        sendCompact($, u?.contextPercent ?? 0)
        isWaiting = true
      } else {
        $.ui.toast(`압축하지 못했어요: ${message}`)
      }
    }
  } finally {
    if (!isWaiting) {
      await update($, isCompacting, () => false)
    }
    isBusy = false
  }
}

const startCompact = ($: EngineInterface) => {
  if (isBusy || waiting !== null) {
    return
  }
  isBusy = true
  try {
    $.clock.after(0, () => void runCompact($))
  } catch (error) {
    isBusy = false
    throw error
  }
}

export const register: Register = on => {
  // Takes the press by its key, before the drawn Button's own onPress: a redraw replaces that handler.
  on('ui.press', { plugin: 'usage-mods', element: 'compact' }, ($, e) => {
    startCompact($)
    return { element: e.element }
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    isInteractive = e.isInteractive
    trace($, `session started: surface ${e.surface}, interactive ${e.isInteractive}`)
    // A reload drops the module's waiting /compact, so the band starts out of it.
    await update($, isCompacting, () => false)
    await update($, isTurnRunning, () => false)
    const u = await $.session.usage()
    await update($, usage, () => toUsage(u))
    await tick($)
    $.clock.every(MINUTE, () => void tick($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e))
    return next(e)
  })

  // The plugin's own record of a running turn, beside the band's isWorking: the button is off while either says so.
  on('turn.start', async ($, e, next) => {
    await update($, isTurnRunning, () => true)
    if (waiting !== null) {
      trace($, `turn started while /compact waits: ${describePrompt(e.text)}`)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, isTurnRunning, () => false)
      if (waiting !== null) {
        trace($, `turn ended (${e.reason}) while /compact waits`)
      }
    }
    return result
  })

  // Every compaction of the main conversation: the one a /compact the band sent waits for.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') {
      return next(e)
    }
    trace($, `compaction starting (trigger ${e.trigger})`)
    const result = await next(e).catch(async error => {
      const message = errorMessage(error)
      trace($, `compaction failed (trigger ${e.trigger}): ${message}`)
      await finishWaiting($, `압축하지 못했어요: ${message}`)
      throw error
    })
    if (result.skip !== undefined) {
      trace($, `compaction skipped (trigger ${e.trigger}): ${result.skip}`)
      await finishWaiting($, `압축하지 않았어요: ${result.skip}`)
    } else {
      trace($, `compaction done (trigger ${e.trigger}): ${result.tokensBefore} → ${result.tokensAfter} tokens`)
      await finishWaiting($, '컨텍스트를 압축했어요')
    }
    return result
  }).catch(($, e, next) => next(e))

  // Trace only: what became of a /compact, the band's or typed, and of prompts sent while it waits.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (waiting !== null || e.text.trim() === '/compact') {
      const outcome = result.drop === undefined ? 'entered' : `dropped: ${result.drop}`
      trace($, `prompt from ${e.origin.kind}: ${describePrompt(e.text)}, ${outcome}`)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'compact' }, async ($, e, next) => {
    trace($, `/compact command from ${e.origin.kind}`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || u === null) {
      return next(e)
    }
    lastIsWorking = e.props.isWorking // compaction trace

    const rows = meters(u)
    const hasReset = u.limits.some(l => l.resetsAt !== undefined)
    const now = hasReset ? (await read($, clockNow)) || (await $.clock.now()) : 0
    const reset = weeklyReset(u, now)
    const compacting = await read($, isCompacting)
    const turnRunning = await read($, isTurnRunning)
    const isEnabled = canCompact(u, e.props.isWorking || turnRunning, compacting)
    const { Box, Button, Text } = $.ui.resolve(e)

    // The terminal lays the hover over the bar's own cells, reversed; the desktop draws the hover Box
    // as a card of its own above the band, where reversed text reads as a highlighter mark.
    const hoverCard = (m: Meter, color: ReturnType<typeof meterColor>) => {
      const { percent, reset } = hoverParts(u, m, now)
      return e.surface === 'terminal' ? (
        <Text bold inverse color={color}>{center(hoverText(u, m, now))}</Text>
      ) : (
        <Box flexDirection="row">
          <Text bold color={color}>{percent}</Text>
          {reset === undefined ? null : <Text dimColor>{` · ${reset}`}</Text>}
        </Box>
      )
    }

    const meter = (m: Meter) => {
      const color = meterColor(m.percent)
      return (
        <Box key={m.key} flexDirection="row" marginRight={2}>
          <Text dimColor>{m.label} </Text>
          <Box key={`${m.key}-bar`}>
            <Text color={color}>{bar(m.percent)}</Text>
            <Box position="absolute" top={0} left={0} display="none" hover={{ display: 'flex' }}>
              {hoverCard(m, color)}
            </Box>
          </Box>
        </Box>
      )
    }

    // meters() always leads with the context meter.
    const [context, ...limits] = rows as [Meter, ...Meter[]]

    return (
      <Box flexDirection="row">
        <Text dimColor>사용량 </Text>
        {meter(context)}
        <Box key="compact-slot" marginRight={2}>
          {isEnabled ? (
            <Button key="compact" label="압축" onPress={() => startCompact($)} />
          ) : (
            <Text dimColor>{compacting ? '[ 압축 중… ]' : '[ 압축 ]'}</Text>
          )}
        </Box>
        {limits.map(meter)}
        {u.usd === undefined ? null : (
          <Box key="usd" marginRight={2}>
            <Text dimColor>${u.usd.toFixed(2)}</Text>
          </Box>
        )}
        {reset === null ? null : <Text dimColor>{reset}</Text>}
      </Box>
    )
  })
}
