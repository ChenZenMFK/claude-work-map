import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Crew, Entry, StationId, Status, Tokens } from '../types'
import { FADE_MS, LIFE_MS, STATIONS, classify, clean, describeNow, firstLine, foldRows, formatMs, memoryIds, setupFrom, shortModel, targetOf } from './map'
import type { Setup } from './map'

const PANE = 'work-map'
const KEEP = 80
const CREW = 12
/** Subagent maps kept on the board: every one still running, then the latest finished ones. */
const MINIS = 6

// Change the tag when a field of Entry or Board changes: it declines what an earlier version stored.
const board = atom({ plugin: 'work-map', key: 'board' } as const, { entries: [], counts: {} } as Board, { shape: 'work-map-board-1' })

/** Every change to the board goes through here, so the page hears of it. */
async function updateBoard($: EngineInterface, fn: (b: Board) => Board): Promise<void> {
  await update($, board, fn)
  changedBoard($)
}

/** Adds one model step's token counts to a running total. */
function addTokens(sum: Tokens | undefined, usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): Tokens {
  const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input: (sum?.input ?? 0) + n(usage.input_tokens),
    output: (sum?.output ?? 0) + n(usage.output_tokens),
    cacheRead: (sum?.cacheRead ?? 0) + n(usage.cache_read_input_tokens),
    cacheWrite: (sum?.cacheWrite ?? 0) + n(usage.cache_creation_input_tokens),
  }
}

/** The board's subagents with one changed or added, keeping every running one and the latest finished ones. */
function withCrew(b: Board, id: string, now: number, change: (c: Crew) => Crew): Board {
  const list = b.crew ?? []
  const known = list.find(c => c.id === id)
  const member = change(known ?? { id, type: 'subagent', task: '', startedAt: now, status: 'run', counts: {} })
  const next = known === undefined ? [...list, member] : list.map(c => (c === known ? member : c))
  const running = next.filter(c => c.status === 'run')
  const finished = next.filter(c => c.status !== 'run').slice(-Math.max(0, MINIS - running.length))
  return { ...b, crew: next.filter(c => running.includes(c) || finished.includes(c)) }
}

const newId = (now: number): string => `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Whatever goes wrong on the map must never reach the tool, the turn or the conversation. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

type Start = {
  station: StationId
  label: string
  target?: string
  from?: Entry['from']
  status?: Status
  agentId?: string
  mark?: Entry['mark']
  /** Adds nothing to the station's count: a second view of something already counted. */
  uncounted?: boolean
  startedAt?: number
  endedAt?: number
  patch?: Partial<Pick<Board, 'model' | 'step' | 'switchedAt'>>
}

const isFault = (status: Status): boolean => status === 'err' || status === 'block'

const oneMore = (faults: Board['faults'], station: StationId): Board['faults'] => ({ ...faults, [station]: (faults?.[station] ?? 0) + 1 })

async function begin($: EngineInterface, start: Start): Promise<string | undefined> {
  return quietly(async () => {
    const now = await $.clock.now()
    const entry: Entry = {
      id: newId(now),
      station: start.station,
      label: clean(start.label),
      from: start.from ?? 'core',
      startedAt: start.startedAt ?? now,
      status: start.status ?? 'run',
      ...(start.status !== undefined ? { endedAt: start.endedAt ?? now } : {}),
      ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
      ...(start.target !== undefined ? { target: clean(start.target, 60) } : {}),
      ...(start.mark !== undefined ? { mark: start.mark } : {}),
    }
    const ofAgent = entry.agentId
    await updateBoard($, b => ({
      ...(ofAgent === undefined
        ? b
        : withCrew(b, ofAgent, now, c => ({
            ...c,
            counts: start.uncounted ? c.counts : { ...c.counts, [entry.station]: (c.counts[entry.station] ?? 0) + 1 },
            ...(isFault(entry.status) ? { faults: (c.faults ?? 0) + 1 } : {}),
          }))),
      ...start.patch,
      entries: [...b.entries, entry].slice(-KEEP),
      counts: start.uncounted || ofAgent !== undefined ? b.counts : { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
      // What a hook brought to memory unasked is counted apart from what was asked for.
      ...(entry.station === 'memory' && entry.from === 'inbound' && !start.uncounted ? { pushed: (b.pushed ?? 0) + 1 } : {}),
      // An interrupted turn lands on the person's own station and is no fault of anything.
      ...(isFault(entry.status) && entry.station !== 'you' && ofAgent === undefined ? { faults: oneMore(b.faults, entry.station) } : {}),
      ...(entry.agentId !== undefined && !(b.agents ?? []).includes(entry.agentId)
        ? { agents: [...(b.agents ?? []), entry.agentId].slice(-CREW) }
        : {}),
    }))
    return entry.id
  })
}

async function finish($: EngineInterface, id: string | undefined, status: Status, patch?: Pick<Board, 'context'>): Promise<void> {
  if (id === undefined) return
  await quietly(async () => {
    const now = await $.clock.now()
    await updateBoard($, b => {
      const open = b.entries.find(e => e.id === id && e.status === 'run')
      const agentId = open?.agentId
      const base = agentId !== undefined && isFault(status) ? withCrew(b, agentId, now, c => ({ ...c, faults: (c.faults ?? 0) + 1 })) : b
      return {
        ...base,
        ...patch,
        entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
        ...(open !== undefined && agentId === undefined && isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
      }
    })
  })
}

/** How full the context window is, as the status line has it; costs nothing. */
async function contextOf($: EngineInterface): Promise<Pick<Board, 'context'>> {
  const percent = await quietly(async () => (await $.session.usage()).context.percent)
  return typeof percent === 'number' ? { context: percent } : {}
}

/** What a settings hook added to the context: shown as the hook acting and, when it brought records, as memory. */
async function noteContext($: EngineInterface, context: readonly string[] | undefined, when: string, setup: Setup): Promise<void> {
  const { t } = setup
  const text = (context ?? []).join('\n')
  if (text.trim() === '') return
  const ids = setup.hookRecords ? memoryIds(text) : []
  if (ids.length === 0) {
    await begin($, { station: 'hooks', label: t.addedContext(when), status: 'ok' })
    return
  }
  await begin($, { station: 'hooks', label: t.addedMemory(when), status: 'ok' })
  const shown = ids.slice(0, 6).map(id => `#${id}`).join(' ')
  await begin($, {
    station: 'memory',
    label: t.records(ids.length, `${shown}${ids.length > 6 ? ' …' : ''}`),
    from: 'inbound',
    status: 'ok',
  })
}

// ---- the page: a local server started with the session, fed by a state file -------------------

/** The options the page's words come from, set when the module registers. */
let pageSetup: Setup | undefined
let url: string | undefined
let starting: Promise<string | undefined> | undefined
let statePath: string | undefined
let saving = false
let again = false
const token = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('')

/** Where this session's state is saved: ~/.claude/work-map/<session>.json. */
async function pathOf($: EngineInterface): Promise<string> {
  if (statePath !== undefined) return statePath
  const home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
  const id = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '')
  statePath = `${home}/.claude/work-map/${id || 'session'}.json`
  return statePath
}

/** Writes what the page draws from: the board, the station names and icons, and the clock. */
async function save($: EngineInterface): Promise<void> {
  const setup = pageSetup
  if (setup === undefined) return
  const { t } = setup
  const state = await read($, board)
  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  await $.fs.write(
    await pathOf($),
    JSON.stringify({
      v: 1,
      savedAt: now,
      folder: cwd.split('/').filter(Boolean).pop() ?? '',
      coreName: setup.core,
      life: LIFE_MS,
      fade: FADE_MS,
      names: t.stations,
      stations: STATIONS.map(s => ({ id: s.id, icon: s.icon })),
      now: describeNow(state, t),
      board: state,
    }),
  )
}
/** Saves after each change; changes that come while a save is under way are saved together right after it. */
function changedBoard($: EngineInterface): void {
  if (saving) {
    again = true
    return
  }
  saving = true
  void (async () => {
    do {
      again = false
      await quietly(() => save($))
    } while (again)
    saving = false
  })()
}

/** Starts the page's server once; resolves its address, or undefined when it cannot start. */
function serve($: EngineInterface): Promise<string | undefined> {
  if (url !== undefined) return Promise.resolve(url)
  starting ??= (async () => {
    const state = await pathOf($)
    await quietly(() => save($))
    const run = $.process.spawn({
      argv: ['python3', '-I', `${$.plugin.root}/server/serve.py`, '--state', state, '--token', token, '--page', `${$.plugin.root}/page`],
    })[Symbol.asyncIterator]()
    let out = ''
    for (;;) {
      const piece = await run.next()
      if (piece.done || !('text' in piece.value)) return undefined
      out += piece.value.text
      const port = /PORT (\d+)/.exec(out)?.[1]
      if (port === undefined) continue
      url = `http://127.0.0.1:${port}/${token}/`
      // The server lives as long as this loop: keep reading until it ends, then forget it.
      void (async () => {
        try {
          while (!(await run.next()).done) {
            /* nothing to read: the server prints its port and nothing else */
          }
        } catch {
          /* the module unloaded */
        }
        url = undefined
        starting = undefined
      })()
      return url
    }
  })().catch(() => {
    starting = undefined
    return undefined
  })
  return starting
}

/** Opens the page in the person's browser. */
async function openPage($: EngineInterface): Promise<string | undefined> {
  const address = await serve($)
  if (address !== undefined) await quietly(() => $.process.run(['open', address]))
  return address
}

export const register: Register = (on, options) => {
  const setup = setupFrom(options)
  pageSetup = setup

  const { t } = setup
  // The feed's second column fits the longest station name of the language.
  const column = Math.max(8, ...Object.values(t.stations).map(name => name.length))

  // Calls a settings hook refused, so that the tool's own row reads as blocked and not as an error.
  // Loses nothing across a reload that matters: a reload never lands in the middle of a call.
  const refused = new Set<string>()

  // The model the main loop last ran on: in this session, or else in the last session in this folder.
  // The one thing the map keeps between sessions, and only its name.
  let lastModel: string | undefined
  let modelKey = 'model'

  on('session.start', async ($, e, next) => {
    await quietly(() => $.command.register({ name: 'work-map', description: 'Open the live work map in your browser' }))
    void quietly(() => $.ui.open({ id: PANE, title: t.title }))
    void quietly(() => serve($))
    await quietly(async () => {
      modelKey = `model:${e.cwd}`
      const kept = await $.store.get(modelKey)
      if (lastModel === undefined && typeof kept === 'string') lastModel = kept
    })
    return next(e)
  })

  on('command.run', { command: 'work-map' }, async $ => {
    void quietly(() => $.ui.open({ id: PANE, title: t.title }))
    const address = await openPage($)
    return { text: address === undefined ? 'The work map could not start: Python 3 is needed (python3).' : `Work map opened in your browser: ${address}` }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      // A new message clears what went wrong on the way to the last answer.
      await quietly(() => updateBoard($, b => (b.faults === undefined ? b : { ...b, faults: {} })))
      await begin($, { station: 'you', label: t.newMessage, from: 'inbound', status: 'ok' })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain && lastModel !== e.model) {
      const before = lastModel
      lastModel = e.model
      void quietly(() => $.store.set(modelKey, e.model))
      if (before !== undefined) {
        const now = await quietly(() => $.clock.now())
        await begin($, {
          station: 'model',
          label: `${shortModel(before)} → ${shortModel(e.model)}`,
          status: 'ok',
          mark: 'switch',
          uncounted: true,
          ...(now !== undefined ? { patch: { switchedAt: now } } : {}),
        })
      }
    }
    const id = await begin($, {
      station: 'model',
      label: `${shortModel(e.model)} · ${t.step(e.index + 1)}${isMain ? '' : ` · ${t.subagent}`}`,
      target: shortModel(e.model),
      from: isMain ? 'core' : 'agents',
      ...(isMain ? { patch: { model: e.model, step: e.index + 1 } } : { agentId: e.agentId }),
    })
    // A subagent's map names the model it actually runs on, which its own steps report.
    const stepAgent = e.agentId
    if (stepAgent !== undefined) {
      await quietly(async () => {
        const now = await $.clock.now()
        await updateBoard($, b => withCrew(b, stepAgent, now, c => (c.model === e.model ? c : { ...c, model: e.model })))
      })
    }
    try {
      const result = yield* next(e)
      // Each model step reports what it cost: added to its subagent, or to the main loop.
      const usage = result?.usage
      if (usage) {
        await quietly(async () => {
          const now = await $.clock.now()
          await updateBoard($, b => (stepAgent === undefined ? { ...b, tokens: addTokens(b.tokens, usage) } : withCrew(b, stepAgent, now, c => ({ ...c, tokens: addTokens(c.tokens, usage) }))))
        })
      }
      return result
    } finally {
      await finish($, id, 'ok', isMain ? await contextOf($) : undefined)
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's loop is over: it leaves the agents station, and a call of its that never reported back is settled.
      const agentId = e.agentId
      await quietly(async () => {
        const now = await $.clock.now()
        await updateBoard($, b => ({
          ...withCrew(b, agentId, now, c => ({ ...c, status: e.isAborted ? 'err' : 'ok', endedAt: now })),
          agents: (b.agents ?? []).filter(id => id !== agentId),
          entries: b.entries.map(x => (x.status === 'run' && x.agentId === agentId ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    } else {
      await begin($, {
        station: 'you',
        label: e.isAborted ? t.turnAborted : t.answerReady,
        status: e.isAborted ? 'err' : 'ok',
        ...(e.isAborted ? {} : { mark: 'done' as const }),
      })
      // An interrupted call never reports back; left alone its row would pulse for the rest of the session.
      await quietly(async () => {
        const now = await $.clock.now()
        await updateBoard($, b => ({
          ...b,
          entries: b.entries.map(x => (x.status === 'run' && x.from === 'core' ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await quietly(async () => {
      const agentId = spawned.deny === undefined ? spawned.agentId : undefined
      if (agentId === undefined) return
      const now = await $.clock.now()
      await updateBoard($, b =>
        withCrew(b, agentId, now, c => ({
          ...c,
          type: e.subagentType,
          task: clean(e.description, 60),
          model: spawned.model,
          ...(e.parentAgentId !== undefined ? { parent: e.parentAgentId } : {}),
          status: 'run',
          startedAt: e.resume === undefined ? now : c.startedAt,
        })),
      )
    })
    return spawned
  })

  on('tool.call', async ($, e, next) => {
    const id = await quietly(async () => {
      const seen = classify(e.tool, e as unknown as Record<string, unknown>, setup)
      const target = targetOf(e.tool, e as unknown as Record<string, unknown>, seen)
      return begin($, { ...seen, target, ...(e.agentId === undefined ? { from: 'core' as const } : { from: 'agents' as const, agentId: e.agentId }) })
    })
    try {
      const ran = await next(e)
      const wasRefused = ran.deny !== undefined || (e.tool_use_id !== undefined && refused.delete(e.tool_use_id))
      await finish($, id, wasRefused ? 'block' : ran.isError === true ? 'err' : 'ok')
      return ran
    } catch (failure) {
      await finish($, id, 'err')
      throw failure
    }
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const startedAt = (await quietly(() => $.clock.now())) ?? 0
    const decided = await next(e)
    const endedAt = (await quietly(() => $.clock.now())) ?? startedAt
    if (decided.deny !== undefined) {
      if (e.tool_use_id !== undefined) refused.add(e.tool_use_id)
      await begin($, { station: 'hooks', label: (setup.hookReasons ? firstLine(decided.deny) : '') || t.stopped(e.tool), status: 'block', startedAt })
    } else if (decided.ask !== undefined) {
      await begin($, { station: 'hooks', label: t.askedPermission(e.tool), status: 'ok', startedAt, endedAt })
    } else if (endedAt - startedAt >= 400) {
      // A check that took a moment is worth seeing; the instant ones are not.
      await begin($, { station: 'hooks', label: t.checkBefore(e.tool), status: 'ok', startedAt, endedAt })
    }
    return decided
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.toMessage, setup)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.atStart, setup)
    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    // A skill the model called is already on the map as its tool call; this one catches a typed slash command.
    await quietly(async () => {
      const now = await $.clock.now()
      await updateBoard($, b => {
        if (b.entries.some(x => x.station === 'skills' && x.status === 'run' && x.label === e.skill)) return b
        const entry: Entry = { id: newId(now), station: 'skills', label: e.skill, from: 'core', startedAt: now, endedAt: now, status: 'ok' }
        return { ...b, entries: [...b.entries, entry].slice(-KEEP), counts: { ...b.counts, skills: (b.counts.skills ?? 0) + 1 } }
      })
    })
    return result
  })

  on('session.compact', async ($, e, next) => {
    const id = await begin($, { station: 'model', label: t.compacting })
    try {
      return await next(e)
    } finally {
      await finish($, id, 'ok', await contextOf($))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, board)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const rows = foldRows(state.entries).map(({ entry, times, tookMs }) => {
      const isSwitch = entry.mark === 'switch'
      const mark = isSwitch ? '◆' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕'
      const took = entry.endedAt === undefined ? t.running : tookMs > 0 ? formatMs(tookMs, t) : ''
      // Theme keys, so the rows read on a light theme as well as on a dark one.
      const color = isSwitch || entry.status === 'run' ? 'claude' : entry.status === 'ok' ? undefined : 'error'
      const line = `${mark} ${entry.agentId === undefined ? '' : '↳ '}${t.stations[entry.station].padEnd(column)} ${entry.label}${times > 1 ? `  +${times - 1}` : ''}${took === '' ? '' : `  ${took}`}`
      return (
        <Text mono size="footnote" color={color} dimColor={entry.status === 'ok' && !isSwitch}>
          {line}
        </Text>
      )
    })
    const feed = rows.length > 0 ? rows : [<Text dimColor>{t.nothingYet}</Text>]
    const current = <Text mono size="footnote">{describeNow(state, t)}</Text>

    // The map itself is in the browser; the pane keeps the way there, what runs now, and the calls.
    const { Button } = $.ui.resolve(e)
    const opener = (
      <Box flexDirection="row" gap={1}>
        <Button key="open-map" label="Open map" hotkey="o" variant="primary" onPress={() => void openPage($)} />
        <Text dimColor size="footnote">{url === undefined ? 'starting the map…' : url}</Text>
      </Box>
    )
    if (e.surface === 'terminal') {
      const tally = STATIONS.filter(s => (state.counts[s.id] ?? 0) > 0).map(s => `${t.stations[s.id]} ${state.counts[s.id]}`).join(' · ')
      return (
        <Box flexDirection="column">
          {opener}
          {current}
          <Text dimColor>{tally === '' ? t.noCounts : tally}</Text>
          {feed}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        {opener}
        {current}
        {feed}
      </Box>
    )
  })
}
