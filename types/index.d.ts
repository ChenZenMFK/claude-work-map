export type StationId =
  | 'you' | 'model' | 'memory' | 'files' | 'shell'
  | 'web' | 'browser' | 'agents' | 'skills' | 'hooks'

export type Status = 'run' | 'ok' | 'err' | 'block'

/** One action on the map. Labels carry names and record numbers, never the text of a memory. */
export type Entry = {
  id: string
  station: StationId
  label: string
  /** Where the pulse starts: the core, the agents station, or the station itself (a signal coming in). */
  from: 'core' | 'agents' | 'inbound'
  startedAt: number
  endedAt?: number
  status: Status
  /** The subagent whose loop made the call; absent for the main loop. */
  agentId?: string
  /** A moment the map marks: the model changed, or the answer is ready. */
  mark?: 'switch' | 'done'
}

/** A subagent with a small map of its own, linked to the main map's agents station or to the subagent that started it. */
export type Crew = {
  id: string
  /** The agent type it was spawned as, such as Explore or general-purpose. */
  type: string
  /** The Agent call's short description of its task. */
  task: string
  /** The model it runs on, as its latest model step reported it. */
  model?: string
  /** The subagent that started it; absent when the main loop did. */
  parent?: string
  startedAt: number
  endedAt?: number
  status: 'run' | 'ok' | 'err'
  /** Its own calls per station; the main map's counts leave them out. */
  counts: Partial<Record<StationId, number>>
  faults?: number
}

export type Board = {
  entries: Entry[]
  counts: Partial<Record<StationId, number>>
  model?: string
  step?: number
  /** How many of the memory station's count a hook brought unasked. */
  pushed?: number
  /** Errors and refusals per station since the person's last message. */
  faults?: Partial<Record<StationId, number>>
  /** Subagents whose loops are still going. */
  agents?: string[]
  /** How full the context window is, 0 to 100. */
  context?: number
  /** When the model last changed. */
  switchedAt?: number
  /** Subagents drawn as maps of their own, running ones first kept. */
  crew?: Crew[]
}

declare module 'claude-code' {
  interface PluginState {
    'work-map': { board: Shaped<Board> }
  }
}
