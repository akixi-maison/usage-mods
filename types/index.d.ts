export type Usage = {
  contextPercent?: number
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  usd?: number
}

/** Where the main conversation's turn stands. */
export type Phase = 'idle' | 'working' | 'done' | 'aborted' | 'error'

/** A main-loop tool call that has started and not yet settled. */
export type RunningTool = {
  id: string
  tool: string
  /** Plain words for what it does (`명령 실행`). */
  label: string
  /** The file, command or query it works on, cut short; '' when none. */
  detail: string
  /** A tool that waits on the person by itself: a question, a plan to approve. */
  needsMe: boolean
  startedAt: number
  /** When a permission prompt was raised for it, else null. */
  askedAt: number | null
}

/** A permission prompt a subagent raised, until its call settles or it stops. */
export type HelperAsk = { agentId: string; tool: string; label: string; detail: string; at: number }

export type BackgroundKind = 'shell' | 'monitor' | 'workflow'

/** Background work running beside the conversation: a command, a monitor, a workflow run. */
export type BackgroundTask = {
  /** The task's id: the call's `backgroundTaskId` or `taskId`, or a stop snapshot's. */
  id: string
  kind: BackgroundKind
  /** Plain words for what it runs (`명령 실행`). */
  label: string
  /** The command, description or name, cut short; '' when none. */
  detail: string
  /** Epoch ms the call that started it began; 0 when known only from a snapshot. */
  startedAt: number
  /** Epoch ms a monitor's deadline passes; 0 when it has none. */
  endsBy: number
  /** Epoch ms the mod recorded it: a snapshot taken a moment earlier may not list it yet. */
  seenAt: number
}

export type Work = {
  phase: Phase
  /** Epoch ms the main turn started; 0 when not known. */
  startedAt: number
  /** The ended turn's length in ms. */
  durationMs: number
  /** Tool calls the main turn has started. */
  tools: number
  running: RunningTool[]
  /** Why a turn that stopped short stopped. */
  stopReason: '' | 'refusal' | 'error'
}

declare module 'claude-code' {
  interface PluginState {
    'usage-mods': {
      usage: Usage | null
      isCompacting: boolean
      isTurnRunning: boolean
      now: number
      work: Work
      /** Flips on each second tick while work runs: the blinking dot. */
      beat: boolean
      /** Ids of subagents seen at work (listed agents and agent turns alike). */
      helpers: string[]
      /** Ids of subagent loops whose turn started and has not ended. */
      helperTurns: string[]
      helperAsks: HelperAsk[]
      /** Background commands, monitors and workflow runs still at work, oldest first. */
      tasks: BackgroundTask[]
    }
  }
}
