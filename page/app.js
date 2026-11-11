// Work map: a live, draggable graph of what Claude is doing, fed by the work-map mod.
// The mod writes the session's state; the local server pushes each change here.
// Everything below runs in this page: physics, drawing, mouse. Nothing leaves this computer.
'use strict'

const LIFE_DEFAULT = 120_000
const FADE_DEFAULT = 1500
const POP_MS = 450
const PULSE_MS = 800
const GLOW_MS = 3200

const canvas = document.getElementById('map')
const ctx = canvas.getContext('2d')
const $ = id => document.getElementById(id)
const base = location.pathname.replace(/[^/]*$/, '')

/** The latest state from the mod, and how far its clock is from this page's. */
let state = null
let skew = 0
const now = () => Date.now() + skew

/** Nodes by id, kept across updates so positions and velocities carry on. */
const nodes = new Map()
let links = []
let heat = 1
let hovered = null
let selected = null
let dragging = null
const view = { x: 0, y: 0, k: 1 }
/** The view follows the graph until the person pans or zooms; Fit turns following back on. */
let follow = true
let frameCount = 0

// ---- colours, from the page's own theme ---------------------------------------------------------

let C = {}
function readColours() {
  const css = getComputedStyle(document.documentElement)
  for (const name of ['ground', 'raised', 'line', 'text', 'mute', 'dim', 'accent', 'hot', 'red', 'mem', 'opus', 'sonnet', 'haiku', 'fable']) C[name] = css.getPropertyValue(`--${name}`).trim()
}
readColours()
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readColours)

// ---- from the state to a graph --------------------------------------------------------------------

const endOf = (e, t) => (e.status === 'run' ? t : (e.endedAt ?? e.startedAt))
/** One stretch of use: first start to last end, gaps shorter than a lifetime joined. */
function spanOf(list, t, life) {
  let span = null
  for (const e of [...list].sort((a, b) => a.startedAt - b.startedAt)) {
    if (span === null || e.startedAt - span.last > life) span = { from: e.startedAt, last: endOf(e, t) }
    else span.last = Math.max(span.last, endOf(e, t))
  }
  return span
}
/** Each model family has a colour of its own: the core, a subagent's ring and its link wear it. */
const familyOf = m => /claude-([a-z]+)-/.exec(m || '')?.[1] ?? ''
const modelColour = m => C[familyOf(m)] || C.mute
const clip = (s, max = 16) => (s.length <= max ? s : `${s.slice(0, Math.ceil((max - 1) / 2))}…${s.slice(-Math.floor((max - 1) / 2))}`)
const tokensOf = k => (k ? k.input + k.output + k.cacheRead + k.cacheWrite : 0)
const fmtTokens = n => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`)
/** Stations opened to show where their calls went, by node id. */
const expanded = new Set()
const LEAVES = 8

const shortModel = m => {
  const x = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m || '')
  return x ? `${x[1]} ${x[2]}${x[3] ? `.${x[3]}` : ''}` : (m || '')
}

/** What should be on the map now: each node with its parent, its kind and how long it stays. */
function wanted(s, t) {
  const life = s.life ?? LIFE_DEFAULT
  const fade = s.fade ?? FADE_DEFAULT
  const board = s.board ?? { entries: [], counts: {} }
  const out = []
  const entries = board.entries ?? []
  const main = entries.filter(e => e.agentId === undefined)
  out.push({ id: 'core', kind: 'core', label: s.coreName || 'CLAUDE', sub: shortModel(board.model), from: -Infinity, until: Infinity })
  const crew = (board.crew ?? []).filter(m => {
    const last = m.status === 'run' ? t : (m.endedAt ?? t)
    return t < last + life + fade
  })
  for (const st of s.stations ?? []) {
    let span = spanOf(main.filter(e => e.station === st.id), t, life + fade)
    if (st.id === 'you') span = { from: -Infinity, last: Infinity }
    if (st.id === 'agents' && crew.length) {
      const from = Math.min(span?.from ?? Infinity, ...crew.map(m => m.startedAt))
      span = { from, last: Math.max(span?.last ?? -Infinity, ...crew.map(m => (m.status === 'run' ? t : m.endedAt ?? t))) }
    }
    if ((board.faults?.[st.id] ?? 0) > 0) span = { from: span?.from ?? -Infinity, last: Math.max(span?.last ?? -Infinity, t) }
    if (span && t < span.last + life + fade) {
      out.push({ id: `main:${st.id}`, kind: 'station', station: st.id, owner: null, parent: 'core', label: s.names?.[st.id] ?? st.id,
        count: board.counts?.[st.id] ?? 0, faults: board.faults?.[st.id] ?? 0, from: span.from, until: span.last + life })
    }
  }
  const crewIds = new Set(crew.map(m => m.id))
  for (const m of crew) {
    const parent = m.parent && crewIds.has(m.parent) ? `agent:${m.parent}` : 'main:agents'
    const until = m.status === 'run' ? Infinity : (m.endedAt ?? t) + life
    out.push({ id: `agent:${m.id}`, kind: 'agent', agent: m, parent, label: m.type, sub: shortModel(m.model), from: m.startedAt, until })
    const own = entries.filter(e => e.agentId === m.id)
    for (const st of s.stations ?? []) {
      if (st.id === 'you') continue
      const used = own.some(e => e.station === st.id) || (m.counts?.[st.id] ?? 0) > 0
      if (!used) continue
      const first = Math.min(...own.filter(e => e.station === st.id).map(e => e.startedAt), m.startedAt)
      out.push({ id: `agent:${m.id}:${st.id}`, kind: 'station', station: st.id, owner: m.id, parent: `agent:${m.id}`, label: s.names?.[st.id] ?? st.id,
        count: m.counts?.[st.id] ?? 0, faults: 0, from: Number.isFinite(first) ? first : m.startedAt, until })
    }
  }
  // An opened station shows where its calls went: one small node per target, the busiest first.
  for (const w of [...out]) {
    if (w.kind !== 'station' || !expanded.has(w.id)) continue
    const groups = new Map()
    for (const e of entries.filter(x => x.station === w.station && (x.agentId ?? null) === w.owner)) {
      const key = e.target || e.label
      const g = groups.get(key) ?? { key, calls: [], last: 0 }
      g.calls.push(e)
      g.last = Math.max(g.last, endOf(e, t))
      groups.set(key, g)
    }
    const sorted = [...groups.values()].sort((a, b) => b.calls.length - a.calls.length || b.last - a.last)
    for (const g of sorted.slice(0, LEAVES)) {
      out.push({ id: `leaf:${w.id}:${g.key}`, kind: 'leaf', station: w.station, owner: w.owner, parent: w.id, target: g.key, label: clip(g.key),
        count: g.calls.length, faults: g.calls.filter(e => e.status === 'err' || e.status === 'block').length, from: w.from, until: w.until })
    }
    if (sorted.length > LEAVES) {
      out.push({ id: `leaf:${w.id}:+more`, kind: 'leaf', more: true, station: w.station, owner: w.owner, parent: w.id, target: '',
        label: `+${sorted.length - LEAVES} more`, count: 0, faults: 0, from: w.from, until: w.until })
    }
  }
  return out
}

/** Brings the graph in line with the state: new nodes start beside their parent, old ones fade then leave. */
function sync() {
  if (!state) return
  const t = now()
  const fade = state.fade ?? FADE_DEFAULT
  const want = wanted(state, t)
  const ids = new Set(want.map(w => w.id))
  for (const w of want) {
    const n = nodes.get(w.id)
    if (n) Object.assign(n, w, { leaving: false })
    else {
      const p = nodes.get(w.parent) ?? { x: 0, y: 0 }
      const a = Math.random() * Math.PI * 2
      const r = w.kind === 'agent' ? 140 : w.parent === 'core' ? 110 : 50
      nodes.set(w.id, { ...w, x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, vx: 0, vy: 0, born: performance.now() })
      heat = Math.max(heat, 0.6)
    }
  }
  for (const [id, n] of nodes) {
    if (!ids.has(id) && !n.leaving) { n.leaving = true; n.leftAt = performance.now(); heat = Math.max(heat, 0.4) }
    if (n.leaving && performance.now() - n.leftAt > fade) { nodes.delete(id); heat = Math.max(heat, 0.5) }
  }
  links = [...nodes.values()].filter(n => n.parent && nodes.has(n.parent)).map(n => ({ a: nodes.get(n.parent), b: n }))
  if (selected && !nodes.has(selected.id)) closePanel()
  if (selected) fillPanel()
}

// ---- physics: nodes push apart, links pull together, the core sits in the middle ----------------

const radius = n => (n.kind === 'core' ? 30 : n.kind === 'agent' ? 22 : n.kind === 'leaf' ? 6 : n.owner ? 12 : 18)
// ---- forces the person can tune, as in Obsidian's graph settings --------------------------------

const DEFAULT_FORCES = { repel: 7000, gap: 34, distance: 1, strength: 0.04, centre: 1 }
/** Kept in this browser only; a blocked or private store just means the defaults. */
const forces = (() => {
  try { return { ...DEFAULT_FORCES, ...JSON.parse(localStorage.getItem('work-map-forces') || '{}') } } catch { return { ...DEFAULT_FORCES } }
})()
const FORMAT = { repel: v => String(Math.round(v)), gap: v => `${v} px`, distance: v => `${v.toFixed(2)}×`, strength: v => v.toFixed(3), centre: v => `${v.toFixed(1)}×` }
function showForces() {
  for (const key of Object.keys(DEFAULT_FORCES)) {
    $(key).value = String(forces[key])
    $(`out-${key}`).textContent = FORMAT[key](forces[key])
  }
}
for (const key of Object.keys(DEFAULT_FORCES)) {
  $(key).addEventListener('input', ev => {
    forces[key] = Number(ev.target.value)
    $(`out-${key}`).textContent = FORMAT[key](forces[key])
    heat = Math.max(heat, 0.8)
    try { localStorage.setItem('work-map-forces', JSON.stringify(forces)) } catch { /* not kept: fine */ }
  })
}
$('forces-reset').onclick = () => {
  Object.assign(forces, DEFAULT_FORCES)
  try { localStorage.removeItem('work-map-forces') } catch { /* nothing kept */ }
  showForces()
  heat = 1
}
function toggleForces() {
  const open = $('forces').hidden
  $('forces').hidden = !open
  $('forces-toggle').setAttribute('aria-expanded', String(open))
}
$('forces-toggle').onclick = toggleForces
showForces()

const rest = l => (l.b.kind === 'agent' ? 170 : l.b.kind === 'leaf' ? 52 : l.a.kind === 'core' ? 130 : 70) * forces.distance

/** Paused, nothing moves by itself; a node dragged by hand still goes where it is put. */
let paused = false
function setPaused(on) {
  paused = on
  $('pause').textContent = on ? 'Resume' : 'Pause'
  $('pause').setAttribute('aria-pressed', String(on))
  if (!on) heat = Math.max(heat, 0.5)
}
$('pause').onclick = () => setPaused(!paused)

function step() {
  if (paused || (heat < 0.003 && !dragging)) return
  const list = [...nodes.values()]
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]
      let dx = b.x - a.x, dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
      const d = Math.sqrt(d2)
      // Never closer than 30 px for the push, so nodes born together do not fling each other away.
      const f = (forces.repel * heat) / Math.max(d2, 900)
      // Room for the labels under each node, not just the circles.
      const min = radius(a) + radius(b) + forces.gap
      const push = d < min ? (min - d) * 0.25 : 0
      const fx = (dx / d) * (f + push), fy = (dy / d) * (f + push)
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy
    }
  }
  for (const l of links) {
    const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y
    const d = Math.max(1, Math.hypot(dx, dy))
    const f = (d - rest(l)) * forces.strength * heat
    const fx = (dx / d) * f, fy = (dy / d) * f
    l.a.vx += fx * 0.5; l.a.vy += fy * 0.5; l.b.vx -= fx; l.b.vy -= fy
  }
  for (const n of list) {
    const pull = (n.kind === 'core' ? 0.02 : 0.003) * forces.centre
    n.vx -= n.x * pull * heat
    n.vy -= n.y * pull * heat
    if (n === dragging) { n.vx = 0; n.vy = 0; continue }
    n.vx *= 0.82; n.vy *= 0.82
    // A speed limit keeps the graph calm whatever the forces add up to.
    const speed = Math.hypot(n.vx, n.vy)
    if (speed > 12) { n.vx *= 12 / speed; n.vy *= 12 / speed }
    n.x += n.vx; n.y += n.vy
  }
  heat *= dragging ? 1 : 0.994
}

// ---- drawing ---------------------------------------------------------------------------------------

const icons = new Map()
function icon(id) {
  if (!icons.has(id)) {
    const st = (state?.stations ?? []).find(s => s.id === id)
    icons.set(id, st ? new Path2D(st.icon) : null)
  }
  return icons.get(id)
}
const isNeighbour = (n, m) => n === m || n.parent === m.id || m.parent === n.id

function draw() {
  const dpr = devicePixelRatio || 1
  const w = canvas.clientWidth, h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr) }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = C.ground
  ctx.fillRect(0, 0, w, h)
  ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * (w / 2 + view.x), dpr * (h / 2 + view.y))
  const t = now()
  const p = performance.now()
  const focus = dragging ?? hovered
  const life = n => {
    const pop = Math.min(1, (p - (n.born ?? 0)) / POP_MS)
    const leave = n.leaving ? Math.max(0, 1 - (p - n.leftAt) / (state?.fade ?? FADE_DEFAULT)) : 1
    const timed = Number.isFinite(n.until) && t > n.until ? Math.max(0, 1 - (t - n.until) / (state?.fade ?? FADE_DEFAULT)) : 1
    return Math.min(pop, leave, timed)
  }
  const hoverDim = n => (focus && !isNeighbour(n, focus) && !(focus.kind !== 'station' && n.parent === focus.id) ? 0.16 : 1)
  // While searching, what matches stays bright and the rest steps back.
  const dim = n => Math.min(hoverDim(n), query && !matches.includes(n) ? 0.12 : 1)
  const entries = state?.board?.entries ?? []
  const callsOf = n => entries.filter(e => e.station === n.station && (e.agentId ?? null) === n.owner && (n.kind !== 'leaf' || (e.target || e.label) === n.target))
  const running = n => n.kind === 'station' || n.kind === 'leaf' ? callsOf(n).some(e => e.status === 'run')
    : n.kind === 'agent' ? n.agent.status === 'run' : entries.some(e => e.status === 'run' && e.agentId === undefined)

  // Links: a subagent's flows while it works.
  for (const l of links) {
    ctx.globalAlpha = Math.min(life(l.a), life(l.b)) * Math.min(dim(l.a), dim(l.b))
    ctx.strokeStyle = l.b.kind === 'agent' ? (running(l.b) ? modelColour(l.b.agent.model) : C.mute) : (l.b.station === 'memory' ? C.mem : C.line)
    ctx.lineWidth = l.b.kind === 'agent' ? 1.6 : 1 + Math.min(2.6, Math.log2(1 + (l.b.count ?? 0)) / 2.5)
    ctx.setLineDash(l.b.kind === 'agent' ? [4, 6] : [])
    ctx.lineDashOffset = l.b.kind === 'agent' && running(l.b) ? -(p / 40) % 20 : 0
    ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke()
  }
  ctx.setLineDash([])

  // Pulses: each call flies out to its station and back, as on the old map.
  for (const e of entries) {
    const owner = e.agentId ?? null
    const target = nodes.get(owner ? `agent:${owner}:${e.station}` : `main:${e.station}`)
    const from = nodes.get(owner ? `agent:${owner}` : 'core')
    if (!target || !from) continue
    const fly = (start, a, b, colour, r) => {
      const k = (t - start) / PULSE_MS
      if (k < 0 || k > 1) return
      ctx.globalAlpha = (1 - k * 0.6) * dim(target)
      ctx.fillStyle = colour
      ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, r, 0, Math.PI * 2); ctx.fill()
    }
    const bad = e.status === 'err' || e.status === 'block'
    fly(e.startedAt, from, target, bad ? C.red : e.station === 'memory' ? C.mem : C.hot, 4)
    if (e.endedAt) fly(e.endedAt, target, from, bad ? C.red : C.mute, 2.6)
  }

  // Nodes.
  for (const n of nodes.values()) {
    const r = radius(n) * (0.4 + 0.6 * Math.min(1, (p - (n.born ?? 0)) / POP_MS))
    const alpha = life(n) * dim(n)
    if (alpha <= 0.01) continue
    ctx.globalAlpha = alpha
    const run = running(n)
    const colour = n.faults > 0 ? C.red : n.kind === 'agent' ? modelColour(n.agent.model) : n.kind === 'core' ? modelColour(state?.board?.model) : n.station === 'memory' ? C.mem : C.accent
    const recent = (n.kind === 'station' || n.kind === 'leaf') && callsOf(n).some(e => t - endOf(e, t) < GLOW_MS)
    if (run || recent) {
      ctx.fillStyle = colour
      ctx.globalAlpha = alpha * (run ? 0.18 + 0.1 * Math.sin(p / 220) : 0.18 * (1 - Math.min(1, (t - Math.max(...callsOf(n).map(e => endOf(e, t)))) / GLOW_MS)))
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 9, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = alpha
    }
    ctx.fillStyle = C.raised
    const found = query && matches.includes(n)
    ctx.strokeStyle = n === selected || found ? C.text : run || n.kind === 'agent' || n.kind === 'core' ? colour : C.line
    ctx.lineWidth = n === selected ? 2.4 : found ? 2 : n.kind === 'core' ? 1.8 : 1.3
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()

    if (n.kind === 'core' && state?.board?.context !== undefined) {
      const full = Math.max(0, Math.min(100, state.board.context)) / 100
      ctx.strokeStyle = full >= 0.9 ? C.red : full >= 0.7 ? C.accent : C.mute
      ctx.lineWidth = 2.4
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 5, -Math.PI / 2, -Math.PI / 2 + full * Math.PI * 2); ctx.stroke()
    }
    if (n.kind === 'station') {
      const path = icon(n.station)
      if (path) {
        ctx.save(); ctx.translate(n.x, n.y); ctx.scale(r / 18, r / 18)
        ctx.strokeStyle = n.faults > 0 ? C.red : run || recent ? C.hot : C.mute
        ctx.lineWidth = 1.3 * (18 / r); ctx.lineCap = 'round'; ctx.lineJoin = 'round'
        ctx.stroke(path); ctx.restore()
      }
    }
    // Words: inside the core and a subagent, under a station or a target.
    ctx.textAlign = 'center'
    ctx.fillStyle = C.text
    if (n.kind === 'leaf') {
      ctx.fillStyle = n.faults > 0 ? C.red : run || recent ? C.hot : n.more ? C.dim : C.mute
      ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.55, 0, Math.PI * 2); ctx.fill()
      ctx.font = '9px "SF Mono", ui-monospace, Menlo, monospace'
      ctx.fillStyle = run || recent ? C.text : C.mute
      ctx.fillText(n.label, n.x, n.y + r + 10)
      if (n.count > 1) { ctx.fillStyle = C.dim; ctx.font = '8px "SF Mono", ui-monospace, Menlo, monospace'; ctx.fillText(`×${n.count}`, n.x, n.y + r + 19) }
      continue
    }
    if (n.kind === 'station') {
      // A small + says the station can open to show its targets; − that it is open.
      if (expanded.has(n.id) || n === hovered) {
        ctx.fillStyle = C.dim
        ctx.font = 'bold 10px "SF Mono", ui-monospace, Menlo, monospace'
        ctx.fillText(expanded.has(n.id) ? '−' : '+', n.x + r * 0.95, n.y - r * 0.7)
        ctx.fillStyle = C.text
      }
      ctx.font = `${n.owner ? 9.5 : 11.5}px "SF Mono", ui-monospace, Menlo, monospace`
      ctx.fillStyle = run || recent ? C.text : C.mute
      ctx.fillText(n.label, n.x, n.y + r + (n.owner ? 12 : 15))
      if (n.count > 0) { ctx.fillStyle = C.dim; ctx.font = `${n.owner ? 8.5 : 9.5}px "SF Mono", ui-monospace, Menlo, monospace`; ctx.fillText(String(n.count), n.x, n.y + r + (n.owner ? 23 : 28)) }
      if (n.faults > 0) { ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(n.x - r * 0.75, n.y - r * 0.75, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = C.ground; ctx.font = 'bold 9px ui-monospace, monospace'; ctx.fillText(String(n.faults), n.x - r * 0.75, n.y - r * 0.75 + 3) }
    } else {
      ctx.font = `${n.kind === 'core' ? 'bold 12px' : 'bold 9.5px'} "SF Mono", ui-monospace, Menlo, monospace`
      ctx.fillText(n.kind === 'core' ? n.label : n.label.length > 11 ? `${n.label.slice(0, 10)}…` : n.label, n.x, n.y + (n.sub ? -1 : 4))
      if (n.sub) { ctx.fillStyle = C.mute; ctx.font = `${n.kind === 'core' ? 10 : 8.5}px "SF Mono", ui-monospace, Menlo, monospace`; ctx.fillText(n.sub, n.x, n.y + (n.kind === 'core' ? 14 : 11)) }
      if (n.kind === 'agent') {
        const m = n.agent
        const took = Math.round(((m.endedAt ?? t) - m.startedAt) / 1000)
        ctx.fillStyle = m.status === 'err' ? C.red : C.mute
        ctx.font = '9px "SF Mono", ui-monospace, Menlo, monospace'
        const spent = tokensOf(m.tokens)
        ctx.fillText(`${m.status === 'run' ? 'running' : m.status === 'err' ? '✕' : '✓'} ${took}s${spent ? ` · ${fmtTokens(spent)} tokens` : ''}`, n.x, n.y + r + 13)
        if (m.task) { ctx.fillStyle = C.text; ctx.fillText(m.task.length > 30 ? `${m.task.slice(0, 29)}…` : m.task, n.x, n.y + r + 25) }
      }
    }
  }
  ctx.globalAlpha = 1
}

// ---- search: nodes by name, by a subagent's type, task or model, and by the calls behind a station --

let query = ''
let matches = []
let matchAt = -1
/** Everything a node can be found by. */
function haystack(n) {
  const entries = state?.board?.entries ?? []
  const own = n.kind === 'leaf' ? entries.filter(e => e.station === n.station && (e.agentId ?? null) === n.owner && (e.target || e.label) === n.target)
    : n.kind === 'station' ? entries.filter(e => e.station === n.station && (e.agentId ?? null) === n.owner)
    : n.kind === 'agent' ? entries.filter(e => e.agentId === n.agent.id) : []
  return [n.label, n.target, n.sub, n.agent?.type, n.agent?.task, n.agent?.model, ...own.map(e => `${e.label}\n${e.target ?? ''}`)].filter(Boolean).join('\n').toLowerCase()
}
function search(text) {
  query = text.trim().toLowerCase()
  matches = query ? [...nodes.values()].filter(n => !n.leaving && haystack(n).includes(query)) : []
  matchAt = -1
  $('found').textContent = query ? (matches.length ? `${matches.length} found` : 'none') : ''
  $('found').className = query && !matches.length ? 'found none' : 'found'
}
/** Goes to the next match: centres it, a little closer, and opens its details. */
function nextMatch(step = 1) {
  if (!matches.length) return
  matchAt = (matchAt + step + matches.length) % matches.length
  const n = matches[matchAt]
  follow = false
  view.k = Math.max(view.k, 1.2)
  view.x = -n.x * view.k
  view.y = -n.y * view.k
  openPanel(n)
  $('found').textContent = `${matchAt + 1} of ${matches.length}`
}
$('search').addEventListener('input', ev => search(ev.target.value))
$('search').addEventListener('keydown', ev => {
  if (ev.key === 'Enter') { ev.preventDefault(); nextMatch(ev.shiftKey ? -1 : 1) }
  if (ev.key === 'Escape') { ev.target.value = ''; search(''); ev.target.blur() }
})

function frame() {
  // New calls and new nodes join the search as they come.
  if (query && frameCount++ % 30 === 0) {
    const keep = matches[matchAt]
    matches = [...nodes.values()].filter(n => !n.leaving && haystack(n).includes(query))
    matchAt = keep ? matches.indexOf(keep) : -1
    if (matchAt < 0) $('found').textContent = matches.length ? `${matches.length} found` : 'none'
  }
  sync()
  step()
  ease()
  draw()
  requestAnimationFrame(frame)
}

// ---- view: fit, pan, zoom ---------------------------------------------------------------------------

/** Where the view should be to show every node, labels included. */
function target() {
  const list = [...nodes.values()].filter(n => !n.leaving)
  if (!list.length) return null
  const xs = list.map(n => n.x), ys = list.map(n => n.y)
  const minX = Math.min(...xs) - 90, maxX = Math.max(...xs) + 90, minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 80
  const w = canvas.clientWidth, h = canvas.clientHeight - 110
  const k = Math.max(0.2, Math.min(1.6, w / (maxX - minX), h / (maxY - minY)))
  return { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k + 8 }
}
function fit() {
  follow = true
  const to = target()
  if (to) Object.assign(view, to)
}
/** While following, the view eases towards the whole graph a little each frame. */
function ease() {
  if (!follow || dragging) return
  const to = target()
  if (!to) return
  view.k += (to.k - view.k) * 0.08
  view.x += (to.x - view.x) * 0.08
  view.y += (to.y - view.y) * 0.08
}
const toWorld = (cx, cy) => {
  const r = canvas.getBoundingClientRect()
  return { x: (cx - r.left - r.width / 2 - view.x) / view.k, y: (cy - r.top - r.height / 2 - view.y) / view.k }
}
function hit(cx, cy) {
  const q = toWorld(cx, cy)
  let best = null
  for (const n of nodes.values()) {
    if (n.leaving) continue
    const d = Math.hypot(n.x - q.x, n.y - q.y)
    if (d <= radius(n) + 6 && (!best || d < best.d)) best = { n, d }
  }
  return best?.n ?? null
}

let pan = null
let moved = false
canvas.addEventListener('pointerdown', ev => {
  canvas.setPointerCapture(ev.pointerId)
  moved = false
  const n = hit(ev.clientX, ev.clientY)
  if (n) { dragging = n; heat = Math.max(heat, 0.5) } else pan = { x: ev.clientX - view.x, y: ev.clientY - view.y }
  canvas.classList.add('dragging')
})
canvas.addEventListener('pointermove', ev => {
  if (dragging) {
    const q = toWorld(ev.clientX, ev.clientY)
    dragging.x = q.x; dragging.y = q.y; moved = true
    heat = Math.max(heat, 0.35)
  } else if (pan) {
    view.x = ev.clientX - pan.x; view.y = ev.clientY - pan.y; moved = true; follow = false
  } else {
    hovered = hit(ev.clientX, ev.clientY)
    canvas.classList.toggle('over', Boolean(hovered))
  }
})
/** Opens or closes a station's targets; a target stands for its station. */
function toggleTargets(n) {
  const station = n?.kind === 'leaf' ? nodes.get(n.parent) : n
  if (!station || station.kind !== 'station') return
  if (expanded.has(station.id)) expanded.delete(station.id)
  else expanded.add(station.id)
  heat = Math.max(heat, 0.7)
  sync()
  if (selected === station) fillPanel()
}
// A double-click is two clicks on the same node within 400 ms, told apart here and not by the
// browser's own dblclick, which some browsers drop after a click that captured the pointer.
let lastClick = { id: null, at: 0 }
const release = ev => {
  if (dragging && !moved) {
    const at = performance.now()
    if (lastClick.id === dragging.id && at - lastClick.at < 400) { toggleTargets(dragging); lastClick = { id: null, at: 0 } }
    else lastClick = { id: dragging.id, at }
    openPanel(dragging)
  }
  if (pan && !moved) closePanel()
  dragging = null; pan = null
  canvas.classList.remove('dragging')
  if (ev.pointerId !== undefined && canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId)
}
canvas.addEventListener('pointerup', release)
canvas.addEventListener('pointercancel', release)
canvas.addEventListener('pointerleave', () => { if (!dragging && !pan) hovered = null })
canvas.addEventListener('wheel', ev => {
  ev.preventDefault()
  follow = false
  const r = canvas.getBoundingClientRect()
  const cx = ev.clientX - r.left - r.width / 2, cy = ev.clientY - r.top - r.height / 2
  const k = Math.max(0.2, Math.min(4, view.k * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015))))
  view.x = cx - ((cx - view.x) * k) / view.k
  view.y = cy - ((cy - view.y) * k) / view.k
  view.k = k
}, { passive: false })
$('toggle-targets').onclick = () => toggleTargets(selected)
$('fit').onclick = fit
$('settle').onclick = () => { heat = 1 }
addEventListener('keydown', ev => {
  if (ev.target instanceof HTMLInputElement && ev.target.type !== 'range') return
  if (ev.key === '/') { ev.preventDefault(); $('search').focus(); return }
  if (ev.key === 'p' || ev.key === 'P') setPaused(!paused)
  if ((ev.key === 'c' || ev.key === 'C') && expanded.size) { expanded.clear(); heat = Math.max(heat, 0.7); sync(); if (selected) fillPanel() }
  if (ev.key === 'f' || ev.key === 'F') fit()
  if (ev.key === 's' || ev.key === 'S') heat = 1
  if (ev.key === 'g' || ev.key === 'G') toggleForces()
  if (ev.key === 'Escape') closePanel()
})

// ---- details panel ----------------------------------------------------------------------------------

function openPanel(n) { selected = n; $('panel').hidden = false; fillPanel() }
function closePanel() { selected = null; $('panel').hidden = true }
$('close').onclick = closePanel
const ago = ms => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`)
/** "8.2k tokens (in 1.2k, out 3k, cache 4k)" or nothing. */
function spentText(k) {
  const total = tokensOf(k)
  if (!total) return ''
  return `${fmtTokens(total)} tokens (in ${fmtTokens(k.input)}, out ${fmtTokens(k.output)}, cache ${fmtTokens(k.cacheRead + k.cacheWrite)})`
}

function fillPanel() {
  const n = selected
  if (!n || !state) return
  const t = now()
  const entries = (state.board?.entries ?? [])
  let list = []
  if (n.kind === 'core') {
    $('panel-title').textContent = `${n.label} · main agent`
    $('panel-sub').textContent = [n.sub, state.board?.context !== undefined ? `context ${Math.round(state.board.context)}%` : '', state.board?.step ? `step ${state.board.step}` : '', spentText(state.board?.tokens)].filter(Boolean).join(' · ')
    list = entries.filter(e => e.agentId === undefined)
  } else if (n.kind === 'agent') {
    const m = n.agent
    $('panel-title').textContent = `${m.type} · subagent`
    $('panel-sub').textContent = [shortModel(m.model), m.task, m.status === 'run' ? `running ${ago(t - m.startedAt)}` : `${m.status === 'err' ? 'failed' : 'done'} in ${ago((m.endedAt ?? t) - m.startedAt)}`, spentText(m.tokens)].filter(Boolean).join(' · ')
    list = entries.filter(e => e.agentId === m.id)
  } else if (n.kind === 'leaf') {
    const station = nodes.get(n.parent)
    const all = entries.filter(e => e.station === n.station && (e.agentId ?? null) === n.owner)
    if (n.more) {
      // The targets past the first few, each with its count.
      const shown = new Set([...nodes.values()].filter(x => x.parent === n.parent && x.kind === 'leaf' && !x.more).map(x => x.target))
      const rest = new Map()
      for (const e of all) { const k = e.target || e.label; if (!shown.has(k)) rest.set(k, (rest.get(k) ?? 0) + 1) }
      $('panel-title').textContent = `More targets · ${station?.label ?? ''}`
      $('panel-sub').textContent = `${rest.size} more`
      list = [...rest].map(([k, c], i) => ({ id: `more${i}`, station: n.station, label: `${k}  ×${c}`, status: 'ok', startedAt: 0, endedAt: 0 }))
    } else {
      $('panel-title').textContent = n.target
      $('panel-sub').textContent = `${station?.label ?? ''} · ${n.count} call${n.count === 1 ? '' : 's'}${n.faults ? ` · ${n.faults} failed or refused` : ''}`
      list = all.filter(e => (e.target || e.label) === n.target)
    }
  } else {
    $('panel-title').textContent = `${n.label}${n.owner ? ` · ${nodes.get(n.parent)?.label ?? 'subagent'}` : ''}`
    $('panel-sub').textContent = `${n.count} call${n.count === 1 ? '' : 's'}${n.faults ? ` · ${n.faults} failed or refused` : ''}`
    list = entries.filter(e => e.station === n.station && (e.agentId ?? null) === n.owner)
  }
  // A station, or one of its targets, can open and close from here as well as by double-click.
  const owner = n.kind === 'leaf' ? nodes.get(n.parent) : n
  $('toggle-targets').hidden = owner?.kind !== 'station'
  $('toggle-targets').textContent = owner && expanded.has(owner.id) ? 'Hide targets' : 'Show targets'
  const ol = $('panel-list')
  ol.replaceChildren(...list.slice(-14).reverse().map(e => {
    const li = document.createElement('li')
    li.className = e.status === 'run' ? 'run' : e.status === 'ok' ? '' : 'err'
    const name = document.createElement('span')
    name.textContent = `${e.status === 'run' ? '●' : e.status === 'ok' ? '·' : '✕'} ${n.kind === 'station' || n.kind === 'leaf' ? '' : `${state.names?.[e.station] ?? e.station}: `}${e.label}`
    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = e.startedAt === 0 ? '' : e.status === 'run' ? `${ago(t - e.startedAt)}…` : ago((e.endedAt ?? e.startedAt) - e.startedAt)
    li.append(name, when)
    return li
  }))
  if (!list.length) { const li = document.createElement('li'); li.textContent = 'Nothing yet.'; ol.append(li) }
}

// ---- live updates -----------------------------------------------------------------------------------

function receive(text) {
  let next
  try { next = JSON.parse(text) } catch { return }
  if (!next || !next.board) return
  if (typeof next.savedAt === 'number') skew = next.savedAt - Date.now()
  state = next
  icons.clear()
  const title = next.folder ? `Work map · ${next.folder}` : 'Work map'
  $('title').textContent = title
  document.title = title
  const b = next.board
  $('meta').textContent = [shortModel(b.model), b.context !== undefined ? `context ${Math.round(b.context)}%` : ''].filter(Boolean).join(' · ')
  $('now').textContent = next.now ?? ''
  // The legend names the model families on the map, each with its colour.
  const families = [...new Set([b.model, ...(b.crew ?? []).map(m => m.model)].map(familyOf).filter(Boolean))]
  $('legend').replaceChildren(...families.map(f => {
    const span = document.createElement('span')
    span.textContent = f
    span.style.setProperty('--dot', C[f] || C.mute)
    return span
  }))
  sync()
}

function connect() {
  const source = new EventSource(`${base}events`)
  source.onopen = () => { $('live').textContent = 'Live'; $('live').className = 'live on' }
  source.onmessage = ev => receive(ev.data)
  source.onerror = () => { $('live').textContent = 'Reconnecting…'; $('live').className = 'live off' }
}

/** Read-only: where each node is, for checking the page from outside. */
window.workMapPositions = () => [...nodes.values()].map(n => [n.id, Math.round(n.x), Math.round(n.y)])

fetch(`${base}state`, { cache: 'no-store' }).then(r => r.text()).then(receive).catch(() => {})
connect()
requestAnimationFrame(frame)
