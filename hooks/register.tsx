import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'usage-mods', key: 'usage' } as const, null)
const isCompacting = atom({ plugin: 'usage-mods', key: 'isCompacting' } as const, false)
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

/** What hovering a meter shows: the percent, and for the 5-hour window when it resets. */
export const hoverText = (u: Usage, m: Meter, now: number): string => {
  const resetsAt = m.key === 'five_hour' ? u.limits.find(l => l.kind === 'five_hour')?.resetsAt : undefined
  return resetsAt === undefined ? `${m.percent}%` : `${m.percent}% · ${timeLeft(resetsAt, now)} 후 재설정`
}

// Moves the clock the countdown reads, so the band redraws once a minute.
const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await update($, clockNow, () => now)
}

export const QUESTION = '압축하시겠습니까?'
export const YES = '예'
export const NO = '아니오'

// Dismissing the dialog counts as 아니오.
const confirmCompact = async ($: EngineInterface): Promise<boolean> => {
  try {
    return (await $.ui.ask(QUESTION, { header: '압축', options: [YES, NO] })) === YES
  } catch {
    return false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || u === null) {
      return next(e)
    }

    const rows = meters(u)
    const hasReset = u.limits.some(l => l.resetsAt !== undefined)
    const now = hasReset ? (await read($, clockNow)) || (await $.clock.now()) : 0
    const reset = weeklyReset(u, now)
    const compacting = await read($, isCompacting)
    const isEnabled = canCompact(u, e.props.isWorking, compacting)
    const { Box, Button, Text } = $.ui.resolve(e)

    const compact = async () => {
      if (!(await confirmCompact($))) {
        return
      }
      await update($, isCompacting, () => true)
      try {
        const result = await $.session.compact()
        if (result.skip !== undefined) {
          $.ui.toast(`압축하지 않았어요: ${result.skip}`)
        } else {
          const after = await $.session.usage()
          await update($, usage, () => toUsage(after))
          $.ui.toast('컨텍스트를 압축했어요')
        }
      } catch (error) {
        $.ui.toast(`압축하지 못했어요: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        await update($, isCompacting, () => false)
      }
    }

    const meter = (m: Meter) => {
      const color = meterColor(m.percent)
      return (
        <Box key={m.key} flexDirection="row" marginRight={2}>
          <Text dimColor>{m.label} </Text>
          <Box key={`${m.key}-bar`}>
            <Text color={color}>{bar(m.percent)}</Text>
            <Box position="absolute" top={0} left={0} display="none" hover={{ display: 'flex' }}>
              <Text bold inverse color={color}>{center(hoverText(u, m, now))}</Text>
            </Box>
          </Box>
        </Box>
      )
    }

    const [context, ...limits] = rows

    return (
      <Box flexDirection="row">
        <Text dimColor>사용량 </Text>
        {meter(context)}
        <Box key="compact-slot" marginRight={2}>
          {isEnabled ? (
            <Button key="compact" label="압축" onPress={compact} />
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
