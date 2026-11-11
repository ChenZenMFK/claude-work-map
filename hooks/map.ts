// What the map knows: which station an action belongs to, what to call it, and the activity list. The page draws the map.
// Nothing here touches the engine.
import type { Board, Entry, StationId } from '../types'
import { stringsFor } from './text'
import type { Strings } from './text'

// ---- stations ---------------------------------------------------------------------------------

export const STATIONS: { id: StationId; icon: string }[] = [
  { id: 'you', icon: `${ring(0, -3.6, 3.4)}M-6.5 8c0-4 3-6.2 6.5-6.2s6.5 2.2 6.5 6.2` },
  { id: 'model', icon: 'M-5 -5h10v10h-10zM-2 -8.5v3.5M2 -8.5v3.5M-2 5v3.5M2 5v3.5M-8.5 -2h3.5M-8.5 2h3.5M5 -2h3.5M5 2h3.5' },
  { id: 'memory', icon: `M-5 4.5L0 -5L6 3.5M-5 4.5L6 3.5${ring(-5, 4.5, 2.1)}${ring(0, -5, 2.1)}${ring(6, 3.5, 2.1)}` },
  { id: 'files', icon: 'M-5.5 -8h7.5l3.5 3.5v12.5h-11zM2 -8v3.5h3.5' },
  { id: 'shell', icon: 'M-7.5 -5l5 5l-5 5M0 6h7.5' },
  { id: 'web', icon: `${ring(0, 0, 7.8)}M-7.8 0h15.6M0 -7.8c-4.2 4.2 -4.2 11.4 0 15.6M0 -7.8c4.2 4.2 4.2 11.4 0 15.6` },
  { id: 'browser', icon: 'M-8.5 -6.5h17v13h-17zM-8.5 -2.8h17M-6.3 -4.7h.1M-3.8 -4.7h.1' },
  { id: 'agents', icon: `M0 -4v3.5M0 -.5L-6 4M0 -.5L6 4${ring(0, -6, 2.1)}${ring(-6.5, 5.5, 2.1)}${ring(6.5, 5.5, 2.1)}` },
  { id: 'skills', icon: 'M1.5 -8.5L-5.5 1h4.5l-1.5 7.5l7.5 -9.8h-4.5z' },
  { id: 'hooks', icon: `M2.5 -5.5v8a4.2 4.2 0 1 1 -8.4 0v-1.5${ring(2.5, -7.3, 1.8)}` },
]

function ring(x: number, y: number, r: number): string {
  return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`
}

// ---- what the person set -----------------------------------------------------------------------

/** The mod's options made ready to use. Whatever is missing or malformed counts as not set. */
export type Setup = {
  t: Strings
  core: string
  memoryServers: ReadonlySet<string>
  memoryCommands: readonly string[]
  /** The words after a memory command that may be shown. Any other word could be content. */
  memorySubcommands: ReadonlySet<string>
  memoryPaths: readonly string[]
  memoryLabels: ReadonlyMap<string, string>
  hookRecords: boolean
  /** Whether the first line of a hook's refusal is shown. Off, the row names only the tool. */
  hookReasons: boolean
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(x => String(x).trim()).filter(x => x !== '')

export function setupFrom(options: Readonly<Record<string, unknown>> = {}): Setup {
  const memoryLabels = new Map<string, string>()
  for (const pair of list(options.memoryLabels)) {
    const at = pair.indexOf('=')
    if (at > 0 && at < pair.length - 1) memoryLabels.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
  const core = typeof options.coreName === 'string' ? options.coreName.trim().slice(0, 10) : ''
  return {
    t: stringsFor(options.language),
    core: core === '' ? 'CLAUDE' : core,
    memoryServers: new Set(list(options.memoryServers)),
    memoryCommands: list(options.memoryCommands),
    memorySubcommands: new Set(list(options.memorySubcommands)),
    memoryPaths: list(options.memoryPaths),
    memoryLabels,
    hookRecords: options.hookRecords === true,
    hookReasons: options.hookReasons === true,
  }
}

// ---- classification ---------------------------------------------------------------------------

export type Classified = { station: StationId; label: string }

/** A path with Windows separators written as `/`, so that one rule reads paths from every system. */
const slashes = (path: string): string => path.replace(/\\/g, '/')

const lastTwo = (path: string): string => slashes(path).split('/').filter(Boolean).slice(-2).join('/')

const HOST = /^(?:[\p{L}\p{N}.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/iu

/**
 * Only the host: a login, a password, a path or a query never reach a label.
 * A password may hold `/`, `?` or `#` unencoded, so the first of them is not always where the host ends:
 * `user:pa/ss@host` reads as the host `host`, and an address that can be read both ways gives its scheme alone.
 */
function hostOf(url: string): string {
  const [, scheme = '', rest = ''] = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(.*)$/is.exec(url) ?? []
  const end = rest.search(/[/?#]/)
  const first = end < 0 ? rest : rest.slice(0, end)
  const beyond = end < 0 ? '' : rest.slice(end)
  let host = first.split('@').pop() ?? ''
  if (!first.includes('@') && first.includes(':') && beyond.includes('@')) {
    // `name:word` before an `@` further on: a port if the word is a number, or else a login and a password.
    host = /:\d+$/.test(first) ? '' : (rest.slice(rest.lastIndexOf('@') + 1).split(/[/?#]/)[0] ?? '')
  }
  return HOST.test(host) ? host.slice(0, 40) : scheme
}

/** A label as it may be shown: no control characters, which a terminal would act on, and no direction marks. */
export function clean(label: string, max = 120): string {
  const text = label.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Claude Code's own memory folder counts for everyone; anything else is the person's to name. */
const isMemoryPath = (path: string, setup: Setup): boolean => {
  const p = slashes(path)
  return /\/\.claude\/projects\/[^/]+\/memory\//.test(p) || setup.memoryPaths.some(part => p.includes(slashes(part)))
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Commands that work on files and nothing else: they read, search, move or edit them in place. echo, cd and the like say nothing either way. */
const FILE_WORDS = new Set(['cat', 'head', 'tail', 'sed', 'grep', 'rg', 'find', 'ls', 'wc', 'cp', 'mv', 'mkdir', 'touch', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'awk', 'tee', 'stat', 'file', 'du', 'tree', 'ln', 'basename', 'dirname', 'realpath', 'jq'])
const NEUTRAL_WORDS = new Set(['echo', 'printf', 'cd', 'export', 'true', 'set', 'pwd', 'sleep', 'which', 'test', '['])
const NET_WORDS = new Set(['curl', 'wget', 'gh', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'nc', 'ncat', 'telnet', 'ping', 'dig', 'nslookup'])
/** Commands that reach the network only with some of their subcommands. */
const NET_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote']),
  npm: new Set(['install', 'i', 'ci', 'add', 'update', 'publish', 'view', 'audit']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'publish']),
  yarn: new Set(['install', 'add', 'upgrade', 'publish']),
  bun: new Set(['install', 'add', 'update', 'publish']),
  pip: new Set(['install', 'download']),
  pip3: new Set(['install', 'download']),
  docker: new Set(['pull', 'push', 'login']),
  brew: new Set(['install', 'update', 'upgrade', 'fetch']),
  cargo: new Set(['install', 'fetch', 'publish', 'update']),
}
const RUNNERS = new Set(['python', 'python3', 'bash', 'sh', 'zsh', 'node'])

// PowerShell's own names for the same three kinds of command, in lower case: PowerShell does not tell cases apart.
const PS_FILE_WORDS = new Set(['get-content', 'gc', 'type', 'set-content', 'add-content', 'out-file', 'get-childitem', 'gci', 'dir', 'get-item', 'gi', 'select-string', 'sls', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'rename-item', 'rni', 'ren', 'new-item', 'ni', 'md', 'test-path', 'resolve-path', 'get-filehash'])
const PS_NEUTRAL_WORDS = new Set(['write-host', 'write-output', 'set-location', 'sl', 'get-location', 'gl', 'start-sleep', 'select-object', 'select', 'where-object', 'where', '?', 'foreach-object', 'foreach', '%', 'sort-object', 'measure-object', 'measure', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'out-null'])
const PS_NET_WORDS = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'test-connection', 'test-netconnection', 'resolve-dnsname', 'start-bitstransfer'])

/**
 * The words of each command in a shell line, leading assignments taken off. Quotes stay: a quoted word is an argument.
 * `deep` also cuts at `$(…)`, backticks and brackets, to find a command run inside another; the pieces around it are then no commands.
 */
function segments(command: string, deep = false): string[][] {
  return command
    .split(deep ? /&&|\|\||;|\||\n|\$\(|`|\(|\)/ : /&&|\|\||;|\||\n/)
    // Cut at spaces outside quotes, so that "C:\Program Files\Git\cmd\git.exe" stays one word.
    .map(part => part.match(/(?:[^\s"']|"[^"]*"?|'[^']*'?)+/g) ?? [])
    .map(words => {
      let i = 0
      while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i] ?? '')) i++
      return words.slice(i)
    })
    .filter(words => words.length > 0)
}

/**
 * A command's own name: no quotes and no folder before it. A Windows program loses `.exe`, `.cmd` or `.bat` and its
 * capitals with it, since Windows does not tell `CURL.EXE` from `curl`; any other name keeps its case.
 */
const base = (word = ''): string => {
  const name = slashes(word.replace(/["']/g, '')).split('/').pop() ?? word
  return /\.(?:exe|cmd|bat)$/i.test(name) ? name.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase() : name
}

/** A script's name without its ending: `recall-sync.py` is `recall-sync`. */
const stem = (name: string): string => name.replace(/\.[a-z0-9]+$/i, '')

/** A name is the command itself or begins with it and a separator: `recall` names `recall-sync.py`, never `recallable`. */
const named = (name: string, command: string): boolean => {
  const s = stem(name)
  return s === command || (s.startsWith(command) && /^[-_.]/.test(s.slice(command.length)))
}

/** The name a memory command goes by: its own, or the word after it when the person listed that word as a subcommand. */
function memoryLabel(words: string[], setup: Setup): string {
  const head = base(words[0])
  if (!setup.memoryCommands.includes(head)) return stem(base(RUNNERS.has(head) && words[1] ? words[1] : words[0]))
  const sub = words[1] ?? ''
  return setup.memorySubcommands.has(sub) ? sub : head
}

/** The line of a shell tool. `powershell` adds PowerShell's own command names and reads every name in lower case. */
function classifyShell(command: string, description: string, setup: Setup, powershell = false): Classified {
  const name = (word?: string): string => (powershell ? base(word).toLowerCase() : base(word))
  // PowerShell runs a quoted path with `&` and keeps results in `$name = ...`: neither is the command.
  const own = (words: string[]): string[] => {
    if (!powershell) return words
    let i = 0
    if (/^\$[\w:]+$/.test(words[0] ?? '') && words[1] === '=') i = 2
    if (words[i] === '&' || words[i] === '.') i++
    return words.slice(i)
  }
  const lines = segments(command).map(own).filter(words => words.length > 0)
  const label = description.trim() || base(lines[0]?.[0] ?? 'shell')
  for (const words of lines) {
    const head = name(words[0])
    const script = RUNNERS.has(head) && words[1] ? base(words[1]) : ''
    if (setup.memoryCommands.some(c => named(head, c) || named(script, c))) {
      return { station: 'memory', label: memoryLabel(words, setup) }
    }
  }
  for (const words of segments(command, true).map(own)) {
    const head = name(words[0])
    const sub = words[1] ?? ''
    if (NET_WORDS.has(head) || (powershell && PS_NET_WORDS.has(head)) || NET_SUBCOMMANDS[head]?.has(sub) === true) return { station: 'web', label }
  }
  const isNeutral = (head: string): boolean => NEUTRAL_WORDS.has(head) || (powershell && PS_NEUTRAL_WORDS.has(head))
  const isFile = (head: string): boolean => FILE_WORDS.has(head) || (powershell && PS_FILE_WORDS.has(head))
  const real = lines.filter(words => !isNeutral(name(words[0])))
  if (real.length > 0 && real.every(words => isFile(name(words[0])))) {
    return { station: isMemoryPath(command, setup) ? 'memory' : 'files', label }
  }
  return { station: 'shell', label }
}

export function classify(tool: string, input: Record<string, unknown>, setup: Setup): Classified {
  const { t } = setup
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const path = str(input.file_path) || str(input.notebook_path)
      return { station: isMemoryPath(path, setup) ? 'memory' : 'files', label: lastTwo(path) || tool }
    }
    case 'Grep':
    case 'Glob':
      return { station: 'files', label: tool }
    case 'Bash':
      return classifyShell(str(input.command), str(input.description), setup)
    case 'PowerShell':
      return classifyShell(str(input.command), str(input.description), setup, true)
    case 'WebFetch':
      return { station: 'web', label: hostOf(str(input.url)) }
    case 'WebSearch':
      return { station: 'web', label: t.webSearch }
    case 'Artifact':
      return { station: 'web', label: t.artifact }
    case 'Agent':
      return { station: 'agents', label: str(input.description) || t.subagent }
    case 'Workflow':
      return { station: 'agents', label: t.workflow }
    case 'SendMessage':
    case 'TaskStop':
      return { station: 'agents', label: tool }
    case 'Skill':
      return { station: 'skills', label: str(input.skill) || t.skill }
    case 'ToolSearch':
      return { station: 'skills', label: t.loadingTools }
    case 'AskUserQuestion':
      return { station: 'you', label: t.questionForYou }
    case 'SendUserFile':
      return { station: 'you', label: t.fileForYou }
  }
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(tool)
  if (mcp === null) return { station: 'shell', label: tool }
  const [, server = '', name = ''] = mcp
  if (setup.memoryServers.has(server)) {
    // A number, or a short identifier: a longer string under `id` could be anything.
    const id = typeof input.id === 'number' || (typeof input.id === 'string' && /^[\w-]{1,24}$/.test(input.id)) ? ` #${input.id}` : ''
    return { station: 'memory', label: (setup.memoryLabels.get(name) ?? name.replace(/_/g, ' ')) + id }
  }
  if (server === 'Claude_Browser' || server === 'claude-in-chrome') {
    const url = str(input.url)
    return { station: 'browser', label: url && /^[a-z]+:/i.test(url) ? hostOf(url) : name.replace(/_/g, ' ') }
  }
  if (server === 'terminal') return { station: 'shell', label: name.replace(/_/g, ' ') }
  if (server === 'visualize' || server.startsWith('ccd_')) return { station: 'you', label: name.replace(/_/g, ' ') }
  if (server === 'plugin-authoring') return { station: 'skills', label: name.replace(/_/g, ' ') }
  return { station: 'web', label: `${server}: ${name.replace(/_/g, ' ')}` }
}

/** `claude-opus-5-5` reads as `opus 5.5`. */
export function shortModel(model: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  return m === null ? model : `${m[1]} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`
}

export function formatMs(ms: number, t: Strings): string {
  return ms < 1000 ? t.ms(Math.max(1, Math.round(ms))) : ms < 60000 ? t.seconds((ms / 1000).toFixed(1)) : t.minutes(Math.floor(ms / 60000), Math.round((ms % 60000) / 1000))
}

/** The first line of a hook's refusal, cut short: the lines after it may repeat the whole command. */
export function firstLine(text: string, max = 72): string {
  const line = (text.split('\n').find(l => l.trim() !== '') ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The record numbers a memory hook put in front of the model: `[#123`, `[now #123`, `[todo #123`. */
export function memoryIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(?:[a-z]+ )?#(\d+)/g)].map(m => m[1] ?? ''))]
}

// ---- how long a node stays on the page ---------------------------------------------------------

/** How long a station or a finished subagent stays after its last use, then how long it takes to fade. */
export const LIFE_MS = 120_000
export const FADE_MS = 1500

// ---- the feed ---------------------------------------------------------------------------------

/** A row of the feed: one entry, or several finished ones in a row at one station, shown as the newest of them. */
export type Row = { entry: Entry; times: number; tookMs: number }

const isPlain = (e: Entry): boolean => e.status === 'ok' && e.mark === undefined

/** The newest rows first. Finished calls that follow one another at one station fold into a single row. */
export function foldRows(entries: readonly Entry[], max = 16): Row[] {
  const rows: Row[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e === undefined) continue
    const took = e.endedAt === undefined ? 0 : Math.max(0, e.endedAt - e.startedAt)
    const last = rows[rows.length - 1]
    if (last !== undefined && isPlain(e) && isPlain(last.entry) && last.entry.station === e.station && last.entry.from === e.from) {
      last.times++
      last.tookMs += took
      continue
    }
    if (rows.length === max) break
    rows.push({ entry: e, times: 1, tookMs: took })
  }
  return rows
}

export function describeNow(board: Board, t: Strings): string {
  const running = board.entries.filter(e => e.status === 'run')
  const context = board.context === undefined ? '' : ` · ${t.context} ${Math.round(board.context)}%`
  const top = running[running.length - 1]
  if (top === undefined) return `${t.idle}${context}`
  return `${t.stations[top.station]}: ${top.label}${running.length > 1 ? t.andMore(running.length - 1) : ''}${context}`
}
