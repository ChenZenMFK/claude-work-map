import { expect, mock, test } from 'claude-code/testing'

import { classify, setupFrom } from './map'

const PANE = {
  plugin: 'work-map',
  component: 'Pane',
  requestId: 'work-map',
  props: { title: 'Work map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** The world beneath the mod: a home folder, a session, a server that prints its port, and the files it writes. */
function world(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const clock = mock.clock(on)
  const writes: { path: string; text: string }[] = []
  const runs: string[][] = []
  const spawns: string[][] = []
  on('fs.write', (_, e) => {
    writes.push(e as { path: string; text: string })
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    runs.push([...(e as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: '/Users/test\n', stderr: '' } }
  })
  on('process.spawn', async function* (_, e) {
    spawns.push([...(e as { argv: string[] }).argv])
    yield { stream: 'stdout', text: 'PORT 4321\n' } as never
    // The server runs until the session ends: here, an hour on the test's clock.
    await clock.sleep(3_600_000)
    return { code: 0 } as never
  })
  on('session.id', () => ({ value: 'abc-123' }))
  on('session.cwd', () => ({ value: '/work/My App' }))
  on('command.register', () => ({ value: { command: 'work-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  return { clock, writes, runs, spawns }
}

test('calls land on their stations, as in lot-map', () => {
  const setup = setupFrom({})
  expect(classify('Read', { file_path: '/a/b.md' }, setup).station).toBe('files')
  expect(classify('Bash', { command: 'git push origin main' }, setup).station).toBe('web')
  expect(classify('Agent', { description: 'x' }, setup).station).toBe('agents')
})

test('the session starts the page server on this computer, with a random key in its address', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work/My App', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  expect(w.spawns.length).toBe(1)
  const argv = w.spawns[0] as string[]
  expect(argv[0]).toBe('python3')
  expect(argv[2]).toMatch(/\/server\/serve\.py$/)
  expect(argv[argv.indexOf('--state') + 1]).toBe('/Users/test/.claude/work-map/abc-123.json')
  expect(argv[argv.indexOf('--token') + 1]).toMatch(/^[a-z0-9]{24,}$/)
})

test('every change is saved for the page, a burst folded into few saves, with names, icons and the board', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work/My App', surface: 'desktop', isInteractive: true })
  await w.clock.advance(200)
  const before = w.writes.length
  await $.tool.call({ tool: 'Read', file_path: '/a/b/content.py' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  await w.clock.advance(200)
  const saved = w.writes.slice(before)
  // Two calls start and end: four changes, never more saves than that.
  expect(saved.length).toBeGreaterThan(0)
  expect(saved.length).toBeLessThanOrEqual(4)
  const state = JSON.parse((saved[saved.length - 1] as { text: string }).text)
  expect(state.folder).toBe('My App')
  expect(state.names.files).toBe('Files')
  expect(state.stations.length).toBe(10)
  expect(state.board.entries.map((e: { station: string }) => e.station)).toEqual(['files', 'files'])
  expect(typeof state.savedAt).toBe('number')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane offers the map and still lists the calls, on the ${surface}`, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/My App', surface: 'desktop', isInteractive: true })
    await w.clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/a/b/content.py' })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /b\/content\.py/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Open map/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^http:\/\/127\.0\.0\.1:4321\/[a-z0-9]+\/$/ })).toBeDefined()
    await ui.unmount()
  })
}

test('Open map opens the page in the browser', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work/My App', surface: 'desktop', isInteractive: true })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-map' })
  expect(w.runs.some(r => r[0] === 'open' && /^http:\/\/127\.0\.0\.1:4321\/[a-z0-9]+\/$/.test(r[1] ?? ''))).toBe(true)
  await ui.unmount()
})

test('/work-map opens the page and says where', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work/My App', surface: 'desktop', isInteractive: true })
  const said = await $.command.run({ command: 'work-map', args: '' } as never)
  expect(JSON.stringify(said)).toContain('http://127.0.0.1:4321/')
  expect(w.runs.some(r => r[0] === 'open')).toBe(true)
})
