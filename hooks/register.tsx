import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  AgentStatus,
  EngineInterface,
  Register,
  SessionMeasureInput,
  Timer,
  ToolCallInput,
  ToolCallResult,
  TurnCompleteInput,
} from 'claude-code'

import type { BackgroundKind, BackgroundTask, HelperAsk, Phase, RunningTool, Usage, Work } from '../types'

const IDLE_WORK: Work = { phase: 'idle', startedAt: 0, durationMs: 0, tools: 0, running: [], stopReason: '' }

const usage = atom({ plugin: 'usage-mods', key: 'usage' } as const, null)
const isCompacting = atom({ plugin: 'usage-mods', key: 'isCompacting' } as const, false)
const isTurnRunning = atom({ plugin: 'usage-mods', key: 'isTurnRunning' } as const, false)
const clockNow = atom({ plugin: 'usage-mods', key: 'now' } as const, 0)
const work = atom({ plugin: 'usage-mods', key: 'work' } as const, IDLE_WORK)
const beat = atom({ plugin: 'usage-mods', key: 'beat' } as const, false)
const helpers = atom({ plugin: 'usage-mods', key: 'helpers' } as const, [] as string[])
const helperTurns = atom({ plugin: 'usage-mods', key: 'helperTurns' } as const, [] as string[])
const helperAsks = atom({ plugin: 'usage-mods', key: 'helperAsks' } as const, [] as HelperAsk[])
const tasks = atom({ plugin: 'usage-mods', key: 'tasks' } as const, [] as BackgroundTask[])

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

/** The theme's own colors for a meter, so the band follows the person's theme. */
export const meterColor = (percent: number): 'error' | 'warning' | 'success' =>
  percent >= 90 ? 'error' : percent >= 80 ? 'warning' : 'success'

// Off the terminal a bar is a picture: a rounded track and its fill, in CSS pixels. A picture cannot
// follow the theme, so the track is a see-through grey and the fills read on light and dark alike.
export const BAR_PX = { width: 96, height: 6 }
const BAR_FILL: Record<ReturnType<typeof meterColor>, string> = { success: '#2f9e57', warning: '#c27c0e', error: '#d93f3f' }

/** The bar as SVG: the fill in proportion, clamped, never thinner than its own height once above 0. */
export const barSvg = (percent: number, color: ReturnType<typeof meterColor>): string => {
  const { width, height } = BAR_PX
  const p = Math.min(Math.max(percent, 0), 100)
  const filled = p === 0 ? 0 : Math.max((p / 100) * width, height)
  const rect = (w: number, paint: string) =>
    `<rect width="${Number(w.toFixed(1))}" height="${height}" rx="${height / 2}" ${paint}/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    rect(width, 'fill="#808080" fill-opacity="0.25"') +
    (filled === 0 ? '' : rect(filled, `fill="${BAR_FILL[color]}"`)) +
    '</svg>'
  )
}

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

/** Whether the account has a subscription's 5-hour or 7-day limits, which are what bound its use. */
export const isSubscription = (u: Usage): boolean =>
  u.limits.some(l => l.kind === 'five_hour' || l.kind === 'seven_day')

/** `$0.50`, the session's cost at API prices; null on a subscription, which is not billed by it. */
export const costText = (u: Usage): string | null =>
  u.usd === undefined || isSubscription(u) ? null : `$${u.usd.toFixed(2)}`

export type Hover = { percent: string; reset?: string }

/** What hovering a meter shows: the percent, and when its window resets where it has a reset time. */
export const hoverParts = (u: Usage, m: Meter, now: number): Hover => {
  const resetsAt = u.limits.find(l => l.kind === m.key)?.resetsAt
  return { percent: `${m.percent}%`, reset: resetsAt === undefined ? undefined : `${timeLeft(resetsAt, now)} 후 초기화` }
}

/** The hover as one line, `23% · 2시간 13분 후 초기화`. */
export const hoverText = (u: Usage, m: Meter, now: number): string => {
  const { percent, reset } = hoverParts(u, m, now)
  return reset === undefined ? percent : `${percent} · ${reset}`
}

// Moves the clock the countdown reads, so the band redraws once a minute.
const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await update($, clockNow, () => now)
}

// --- Work status -------------------------------------------------------------------------------
// The rows above the meters: whether the main turn is at work, waits on the person, or has ended,
// and how many helpers (subagents) still work.

/** A permission prompt counts as waiting on the person this long; past it the call may well run. */
export const ASK_FRESH_MS = 30_000
/** An ended turn at least this long is announced: a notification, or a toast where none can be sent. */
export const ANNOUNCE_AFTER_MS = 30_000

type ToolWords = { label: string; needsMe?: boolean; detail?: (pick: (key: string) => string) => string }

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? url

const TOOL_WORDS: Record<string, ToolWords> = {
  Bash: { label: '명령 실행', detail: pick => pick('description') || pick('command') },
  PowerShell: { label: '명령 실행', detail: pick => pick('description') || pick('command') },
  Read: { label: '파일 읽기', detail: pick => fileName(pick('file_path')) },
  Edit: { label: '파일 고치기', detail: pick => fileName(pick('file_path')) },
  Write: { label: '파일 쓰기', detail: pick => fileName(pick('file_path')) },
  NotebookEdit: { label: '노트 파일 고치기', detail: pick => fileName(pick('notebook_path')) },
  Grep: { label: '내용 찾기', detail: pick => pick('pattern') },
  Glob: { label: '파일 찾기', detail: pick => pick('pattern') },
  WebFetch: { label: '웹 페이지 읽기', detail: pick => hostOf(pick('url')) },
  WebSearch: { label: '웹 검색', detail: pick => pick('query') },
  Agent: { label: '도우미에게 맡기기', detail: pick => pick('description') },
  Task: { label: '도우미에게 맡기기', detail: pick => pick('description') },
  Workflow: { label: '도우미 여러 명 돌리기' },
  Monitor: { label: '지켜보기 시작', detail: pick => pick('description') },
  TaskStop: { label: '백그라운드 작업 멈추기', detail: pick => pick('task_id') || pick('shell_id') },
  Skill: { label: '스킬 불러오기', detail: pick => pick('skill') },
  ToolSearch: { label: '도구 찾기' },
  TodoWrite: { label: '할 일 정리' },
  AskUserQuestion: { label: '질문에 답해 주세요', needsMe: true },
  ExitPlanMode: { label: '계획을 확인해 주세요', needsMe: true },
}

/** Plain words for a tool call: what it does, and what it works on. */
export const describeTool = (tool: string, input: unknown): Pick<RunningTool, 'label' | 'detail' | 'needsMe'> => {
  const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const pick = (key: string) => {
    const value = args[key]
    return typeof value === 'string' ? value : ''
  }
  const words = TOOL_WORDS[tool]
  const isBackground = (tool === 'Bash' || tool === 'PowerShell') && args['run_in_background'] === true
  const label = isBackground ? '백그라운드로 명령 실행' : words?.label ?? `도구 사용: ${/^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool}`
  const detail = (words?.detail?.(pick) ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return { label, detail, needsMe: words?.needsMe === true }
}

/** `45초`, `1분 23초`, `1시간 2분`. */
export const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 > 0 ? `${m}분 ${s % 60}초` : `${m}분`
  return m % 60 > 0 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.floor(m / 60)}시간`
}

export type StatusTone = 'claude' | 'warning' | 'success' | 'error' | 'dim'
export type StatusRow = { text: string; tone: StatusTone; bold: boolean }
export type StatusInput = {
  work: Work
  isWorking: boolean
  now: number
  beat: boolean
  helpers: number
  helperAsks: readonly HelperAsk[]
  isViewingHelper: boolean
  /** Background commands, monitors and workflow runs still at work. */
  tasks?: readonly BackgroundTask[]
}

const what = (one: { label: string; detail: string }) => (one.detail ? `${one.label} — ${one.detail}` : one.label)

/** Background tasks the band keeps at most; the oldest go first. */
const MAX_TASKS = 50
/** A snapshot taken this soon after the mod recorded a task may not list it yet. */
export const SNAPSHOT_GRACE_MS = 2000

const KIND_WORDS: Record<BackgroundKind, string> = { shell: '명령', monitor: '모니터', workflow: '워크플로' }
const KIND_LABELS: Record<BackgroundKind, string> = { shell: '명령 실행', monitor: '지켜보기', workflow: '워크플로' }

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
const str = (value: unknown) => (typeof value === 'string' ? value : '')
/** One line, cut short, without the engine's `... [+N chars]` clipping mark. */
const clip = (text: string) => text.replace(/\.\.\. \[\+\d+ chars\]$/, '').replace(/\s+/g, ' ').trim().slice(0, 80)

/** The background task a settled call started, read from the tool's own record; null for any other call. */
export const taskFromCall = (tool: string, input: unknown, record: unknown, startedAt: number, now: number): BackgroundTask | null => {
  const r = asRecord(record)
  const { detail } = describeTool(tool, input)
  const base = { detail, startedAt, endsBy: 0, seenAt: now }
  if (tool === 'Bash' || tool === 'PowerShell') {
    // Run in the background from the start, by Ctrl+B or past its timeout: the record says which, the id is the same.
    const id = str(r['backgroundTaskId'])
    // One that ends with its caller's final response sends no notification: it is not left running.
    return id === '' || r['backgroundEndsWithFinalResponse'] === true ? null : { ...base, id, kind: 'shell', label: KIND_LABELS.shell }
  }
  if (tool === 'Monitor') {
    const id = str(r['taskId'])
    const timeoutMs = typeof r['timeoutMs'] === 'number' ? r['timeoutMs'] : 0
    const endsBy = r['persistent'] === true || timeoutMs <= 0 ? 0 : startedAt + timeoutMs
    return id === '' ? null : { ...base, id, kind: 'monitor', label: KIND_LABELS.monitor, endsBy }
  }
  if (tool === 'Workflow') {
    const id = str(r['taskId'])
    const isRemote = r['status'] === 'remote_launched' || r['taskType'] === 'remote_agent'
    const label = isRemote ? '원격 워크플로' : KIND_LABELS.workflow
    return id === '' ? null : { ...base, id, kind: 'workflow', label, detail: clip(str(r['workflowName'])) }
  }
  return null
}

/** The task a settled TaskStop stopped; null for any other call. */
export const stoppedTaskId = (tool: string, record: unknown): string | null =>
  tool === 'TaskStop' ? str(asRecord(record)['task_id']) || null : null

const ENDED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error'])

/**
 * Ids of the tasks a notification says have ended: each `<task-notification>` block's `<task-id>`
 * whose `<status>` is an ending one. A monitor's events carry none and end nothing.
 */
export const endedTaskIds = (text: string): string[] =>
  text
    .split('<task-notification>')
    .slice(1)
    .flatMap(block => {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(block)?.[1]?.trim() ?? ''
      const status = /<status>([^<]+)<\/status>/.exec(block)?.[1]?.trim().toLowerCase() ?? ''
      return id !== '' && ENDED.has(status) ? [id] : []
    })

/** The in-flight background work a stop's snapshot lists (`background_tasks`), as much of it as the mod reads. */
export type TaskSnapshot = { id: string; type: string; description: string; command?: string; name?: string }

const SNAPSHOT_KINDS: Record<string, BackgroundKind> = { shell: 'shell', monitor: 'monitor', workflow: 'workflow' }

/**
 * The tracked tasks as a stop's snapshot leaves them: those it no longer lists are dropped (unless
 * recorded too recently for it), and the commands, monitors and workflows it lists that the mod did
 * not see start (a helper's, one from before a /clear) are added without a start time.
 */
export const reconcileTasks = (tracked: readonly BackgroundTask[], snapshot: readonly TaskSnapshot[], at: number): BackgroundTask[] => {
  const listed = new Set(snapshot.map(one => one.id))
  const kept = tracked.filter(task => listed.has(task.id) || at - task.seenAt < SNAPSHOT_GRACE_MS)
  const known = new Set(kept.map(task => task.id))
  const added = snapshot.flatMap((one): BackgroundTask[] => {
    const kind = SNAPSHOT_KINDS[one.type]
    if (kind === undefined || known.has(one.id)) return []
    const detail = clip(kind === 'workflow' ? one.name || one.description : one.description || one.command || '')
    return [{ id: one.id, kind, label: KIND_LABELS[kind], detail, startedAt: 0, endsBy: 0, seenAt: at }]
  })
  return [...kept, ...added].slice(-MAX_TASKS)
}

/** `12분째` once a minute has passed, by the minute: between turns the band redraws once a minute. */
export const runningFor = (ms: number): string => (ms < MINUTE ? '' : `${elapsed(Math.floor(ms / MINUTE) * MINUTE)}째`)

const taskNote = (task: BackgroundTask, now: number) =>
  task.kind === 'monitor' && task.endsBy > 0 && now >= task.endsBy ? '곧 끝나요' : task.startedAt > 0 ? runningFor(now - task.startedAt) : ''

/** `도우미 2명 · 명령 1개 · 모니터 1개`: what is still at work, kind by kind. */
export const backgroundParts = (helpers: number, list: readonly BackgroundTask[]): string[] => [
  ...(helpers > 0 ? [`도우미 ${helpers}명`] : []),
  ...(['shell', 'monitor', 'workflow'] as const).flatMap(kind => {
    const n = list.filter(task => task.kind === kind).length
    return n > 0 ? [`${KIND_WORDS[kind]} ${n}개`] : []
  }),
]

// The time goes ahead of the words, which are what a narrow band cuts.
const oneTask = (task: BackgroundTask, now: number) => {
  const note = taskNote(task, now)
  return `◌ 백그라운드${note ? ` (${note})` : ''}: ${what(task)}`
}

/** The dim row of background work beside a turn at work, or below another row; null with none. */
export const backgroundNote = (list: readonly BackgroundTask[], now: number): StatusRow | null => {
  if (list.length === 0) return null
  const text = list.length === 1 ? oneTask(list[0]!, now) : `◌ 백그라운드: ${backgroundParts(0, list).join(' · ')}`
  return { text, tone: 'dim', bold: false }
}

/**
 * The row of what still works once the main turn has ended: helpers blink their dot, as before; a
 * command or monitor alone is dim, since only a process runs and Claude does not.
 */
export const backgroundRow = (helpers: number, asked: boolean, list: readonly BackgroundTask[], now: number, dot: string): StatusRow | null => {
  const asking = asked ? ' · 승인 요청이 떴었어요' : ''
  if (list.length === 0) {
    return helpers > 0 ? { text: `${dot} 백그라운드 도우미 ${helpers}명은 아직 일하는 중${asking}`, tone: 'claude', bold: false } : null
  }
  if (helpers === 0) {
    const text = list.length === 1 ? oneTask(list[0]!, now) : `◌ 백그라운드에서 아직 일하는 중 · ${backgroundParts(0, list).join(' · ')}`
    return { text, tone: 'dim', bold: false }
  }
  return { text: `${dot} 백그라운드에서 아직 일하는 중 · ${backgroundParts(helpers, list).join(' · ')}${asking}`, tone: 'claude', bold: false }
}

/** The status rows, top first: none before the session's first turn. */
export const statusRows = (s: StatusInput): StatusRow[] => {
  const { work: w } = s
  const list = s.tasks ?? []
  const dot = s.beat ? '●' : '○'
  const lead = s.isViewingHelper ? '메인 대화 · ' : ''
  const isFresh = (at: number) => s.now - at < ASK_FRESH_MS
  const ago = (at: number) => (s.now - at < 1000 ? '방금' : `${elapsed(s.now - at)} 전`)
  const helperAsk = s.helperAsks.filter(ask => isFresh(ask.at)).at(-1)

  if (s.isWorking || w.phase === 'working') {
    if (w.phase !== 'working') {
      // Loaded mid-turn: the engine says it works; the clock and the dot start with the next turn.
      return [{ text: `${lead}작업 중…`, tone: 'claude', bold: true }]
    }

    const needsMe = w.running.find(one => one.needsMe)
    if (needsMe !== undefined) {
      return [
        { text: `${lead}! 나를 기다리는 중 · ${elapsed(s.now - needsMe.startedAt)}째`, tone: 'warning', bold: true },
        { text: what(needsMe), tone: 'warning', bold: false },
      ]
    }

    // The prompt shows until the person answers, and an approved call runs on: the band cannot tell
    // the two apart, so its words hold for both.
    const asked = w.running.find(one => one.askedAt !== null && isFresh(one.askedAt))
    if (asked !== undefined || helperAsk !== undefined) {
      const [head, at, one] =
        asked !== undefined
          ? (['승인 요청이 떴어요', asked.askedAt ?? s.now, asked] as const)
          : (['도우미가 승인 요청을 띄웠어요', helperAsk!.at, helperAsk!] as const)
      return [
        { text: `${lead}! ${head} · ${ago(at)}`, tone: 'warning', bold: true },
        { text: `${what(one)} · 승인했다면 실행 중이에요`, tone: 'warning', bold: false },
      ]
    }

    const head = [
      `${lead}${dot} 작업 중`,
      w.startedAt > 0 ? elapsed(s.now - w.startedAt) : '',
      w.tools > 0 ? `도구 ${w.tools}회` : '',
      s.helpers > 0 ? `도우미 ${s.helpers}명 일하는 중` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const first = w.running[0]
    let line = '생각하거나 답을 쓰는 중…'
    if (first !== undefined) {
      // Notes go before the call's words, which are what a narrow band cuts.
      const notes = [
        s.now - first.startedAt >= 3000 ? `${elapsed(s.now - first.startedAt)}째` : '',
        first.askedAt !== null ? '승인 요청이 떴었어요' : '',
      ]
        .filter(Boolean)
        .join(', ')
      const more = w.running.length > 1 ? ` 외 ${w.running.length - 1}개` : ''
      line = `지금${notes ? ` (${notes})` : ''}: ${what(first)}${more}`
    }
    const note = backgroundNote(list, s.now)
    return [
      { text: head, tone: 'claude', bold: true },
      { text: line, tone: 'dim', bold: false },
      ...(note === null ? [] : [note]),
    ]
  }

  const tools = w.tools > 0 ? ` · 도구 ${w.tools}회` : ''
  const rows: StatusRow[] = []
  if (w.phase === 'done') {
    rows.push({ text: `${lead}✓ 끝났어요 · ${elapsed(w.durationMs)} 걸림${tools} · 다음 지시를 기다려요`, tone: 'success', bold: true })
  } else if (w.phase === 'aborted') {
    rows.push({ text: `${lead}■ 중단했어요 · ${elapsed(w.durationMs)} 동안 작업함${tools}`, tone: 'warning', bold: true })
  } else if (w.phase === 'error') {
    // A full context, a usage limit or a network error all end here: the transcript says which.
    const text = w.stopReason === 'refusal' ? '✕ 요청을 거절했어요 · 다르게 말해 보세요' : '✕ 오류로 멈췄어요 · 대화에 뜬 안내를 확인해 주세요'
    rows.push({ text: `${lead}${text}`, tone: 'error', bold: true })
  }
  // At most two rows below the head: a fresh ask from a helper, else what still works in the background.
  const below: Array<StatusRow | null> =
    helperAsk !== undefined
      ? [{ text: `! 도우미가 승인 요청을 띄웠어요 · ${ago(helperAsk.at)} · ${what(helperAsk)}`, tone: 'warning', bold: true }, backgroundNote(list, s.now)]
      : [backgroundRow(s.helpers, s.helperAsks.length > 0, list, s.now, dot)]
  return [...rows, ...below.filter((row): row is StatusRow => row !== null)]
}

const BUSY: ReadonlySet<AgentStatus> = new Set(['pending', 'running', 'waiting'])

/** At work as the tasks list says; a teammate in a terminal pane of its own keeps its last word there, so it is left out. */
export const isBusyAgent = (agent: Pick<AgentInfo, 'id' | 'status' | 'teammateId'>): boolean =>
  BUSY.has(agent.status) && !(agent.teammateId !== undefined && agent.id === agent.teammateId)

const withId = (list: string[], id: string) => (list.includes(id) ? list : [...list, id])
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id))

// The status only feeds the band: work that fails must never fail the hook it rides on.
const quietly = (task: Promise<unknown>) => task.then(() => undefined, () => undefined)

// The module's own, so a reload cancels it with the old environment; session.start starts it again.
let workTicker: Timer | undefined
let isWorkTicking = false

const stopWorkTicker = () => {
  workTicker?.cancel()
  workTicker = undefined
}

// Once a second while the main turn or a helper works: moves the clock and the dot, recounts the
// helpers, and lets go of their stale asks. Stops once nothing works; the next turn starts it again.
const workTick = async ($: EngineInterface) => {
  if (isWorkTicking) return
  isWorkTicking = true
  try {
    const [w, known] = await Promise.all([read($, work), read($, helpers)])
    if (w.phase !== 'working' && known.length === 0) {
      stopWorkTicker()
      return
    }
    const listed = (await $.agent.list()).filter(isBusyAgent).map(agent => agent.id)
    const busy = [...new Set([...listed, ...(await read($, helperTurns))])]
    if (!sameIds(busy, known)) await update($, helpers, () => busy)
    await update($, helperAsks, list => (list.every(ask => busy.includes(ask.agentId)) ? list : list.filter(ask => busy.includes(ask.agentId))))
    const at = await $.clock.now()
    await update($, clockNow, () => at)
    await update($, beat, on => !on)
  } catch {
    // The next tick tries again.
  } finally {
    isWorkTicking = false
  }
}

const startWorkTicker = ($: EngineInterface) => {
  workTicker ??= $.clock.every(1000, () => void workTick($))
}

const startMainTurn = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, clockNow, () => at)
  await update($, work, () => ({ ...IDLE_WORK, phase: 'working', startedAt: at }))
  startWorkTicker($)
}

const startHelperTurn = async ($: EngineInterface, agentId: string) => {
  await update($, helperTurns, list => withId(list, agentId))
  await update($, helpers, list => withId(list, agentId))
  startWorkTicker($)
}

// A helper's turn can end while it still waits on background work of its own: the tasks list keeps
// it busy, and it stays counted (and the ticker running) until the list lets go of it.
const endHelperTurn = async ($: EngineInterface, agentId: string) => {
  await update($, helperTurns, list => list.filter(id => id !== agentId))
  await update($, helperAsks, list => list.filter(ask => ask.agentId !== agentId))
  const isStillBusy = await $.agent.list().then(
    list => list.some(agent => agent.id === agentId && isBusyAgent(agent)),
    () => false,
  )
  if (!isStillBusy) {
    await update($, helpers, list => list.filter(id => id !== agentId))
  }
}

// Waits a moment first: a turn that starts right away (a queued prompt) makes the news stale.
const announceEnd = async ($: EngineInterface, text: string) => {
  if ((await read($, work)).phase === 'working') return
  const [waiting, left] = await Promise.all([read($, helpers).then(list => list.length), read($, tasks)])
  const full =
    left.length > 0
      ? `${text} · 백그라운드에서 아직 일하는 중 (${backgroundParts(waiting, left).join(', ')})`
      : waiting > 0
        ? `${text} · 도우미 ${waiting}명은 아직 일하는 중`
        : text
  // The desktop app has no terminal to notify through (`no-surface`), and a bell shows no words.
  const sent = await $.ui.notify(full, { title: 'Claude Code' }).catch(() => undefined)
  if (sent === undefined || !sent.isSent || sent.channel === 'terminal_bell') {
    $.ui.toast(full, { timeoutMs: 10_000 })
  }
}

const endMainTurn = async ($: EngineInterface, e: TurnCompleteInput) => {
  const phase: Phase = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error'
  const stopReason: Work['stopReason'] = e.reason === 'refusal' ? 'refusal' : e.reason === 'error' ? 'error' : ''
  await update($, work, w => ({ ...w, phase, durationMs: e.durationMs, running: [], stopReason }))
  if (phase !== 'aborted' && e.durationMs >= ANNOUNCE_AFTER_MS) {
    const text = phase === 'done' ? `작업이 끝났어요 (${elapsed(e.durationMs)} 걸림)` : '작업이 멈췄어요'
    $.clock.after(2000, () => void announceEnd($, text))
  }
}

const openCall = async ($: EngineInterface, e: ToolCallInput): Promise<Pick<RunningTool, 'id' | 'startedAt'>> => {
  const startedAt = await $.clock.now()
  const tool = String(e.tool)
  const call: RunningTool = {
    id: e.tool_use_id ?? `${tool}@${startedAt}`,
    tool,
    ...describeTool(tool, e),
    startedAt,
    askedAt: null,
  }
  await update($, work, w => (w.phase === 'working' ? { ...w, tools: w.tools + 1, running: [...w.running, call] } : w))
  return { id: call.id, startedAt }
}

const closeCall = async ($: EngineInterface, id: string) => {
  await update($, work, w => ({ ...w, running: w.running.filter(one => one.id !== id) }))
}

const dropTasks = async ($: EngineInterface, ids: readonly string[]) => {
  if (ids.length > 0) await update($, tasks, list => (list.some(task => ids.includes(task.id)) ? list.filter(task => !ids.includes(task.id)) : list))
}

// A settled call may have left work in the background, or stopped some: its record says which.
const noteCall = async ($: EngineInterface, e: ToolCallInput, result: ToolCallResult, startedAt: number | undefined) => {
  if (result.deny !== undefined || result.isError === true) return
  const tool = String(e.tool)
  const stopped = stoppedTaskId(tool, result.result)
  if (stopped !== null) return dropTasks($, [stopped])
  // A helper's background work is the helper's: its notification goes to the helper, so it shows from a stop's snapshot.
  if (e.agentId !== undefined) return
  const now = await $.clock.now()
  const task = taskFromCall(tool, e, result.result, startedAt ?? now, now)
  if (task !== null) await update($, tasks, list => [...list.filter(one => one.id !== task.id), task].slice(-MAX_TASKS))
}

// The main loop stopped and listed what is still in flight: the source of truth for what ended unannounced.
const applySnapshot = async ($: EngineInterface, snapshot: readonly TaskSnapshot[] | undefined) => {
  if (snapshot === undefined) return
  const at = await $.clock.now()
  await update($, tasks, list => reconcileTasks(list, snapshot, at))
}

// A prompt the person must answer: the main loop's call it belongs to, or a helper's ask.
const markAsked = async ($: EngineInterface, agentId: string | undefined, tool: string, input: unknown) => {
  const at = await $.clock.now()
  const { label, detail } = describeTool(tool, input)
  if (agentId !== undefined) {
    await update($, helperAsks, list => [...list, { agentId, tool, label, detail, at }].slice(-20))
    return
  }
  await update($, work, w => {
    const open = w.running.filter(one => one.askedAt === null && one.tool === tool)
    const target = open.find(one => one.detail === detail) ?? open[0]
    return target === undefined
      ? w
      : { ...w, running: w.running.map(one => (one.id === target.id ? { ...one, askedAt: at } : one)) }
  })
}

// The prompt carries no call id, so a settled call lets go of the one ask with its own words: a
// helper's other call of the same tool may still be asking.
const dropHelperAsk = async ($: EngineInterface, agentId: string, tool: string, input: unknown) => {
  const { detail } = describeTool(tool, input)
  await update($, helperAsks, list => {
    const index = list.findIndex(ask => ask.agentId === agentId && ask.tool === tool && ask.detail === detail)
    return index === -1 ? list : [...list.slice(0, index), ...list.slice(index + 1)]
  })
}

const resetWork = async ($: EngineInterface) => {
  stopWorkTicker()
  await update($, work, () => IDLE_WORK)
  await update($, helpers, () => [])
  await update($, helperTurns, () => [])
  await update($, helperAsks, () => [])
  // What still runs comes back with the next stop's snapshot.
  await update($, tasks, () => [])
}

// After a reload mid-turn the stored status stands, and its ticker starts again.
const resumeWork = async ($: EngineInterface) => {
  const [w, known] = await Promise.all([read($, work), read($, helpers)])
  if (w.phase === 'working' || known.length > 0) startWorkTicker($)
}
// --- end of work status ------------------------------------------------------------------------

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

/** What pressing the button says while it is off. */
export const OFF_HINT = '답변이 끝나면 압축할 수 있어요'
export const COMPACTING_HINT = '압축하는 중이에요'

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

  // The button while it is off: a press only says why.
  on('ui.press', { plugin: 'usage-mods', element: 'compact-off' }, async ($, e) => {
    $.ui.toast((await read($, isCompacting)) ? COMPACTING_HINT : OFF_HINT)
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
    await quietly(resumeWork($))
    return result
  })

  // A /clear or a resume starts the conversation over: no turn of it has run yet.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await quietly(resetWork($))
    }
    return next(e)
  })

  // What the main loop runs now, for the status rows; a helper's call settling lets go of its ask.
  // A settled call's record also says what it left running in the background, or stopped.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const { agentId } = e
      try {
        const result = await next(e)
        await quietly(noteCall($, e, result, undefined))
        return result
      } finally {
        await quietly(dropHelperAsk($, agentId, String(e.tool), e))
      }
    }
    const opened = await openCall($, e).catch(() => undefined)
    try {
      const result = await next(e)
      // Timed from the call's start: one moved to the background by Ctrl+B or its timeout ran before it returned.
      await quietly(noteCall($, e, result, opened?.startedAt))
      return result
    } finally {
      if (opened !== undefined) {
        await quietly(closeCall($, opened.id))
      }
    }
  })

  // Raised before the permission prompt shows. A hook beneath may decide it, and then nobody is asked.
  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)
    if (result.decision === undefined) {
      await quietly(markAsked($, e.agent_id, e.tool_name, e.tool_input))
    }
    return result
  })

  // A helper's call has run (or failed): its prompt, if it had one, was answered.
  on('classic.PostToolUse', async ($, e, next) => {
    if (e.agent_id !== undefined) {
      await quietly(dropHelperAsk($, e.agent_id, e.tool_name, e.tool_input))
    }
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    if (e.agent_id !== undefined) {
      await quietly(dropHelperAsk($, e.agent_id, e.tool_name, e.tool_input))
    }
    return next(e)
  })

  // Each time the main loop stops it lists the session's background work still in flight: what
  // ended without a notification the band saw drops out here. Its result passes on untouched.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id === undefined) {
      await quietly(applySnapshot($, e.background_tasks))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e))
    return next(e)
  })

  // The plugin's own record of a running turn, beside the band's isWorking: the button is off while either says so.
  on('turn.start', async ($, e, next) => {
    // A helper's turn is not the main one: turn.complete clears this for the main loop alone.
    if (e.agentId === undefined) {
      await update($, isTurnRunning, () => true)
    }
    if (waiting !== null) {
      trace($, `turn started while /compact waits: ${describePrompt(e.text)}`)
    }
    await quietly(e.agentId === undefined ? startMainTurn($) : startHelperTurn($, e.agentId))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, isTurnRunning, () => false)
      if (waiting !== null) {
        trace($, `turn ended (${e.reason}) while /compact waits`)
      }
      await quietly(endMainTurn($, e))
    } else {
      await quietly(endHelperTurn($, e.agentId))
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

  // A background task's notification says which tasks ended. The rest is trace only: what became of
  // a /compact, the band's or typed, and of prompts sent while it waits.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      await quietly(dropTasks($, endedTaskIds(e.text)))
    }
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
    if (e.props.hasSurvey) {
      return next(e)
    }
    const [u, w, helperIds, asks, pulse, background] = await Promise.all([
      read($, usage),
      read($, work),
      read($, helpers),
      read($, helperAsks),
      read($, beat),
      read($, tasks),
    ])
    const isBusy = e.props.isWorking || w.phase === 'working' || helperIds.length > 0 || background.length > 0
    const hasReset = u !== null && u.limits.some(l => l.resetsAt !== undefined)
    // A turn's start sets the clock, so only the countdown ever needs to ask for the time.
    const stored = hasReset || isBusy ? await read($, clockNow) : 0
    const now = stored || (hasReset ? await $.clock.now() : 0)
    const status = statusRows({
      work: w,
      isWorking: e.props.isWorking,
      now,
      beat: pulse,
      helpers: helperIds.length,
      helperAsks: asks,
      isViewingHelper: e.props.view.agentId !== undefined,
      tasks: background,
    })
    if (u === null && status.length === 0) {
      return next(e)
    }
    lastIsWorking = e.props.isWorking // compaction trace

    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table

    // The work status sits above the meters, one row a line, each cut at the band's edge.
    const statusBox =
      status.length === 0 ? null : (
        <Box key="status" flexDirection="column">
          {status.map(row => (
            <Text {...(row.tone === 'dim' ? { dimColor: true } : { color: row.tone })} bold={row.bold} wrap="truncate-end">
              {row.text}
            </Text>
          ))}
        </Box>
      )
    if (u === null) {
      return <Box flexDirection="column">{statusBox}</Box>
    }

    const rows = meters(u)
    const reset = weeklyReset(u, now)
    const cost = costText(u)
    const compacting = await read($, isCompacting)
    const turnRunning = await read($, isTurnRunning)
    const isEnabled = canCompact(u, e.props.isWorking || turnRunning, compacting)
    // The terminal draws the bar in block glyphs; elsewhere they show seams and a dotted track.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined

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
      // The weekly countdown sits beside the 7-day bar it belongs to.
      const after = m.key === 'seven_day' ? reset : null
      return (
        <Box key={m.key} flexDirection="row" alignItems="center" marginRight={2}>
          <Text dimColor>{m.label} </Text>
          <Box key={`${m.key}-bar`}>
            {Svg === undefined ? (
              <Text color={color}>{bar(m.percent)}</Text>
            ) : (
              <Svg source={barSvg(m.percent, color)} alt={`${m.label} ${m.percent}%`} {...BAR_PX} />
            )}
            <Box position="absolute" top={0} left={0} display="none" hover={{ display: 'flex' }}>
              {hoverCard(m, color)}
            </Box>
          </Box>
          {after === null ? null : <Text dimColor> {after}</Text>}
        </Box>
      )
    }

    // meters() always leads with the context meter.
    const [context, ...limits] = rows as [Meter, ...Meter[]]

    const meterRow = (
      <Box key="usage" flexDirection="row">
        {meter(context)}
        <Box key="compact-slot" marginRight={2}>
          {isEnabled ? (
            <Button key="compact" label="압축" onPress={() => startCompact($)} />
          ) : (
            // Off, the same button drawn dim, so the band keeps one look on every surface.
            <Button
              key="compact-off"
              label={compacting ? '압축 중…' : '압축'}
              dimColor
              onPress={() => $.ui.toast(compacting ? COMPACTING_HINT : OFF_HINT)}
            />
          )}
        </Box>
        {limits.map(meter)}
        {cost === null ? null : (
          <Box key="usd" marginRight={2}>
            <Text dimColor>{cost}</Text>
          </Box>
        )}
      </Box>
    )

    return statusBox === null ? (
      meterRow
    ) : (
      <Box flexDirection="column">
        {statusBox}
        {meterRow}
      </Box>
    )
  })
}
