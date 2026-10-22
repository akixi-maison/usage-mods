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
    }
  }
}
