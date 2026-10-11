export type Usage = {
  contextPercent?: number
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-mods': { usage: Usage | null; isCompacting: boolean; now: number }
  }
}
