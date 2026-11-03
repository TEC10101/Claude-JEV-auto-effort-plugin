import * as leversModule from './levers'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { applyFloor, applyPlan, capState, combine, decide, focus, HOLD_MS, isCarried, quotedReply, STAGE_BY_SKILL, NULL_CASE, paintDraft, parseAnswer, PROMPT_QUESTIONS, PROMPT_WALK, readPrompt, readPromptMatch, readStep, scrub, standAside, STEP_QUESTIONS, STEP_WALK, tailOf, VERSION, walk, WHOOSH } from './rules'

const TYPED = { kind: 'composer' } as const
const SCREEN = { isFullscreen: false, columns: 100 } as const

const BAND = {
  plugin: 'auto-effort',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

/** A session's first typed prompt: submitted, its hold waited out. */
async function first($: Engine, clock: { advance: (ms: number) => Promise<void> }, text: string): Promise<void> {
  const submit = $.prompt.submit({ text, wait: false, origin: TYPED } as never)
  await clock.advance(HOLD_MS)
  await submit
}

test('the prompt rules read Mac\'s usual asks', async () => {
  expect(readPrompt('Review the diff since abc123')?.level).toBe('high')
  expect(readPrompt('Why does the Horde skip step 6?')?.level).toBe('high')
  expect(readPrompt('Build the Horde on core/horde')?.level).toBe('medium')
  expect(readPrompt('Write a document in docs/reference/')?.level).toBe('medium')
  expect(readPrompt('Explain how effort differs from the model')?.level).toBe('low')
  expect(readPrompt('Where does the Simulation keep the news?')?.level).toBe('low')
  expect(readPrompt('Promote M7')).toBeUndefined()
  expect(applyFloor('claude-sonnet-5-5', 'low')).toEqual({ level: 'medium', floor: 'sonnet floor' })
  expect(applyFloor('claude-sonnet-5-5', 'high')).toEqual({ level: 'high' })
  expect(applyFloor('claude-haiku-5', 'low')).toEqual({ level: 'medium', floor: 'haiku floor' })
  expect(applyFloor('claude-opus-5-5', 'low')).toEqual({ level: 'low' })
  expect(applyFloor('claude-sonnet-5-5', 'low', true)).toEqual({ level: 'low' })
})

test('the plan step and the precedence', async () => {
  expect(readStep('Verify the stills byte for byte')?.level).toBe('high')
  expect(readStep('Write the log line')?.level).toBe('low')
  expect(readStep('Read how the Horde is set up')).toBeUndefined()

  let plan = applyPlan([], {
    items: [
      { content: 'Read the spec', status: 'in_progress' },
      { content: 'Run the tests', status: 'pending' },
      { content: 'Write the log line', status: 'pending' },
    ],
  })
  plan = applyPlan(plan, { advance: true })
  expect(plan[1]?.status).toBe('in_progress')
  plan = applyPlan(plan, { done: [2], start: 3 })
  expect(plan.map(p => p.status)).toEqual(['completed', 'completed', 'in_progress'])

  const stage = { level: 'medium', reason: 'build skill' } as const
  const prompt = { level: 'high', reason: 'verification words' } as const
  const step = { level: 'low', reason: 'writing step' } as const
  expect(decide({ stage })?.source).toBe('stage')
  expect(decide({ stage, prompt })?.level).toBe('high')
  expect(decide({ stage, prompt, step })?.level).toBe('low')
  expect(decide({ stage, prompt, step, manual: { reason: 'user override' } })).toEqual({ level: 'manual', reason: 'user override', source: 'manual' })
  expect(decide({})).toEqual({ level: 'medium', reason: 'nothing matched', source: 'default' })
})

test('a prompt pops the band; Manual leaves the app setting in charge; Auto hands back; /effort-miss is the one hand entry', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The band is up from the start; /effort-show 0 hides it, and a change then pops it for four seconds.
  const up = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await up.find({ type: 'Text', text: /nothing matched/ })).toBeDefined()
  await up.unmount()
  await $.command.run({ command: 'effort-show', args: '0', origin: TYPED, presentation: SCREEN })
  const hidden = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await hidden.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await hidden.unmount()

  await first($, clock, 'Review the diff since abc123')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^high$/ }))?.text).toBe('high')
    expect(await ui.find({ type: 'Text', text: /verification words/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    expect((await ui.find({ key: 'auto' }))?.props?.variant).toBe('primary')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'manual' })
  // The level carries no "(manual)": the primary Manual button says it. Mid-turn, no "(last turn)" either.
  expect(await ui.find({ type: 'Text', text: /\(manual\)/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /user override/ }))?.text).toBe('· user override')
  expect((await ui.find({ key: 'manual' }))?.props?.variant).toBe('primary')
  await ui.press({ key: 'auto' })
  expect((await ui.find({ type: 'Text', text: /^high$/ }))?.text).toBe('high')
  await ui.unmount()

  // Neither press logged anything.
  let report = await $.command.run({ command: 'effort-report', args: '', origin: TYPED, presentation: SCREEN })
  expect(report.text).toBe('auto-effort: nothing recorded yet.')

  // /effort-miss after the turn is the one hand entry.
  await $.turn.start({ text: 'Review the diff since abc123', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  const missed = await $.command.run({ command: 'effort-miss', args: 'low too simple', origin: TYPED, presentation: SCREEN })
  expect(missed.text).toContain('ran high (verification words), should have been low')
  report = await $.command.run({ command: 'effort-report', args: '', origin: TYPED, presentation: SCREEN })
  expect(report.text).toContain('1 misses')
  expect(report.text).toContain('high (prompt: verification words) → low via miss-command  "Review the diff since abc123"  — too simple')

  // Four seconds after the last change the band hides; /effort-show brings it back.
  await clock.advance(4100)
  const gone = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await gone.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await gone.unmount()
  // Between turns the band keeps the last turn's effort; the next prompt replaces it.
  const shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · verification words (last turn)')
  const back = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await back.find({ type: 'Text', text: /last turn/ })).toBeDefined()
  await back.unmount()
  // A turn the agent starts (no prompt) drops the mark too: the band shows this turn's pick.
  await $.turn.start({ text: 'carrying on', turnId: 't1b' })
  expect((await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })).text).toBe('effort medium · nothing matched')
  await $.turn.complete({ turnId: 't1b', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })

  // A number is seconds; -1 keeps the band up past any change; 0 hides it.
  const two = await $.command.run({ command: 'effort-show', args: '2', origin: TYPED, presentation: SCREEN })
  expect(two.text).toContain('(band up for 2 s)')
  await clock.advance(10100)
  const afterTwo = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await afterTwo.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await afterTwo.unmount()
  const always = await $.command.run({ command: 'effort-show', args: '-1', origin: TYPED, presentation: SCREEN })
  expect(always.text).toContain('(band up until /effort-show 0)')
  await $.prompt.submit({ text: 'Review it again', wait: false, origin: TYPED })
  await clock.advance(60000)
  const still = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await still.find({ type: 'Text', text: /^high$/ }))?.text).toBe('high')
  await still.unmount()
  const off = await $.command.run({ command: 'effort-show', args: '0', origin: TYPED, presentation: SCREEN })
  expect(off.text).toContain('(band hidden)')
  const gone2 = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await gone2.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await gone2.unmount()
  const bad = await $.command.run({ command: 'effort-show', args: 'forever', origin: TYPED, presentation: SCREEN })
  expect(bad.text).toContain('Usage')
})

test('a change of the app setting between turns switches to Manual by itself; Auto releases it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const efforts: (string | number | undefined)[] = []
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)
    yield* []

    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as never
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const step = (turnId: string, effort: 'medium' | 'xhigh') =>
    $.turn.step({ turnId, index: 0, effort, model: 'claude-opus-5-5', messageCount: 1 } as never)

  // The first turn sets the baseline; the rules win.
  await first($, clock, 'Review the diff since abc123')
  await $.turn.start({ text: 'Review the diff since abc123', turnId: 't1' })
  for await (const _ of step('t1', 'medium')) void _
  expect(efforts).toEqual(['high'])
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })

  // The app setting moved to xhigh: Manual, the rules set aside.
  await $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  await $.turn.start({ text: 'Review the diff since abc123', turnId: 't2' })
  for await (const _ of step('t2', 'xhigh')) void _
  expect(efforts).toEqual(['high', 'xhigh'])
  let shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort xhigh · user override')
  await $.turn.complete({ turnId: 't2', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  // Manual pressed between turns while already Manual: nothing to switch, the words stay the last turn's.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'manual' })
  await band.unmount()
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort xhigh · user override (last turn)')

  // Still Manual on the next turn, unchanged setting; Auto pressed mid-turn waits for the next turn.
  await $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  await $.turn.start({ text: 'Review the diff since abc123', turnId: 't3' })
  for await (const _ of step('t3', 'xhigh')) void _
  expect(efforts).toEqual(['high', 'xhigh', 'xhigh'])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'auto' })
  await ui.unmount()
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort xhigh · user override (last turn)')
  await $.turn.complete({ turnId: 't3', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  // The next turn is Auto's.
  await $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  await $.turn.start({ text: 'Review the diff since abc123', turnId: 't4' })
  for await (const _ of step('t4', 'xhigh')) void _
  expect(efforts).toEqual(['high', 'xhigh', 'xhigh', 'high'])
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · verification words')
  await $.turn.complete({ turnId: 't4', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  const report = await $.command.run({ command: 'effort-report', args: '', origin: TYPED, presentation: SCREEN })
  expect(report.text).toContain('0 misses')
  expect(report.text).toContain('sources  prompt 2 · manual 2')
  // The honest tally: what the requests ran at, and the decision at each turn's first request.
  expect(report.text).toContain('ran      high 2 · xhigh 2 (requests, after the floor)')
  expect(report.text).toContain('first    high 2 · manual 2 (the decision at the turn\'s first request)')
})

test('Manual or Auto pressed mid-turn waits for the next turn: the band keeps what the turn runs at, marked (last turn)', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const efforts: (string | number | undefined)[] = []
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)
    yield* []

    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as never
  })
  const step = (turnId: string, index: number, effort: 'max' | 'xhigh') =>
    $.turn.step({ turnId, index, effort, model: 'claude-opus-5-5', messageCount: 1 } as never)
  const show = async () => (await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })).text

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Auto, the app at max: the prompt runs low.
  await first($, clock, 'Explain the Horde')
  await $.turn.start({ text: 'Explain the Horde', turnId: 't1' })
  for await (const _ of step('t1', 0, 'max')) void _
  expect(efforts).toEqual(['low'])
  const ranLow = await show()
  expect(ranLow).toMatch(/^effort low · /)

  // Mid-turn: the app moves to xhigh and Manual is pressed. The band keeps the turn's low, marked; the button shows the choice.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'manual' })
  expect((await band.find({ key: 'manual' }))?.props?.variant).toBe('primary')
  expect((await band.find({ key: 'auto' }))?.props?.variant).toBe('secondary')
  await band.unmount()
  expect(await show()).toBe(`${ranLow} (last turn)`)
  // The rest of the turn runs as it was.
  for await (const _ of step('t1', 1, 'xhigh')) void _
  expect(efforts).toEqual(['low', 'low'])
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  expect(await show()).toBe(`${ranLow} (last turn)`)

  // The next turn is Manual, at the app's new setting: a user override.
  await $.prompt.submit({ text: 'Explain the Horde again', wait: false, origin: TYPED })
  await $.turn.start({ text: 'Explain the Horde again', turnId: 't2' })
  for await (const _ of step('t2', 0, 'xhigh')) void _
  expect(efforts).toEqual(['low', 'low', 'xhigh'])
  expect(await show()).toBe('effort xhigh · user override')

  // Auto pressed mid-turn: nothing is judged now; the turn keeps the app's setting.
  const again = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await again.press({ key: 'auto' })
  expect((await again.find({ key: 'auto' }))?.props?.variant).toBe('primary')
  await again.unmount()
  expect(await show()).toBe('effort xhigh · user override (last turn)')
  for await (const _ of step('t2', 1, 'xhigh')) void _
  expect(efforts).toEqual(['low', 'low', 'xhigh', 'xhigh'])
  // Pressed back before the turn ends, the switch is called off.
  const back = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await back.press({ key: 'manual' })
  await back.unmount()
  expect(await show()).toBe('effort xhigh · user override')
  const off = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await off.press({ key: 'auto' })
  await off.unmount()
  await $.turn.complete({ turnId: 't2', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })

  // The next turn is Auto's: the rules judge it.
  await $.prompt.submit({ text: 'Explain the Horde once more', wait: false, origin: TYPED })
  await $.turn.start({ text: 'Explain the Horde once more', turnId: 't3' })
  for await (const _ of step('t3', 0, 'xhigh')) void _
  expect(efforts).toEqual(['low', 'low', 'xhigh', 'xhigh', 'low'])
  expect(await show()).toMatch(/^effort low · [^(]*$/)
})

test('in Auto a subagent runs at its type\'s level, else the main decision, whatever the Agent call said; in Manual it is left alone', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('agent.spawn', (_, e) => ({ model: 'claude-opus-5-5', agentId: `agent-${e.subagentType}` }))
  const efforts: (string | number | undefined)[] = []
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)
    yield* []

    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as never
  })
  const spawn = (subagentType: string) =>
    $.agent.spawn({ tool_use_id: `call-${subagentType}`, prompt: 'go', description: 'd', subagentType, provider: TYPED, parentModel: 'claude-opus-5-5' } as never)
  const step = (agentId: string, effort: 'low' | 'medium' | 'high' | 'xhigh', model = 'claude-opus-5-5') =>
    $.turn.step({ turnId: 't1', index: 0, effort, model, messageCount: 1, agentId } as never)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await first($, clock, 'Explain the Horde')
  await spawn('reviewer')
  await spawn('general-purpose')
  // The reviewer's type says high, even though the call ran it at low; the unlisted type takes the main decision (low: prose words).
  for await (const _ of step('agent-reviewer', 'low')) void _
  for await (const _ of step('agent-general-purpose', 'xhigh')) void _
  expect(efforts).toEqual(['high', 'low'])
  // On Sonnet the mod never picks below medium.
  for await (const _ of step('agent-general-purpose', 'xhigh', 'claude-sonnet-5-5')) void _
  expect(efforts).toEqual(['high', 'low', 'medium'])
  // The main loop on Haiku: the band names the floor.
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, effort: 'xhigh', model: 'claude-haiku-5', messageCount: 1 } as never)) void _
  expect(efforts).toEqual(['high', 'low', 'medium', 'medium'])
  const floored = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(floored.text).toBe('effort medium · prose or lookup words (haiku floor)')

  // Manual: bypass, the subagents included.
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'manual' })
  await ui.unmount()
  for await (const _ of step('agent-reviewer', 'low')) void _
  for await (const _ of step('agent-general-purpose', 'xhigh')) void _
  expect(efforts).toEqual(['high', 'low', 'medium', 'medium', 'low', 'xhigh'])
})

// --- Jev ------------------------------------------------------------------------

/** A response body: every question of the kind at `rest`, the named ones at their value. */
const answer = (kind: 'prompt' | 'step', yes: Record<string, number>, rest = 0.05) => {
  const answers: Record<string, { type: 'noul'; noul: number }> = {}
  for (const id of Object.keys(kind === 'prompt' ? PROMPT_QUESTIONS : STEP_QUESTIONS)) answers[id] = { type: 'noul', noul: yes[id] ?? rest }
  return JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 100, output_tokens: 4 } })
}

const OK = { ok: true, status: 200, headers: {} } as const

test('the scrubber and the cap leave ordinary prose, identifiers and paths alone', async () => {
  const s = scrub(
    'Mail someone.else@example.org or call (555) 123-4567; key sk-abcdefghijklmnop and Bearer abcdefghijklmnopqrstuvwxyz0123456789 live in C:\\Users\\someone\\.claude; host 192.168.1.20; see https://example.com/private/path?x=1 and TYPESAFE_API_KEY=ts_live_abc123def456. Jane Roe, jane and ROE, but Janet stays.',
    ['Jane', 'Roe'],
  )
  for (const gone of ['someone.else', '555', 'sk-abc', 'abcdefghijklmnopqrstuvwxyz', 'someone\\', 'Jane ', 'jane', 'Roe', 'ROE', '192.168', 'example.com', '/private/path', 'ts_live']) expect(s).not.toContain(gone)
  for (const kept of ['<email>', '<phone>', '<secret>', '<home>', '<ip>', '<url>', '<name>', 'TYPESAFE_API_KEY=<secret>', 'but Janet stays']) expect(s).toContain(kept)
  // No names are built in: without a list, a name passes.
  expect(scrub('Jane Roe')).toBe('Jane Roe')

  const untouched = [
    'Review the diff since main for regressions in the motion code',
    'Rename skipEnemyTurnWhenStunned to skip; also task-runner, the skeleton key and a ghostwriter',
    'Fix the bug in core/Rules/Simulation/StepEnemyBehaviorAfterKnockback.cs and see docs/reference/Claude-Auto-Effort-Mod-Explainer.md',
    'Add a key: value pair to room.json, token: the next lexer token, row secret: none',
    'bump 100 200 3000 and commit 2cde7330',
    'Look at D:\\Work\\My Game\\core',
  ]
  untouched.push(
    'Step_ReturnsEvents_WhenEnemyStunnedFor3Turns and TitleScreenControllerImplementationVersion2 are tests',
    'sortKey=name, monkey=3, turnKey=e.turnId; id 123e4567-e89b-42d3-a456-426614174000',
    'the path core/Rules/Simulation/StepEnemyBehaviorAfterKnockback2 has no extension',
  )
  for (const line of untouched) expect(scrub(line)).toBe(line)
  // A URL keeps nothing, its host included: a private host name never leaves.
  expect(scrub('see https://github.com/someone/some-repo/pull/70 now')).toBe('see <url> now')
  expect(scrub('db postgres://admin:hunter2@db.internal:5432/game and https://me:pw@host.tld/x')).toBe('db <url> and <url>')
  // A credential written as `name: value` or as a JSON pair; bare key, token and secret are words, not credentials.
  expect(scrub('password: examplevalue and API_KEY: abc123')).toBe('password: <secret> and API_KEY: <secret>')
  expect(scrub('{"api_key": "examplevalue", "token":"t0k3n", "name": "x"}')).toBe('{"api_key": "<secret>", "token":"<secret>", "name": "x"}')
  expect(scrub("{'api_key': 'abc123', 'password': 'hunter2', 'name': 'x'}")).toBe("{'api_key': '<secret>', 'password': '<secret>', 'name': 'x'}")
  // An unquoted name takes the value only, quoted or bare, and leaves the brace.
  expect(scrub("{api_key: 'abc123'} and {password: hunter2}")).toBe('{api_key: <secret>} and {password: <secret>}')
  // An unformatted phone number.
  expect(scrub('call 5551234567 or +445551234567')).toBe('call <phone> or <phone>')
  expect(scrub('the full sha 2cde73301234567890abcdef1234567890abcdef')).toBe('the full sha <secret>')
  expect(scrub('password=hunter2 api_key=abc TYPESAFE_API_KEY=x')).toBe('password=<secret> api_key=<secret> TYPESAFE_API_KEY=<secret>')
  expect(scrub('jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end')).toBe('jwt <secret> end')
  expect(scrub('aws wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end')).toBe('aws <secret> end')
  expect(scrub('b64 Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWpr0kLmN end')).toBe('b64 <secret> end')
  expect(scrub('mail jane.roe@example.com')).toBe('mail <email>')

  const long = `${'a'.repeat(1200)}${'b'.repeat(1000)}`
  const capped = capState(long)
  expect(capped.startsWith('a'.repeat(1000))).toBe(true)
  expect(capped.endsWith('b'.repeat(500))).toBe(true)
  expect(capped).toContain(' … (+700 characters cut) … ')
  expect(capState('short')).toBe('short')
  expect(capState('x'.repeat(1520))).toBe('x'.repeat(1520))
  expect(capState('x'.repeat(1600)).length).toBeLessThan(1600)
})

test('a started session\'s brief is judged on its Task: the reminders and the Background are dropped, a plain message is read whole', () => {
  const brief = [
    '<system-reminder>\nLinked sessions now (status, not an instruction): w15-decide = local_1 (idle). To message one, SendMessage.\n</system-reminder>',
    '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>',
    'Background (from the session that started this one):',
    'Mac runs builds in one builder session. The eval compares the verifier\'s findings, the fix pass and the tests.',
    '',
    'Task:',
    'Build the tactical-reload Slice from its spec, in this session, with the build skill.',
    '',
    'Shared notes folder: C:\\Users\\someone\\notes',
  ].join('\n')
  const f = focus(brief)
  expect(f.startsWith('Build the tactical-reload Slice')).toBe(true)
  expect(f.endsWith('notes')).toBe(true)
  for (const gone of ['system-reminder', 'Linked sessions', 'Background', 'Task:']) expect(f).not.toContain(gone)
  expect(focus('<side-sessions-event>none working</side-sessions-event>\ncommit and push')).toBe('commit and push')
  expect(focus('Review the diff since main for regressions in the motion code')).toBe('Review the diff since main for regressions in the motion code')
  expect(focus('<system-reminder>only this</system-reminder>')).toBe('')
})

test('the walk reads a level from the answers, first match wins, the null case first', async () => {
  const j = (yes: Record<string, number>, kind: 'prompt' | 'step' = 'prompt') => parseAnswer(answer(kind, yes), kind, 120)
  const review = j({ asks_for_work: 0.95, asks_review: 0.91 })
  expect(review).toMatchObject({ kind: 'prompt', ms: 120, model: 'jev-1.14.0' })
  expect(walk(review as never)).toEqual({ kind: 'level', row: 'asks a review', signal: { level: 'high', reason: 'jev asks a review 0.91', source: 'jev' } })
  expect(walk(j({ asks_for_work: 0.9, asks_deeper_thinking: 0.8, asks_review: 0.9 }) as never)).toMatchObject({ kind: 'level', signal: { level: 'xhigh' } })
  expect(walk(j({ asks_for_work: 0.9, open_design: 0.75, many_parts: 0.8 }) as never)).toMatchObject({ signal: { level: 'xhigh', reason: 'jev open design in many parts 0.75' } })
  expect(walk(j({ asks_for_work: 0.9, open_design: 0.75, many_parts: 0.5, settled_build: 0.8 }) as never)).toMatchObject({ signal: { level: 'high', reason: 'jev open design 0.75' } })
  expect(walk(j({ asks_for_work: 0.9, settled_build: 0.8, many_parts: 0.9 }) as never)).toMatchObject({ signal: { level: 'medium', reason: 'jev settled build 0.80' } })
  // 'Fix the typo': a settled build in one place is low; 'review this one-liner' stays high.
  expect(walk(j({ asks_for_work: 0.9, settled_build: 0.8, one_place: 0.9 }) as never)).toMatchObject({ signal: { level: 'low', reason: 'jev one place 0.90' } })
  expect(walk(j({ asks_for_work: 0.9, asks_review: 0.8, one_place: 0.9 }) as never)).toMatchObject({ signal: { level: 'high' } })
  expect(walk(j({ asks_for_work: 0.9, answer_only: 0.9 }) as never)).toMatchObject({ signal: { level: 'low', reason: 'jev answer only 0.90' } })
  // 'push them please' after a reply that named the commits: a routine step is low; a green-lit build is not.
  expect(walk(j({ asks_for_work: 0.9, routine_step: 0.95 }) as never)).toMatchObject({ signal: { level: 'low', reason: 'jev routine step 0.95' } })
  expect(walk(j({ asks_for_work: 0.9, routine_step: 0.1, settled_build: 0.8 }) as never)).toMatchObject({ signal: { level: 'medium', reason: 'jev settled build 0.80' } })
  // 'Q2, (b). Q3, (c)': answers to a round are decisions that feed work, medium, though they read as answer_only too.
  expect(walk(j({ asks_for_work: 0.9, answers_questions: 0.9, answer_only: 0.8 }) as never)).toMatchObject({ signal: { level: 'high', reason: 'jev answers decide 0.90' } })
  expect(walk(j({ asks_for_work: 0.1, asks_review: 0.9 }) as never)).toEqual({ kind: 'none', signal: { level: 'low', reason: 'jev no work asked 0.10', source: 'jev', underFloor: true } })
  expect(walk(j({ asks_for_work: 0.9 }) as never)).toEqual({ kind: 'gap' })
  // An unsettled higher row is passed over for a settled lower one.
  expect(walk(j({ asks_for_work: 0.9, asks_deeper_thinking: 0.6, asks_review: 0.9 }) as never)).toMatchObject({ signal: { level: 'high' } })
  expect(walk(j({ asks_for_work: 0.9, asks_review: 0.5 }) as never)).toEqual({ kind: 'unsure' })
  expect(walk(j({ verifies: 0.9 }, 'step') as never)).toMatchObject({ signal: { level: 'high', reason: 'jev verifying step 0.90' } })
  expect(walk(j({ changes_code: 0.9, prose_only: 0.1 }, 'step') as never)).toMatchObject({ signal: { level: 'medium' } })
  // 'Tests, zip, 0.2.9' and 'Read how the Horde is set up' were 59% of steps unplaced: the chore and the read are low.
  expect(walk(j({ packages: 0.9 }, 'step') as never)).toMatchObject({ signal: { level: 'low', reason: 'jev packaging step 0.90' } })
  expect(walk(j({ reads_only: 0.8 }, 'step') as never)).toMatchObject({ signal: { level: 'low', reason: 'jev reading step 0.80' } })
  expect(walk(j({ verifies: 0.9, packages: 0.9 }, 'step') as never)).toMatchObject({ signal: { level: 'high' } })
  expect(walk(j({}, 'step') as never)).toEqual({ kind: 'gap' })

  expect(parseAnswer('not json', 'prompt', 5)).toEqual({ kind: 'bad-answer', ms: 5 })
  expect(parseAnswer(JSON.stringify({ model: 'jev-1.14.0', answers: { asks_for_work: { type: 'noul', noul: 1.2 } } }), 'prompt', 5)).toEqual({ kind: 'bad-answer', ms: 5 })
  expect(parseAnswer(answer('prompt', {}).replace('"model":"jev-1.14.0",', ''), 'prompt', 5)).toEqual({ kind: 'bad-answer', ms: 5 })
  expect(parseAnswer(answer('step', {}), 'prompt', 5)).toEqual({ kind: 'bad-answer', ms: 5 })

  const rules = { level: 'high', reason: 'verification words' } as const
  expect(combine(review, rules)).toEqual({ level: 'high', reason: 'jev asks a review 0.91', source: 'jev' })
  expect(combine(j({ asks_for_work: 0.9, asks_review: 0.5 }), rules)).toEqual({ level: 'high', reason: 'verification words (jev unsure)' })
  expect(combine(j({ asks_for_work: 0.1 }), rules)).toEqual({ level: 'low', reason: 'jev no work asked 0.10', source: 'jev', underFloor: true })
  expect(combine(j({ asks_for_work: 0.9 }), rules)).toEqual({ level: 'high', reason: 'verification words (jev: nothing fits)' })
  expect(combine({ kind: 'timeout' }, rules)).toEqual({ level: 'high', reason: 'verification words (jev: timeout)' })
  expect(combine(j({ asks_for_work: 0.9, asks_review: 0.5 }), undefined)).toBeUndefined()
  expect(standAside(j({ asks_for_work: 0.9, asks_review: 0.5 }))).toBe('jev unsure')
  expect(standAside(j({ asks_for_work: 0.9 }))).toBe('jev: nothing fits')
  expect(standAside({ kind: 'timeout' })).toBe('jev: timeout')
  expect(standAside(review)).toBe('')
  expect(standAside(undefined)).toBe('')
  expect(combine(undefined, rules)).toEqual(rules)

  expect(readPrompt('Think harder about the Horde')?.level).toBe('xhigh')
  expect(readPrompt('Be thorough: review the diff')?.reason).toBe('explicit ask')
  expect(decide({ prompt: { level: 'high', reason: 'jev asks a review 0.91', source: 'jev' } })?.source).toBe('jev')
})

test('in jev mode Jev judges the prompt and the step; the rules shadow it; the report compares them', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on) // no mode stored: jev is the default
  mock.env(on, { TYPESAFE_API_KEY: 'test-key', AUTO_EFFORT_REDACT: 'Jane, Roe' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
  const sent: { url: string; auth?: string; body: string }[] = []
  let reply = answer('prompt', { asks_for_work: 0.95, asks_review: 0.9 })
  on('http.fetch', async (_, e) => {
    sent.push({ url: e.url, auth: e.init?.headers?.Authorization, body: e.init?.body ?? '' })
    await clock.sleep(120)

    return { value: { ...OK, text: reply } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const mode = await $.command.run({ command: 'effort-mode', args: '', origin: TYPED, presentation: SCREEN })
  expect(mode.text).toBe(`auto-effort ${VERSION} · effort mode jev · TYPESAFE_API_KEY found`)

  const text = 'Explain the Horde to me, I am Jane Roe'
  const submit = $.prompt.submit({ text, wait: false, origin: TYPED } as never)
  await clock.advance(HOLD_MS + 150)
  await submit
  expect(sent).toHaveLength(1)
  expect(sent[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(sent[0]?.auth).toBe('Bearer test-key')
  const body = JSON.parse(sent[0]?.body ?? '{}')
  expect(body.model).toBe('jev-1.14.0')
  expect(body.state).toEqual({ message: 'Explain the Horde to me, I am <name> <name>' })
  expect(Object.keys(body.questions).sort()).toEqual(Object.keys(PROMPT_QUESTIONS).sort())
  expect(body.questions.asks_review).toMatchObject({ type: 'noul', instructions: { question: expect.any(String) }, criteria: { true: { what: expect.any(String) }, false: { not_for: expect.any(String) } } })
  expect(body.questions.asks_review.instructions.context).toBeUndefined()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^high$/ }))?.text).toBe('high')
  expect(await ui.find({ type: 'Text', text: /jev asks a review 0\.90/ })).toBeDefined()
  await ui.unmount()

  const last = await $.command.run({ command: 'effort-jev', args: 'last', origin: TYPED, presentation: SCREEN })
  expect(last.text).toContain('jev prompt at')
  expect(last.text).toContain('"message":"Explain the Horde to me, I am <name> <name>"')
  expect(last.text).toContain('high · jev asks a review 0.90 · 120 ms · jev-1.14.0')
  expect(last.text).toContain('asks_review 0.90')

  // The step: the state carries the prompt and the plan; an unchanged step is not asked again.
  await $.turn.start({ text, turnId: 't1' })
  reply = answer('step', { prose_only: 0.85 })
  const items = [
    { content: 'Read the spec', status: 'completed' },
    { content: 'Write the log line', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' },
  ]
  let call = $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items } as never)
  await clock.advance(150)
  await call
  expect(sent).toHaveLength(2)
  expect(JSON.parse(sent[1]?.body ?? '{}').state).toEqual({
    prompt: 'Explain the Horde to me, I am <name> <name>',
    plan: { step: 'Write the log line', done: ['Read the spec'], ahead: ['Run the tests'] },
  })
  expect(JSON.parse(sent[1]?.body ?? '{}').questions.verifies.instructions.question).toContain('`plan.step`')
  let shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort low · jev prose step 0.85')
  call = $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items } as never)
  await clock.advance(150)
  await call
  expect(sent).toHaveLength(2)

  reply = answer('step', { verifies: 0.9 })
  call = $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
  await clock.advance(150)
  await call
  expect(sent).toHaveLength(3)
  expect(JSON.parse(sent[2]?.body ?? '{}').state.plan.step).toBe('Run the tests')
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · jev verifying step 0.90')

  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  const report = await $.command.run({ command: 'effort-report', args: '', origin: TYPED, presentation: SCREEN })
  expect(report.text).toContain('sources  jev 1')
  expect(report.text).toContain('modes    jev 1')
  expect(report.text).toContain('jev      1 turns in jev mode · 3 calls · 0 failures')
  expect(report.text).toContain('levels high 2 · low 1 · unsure 0 · nothing fits 0 · no work asked 0')
  expect(report.text).toContain('rows asks a review 1 · prose step 1 · verifying step 1')
  // The rules said low (explain), low (log line), high (tests): Jev agreed on the two steps, not the prompt.
  expect(report.text).toContain('agrees with the rules 67% (2/3 where both spoke)')
  expect(report.text).toContain('latency mean 120 ms · 95th 120 ms · late 0')

  // The next prompt carries the tail of the answer just given, scrubbed, and the questions are told what it is.
  reply = answer('prompt', { asks_for_work: 0.99, routine_step: 0.95 })
  const next = $.prompt.submit({ text: 'push them please', wait: false, origin: TYPED })
  await clock.advance(150)
  await next
  const again = JSON.parse(sent[3]?.body ?? '{}')
  expect(again.state).toEqual({ message: 'push them please', previous_reply: 'done' })
  expect(again.questions.routine_step.instructions.context).toContain('`previous_reply`')

  // A turn the agent started (a subagent's hand-back) is not judged on its envelope: it carries the last turn's prompt signal, with no call to Jev.
  await $.turn.start({ text: 'push them please', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', answer: 'pushed', durationMs: 10, isAborted: false, reason: 'answer' })
  const calls = sent.length
  const back = $.prompt.submit({ text: 'Another Claude session sent a message: <agent-message from="a1b2c3"> [Subagent hand-back] done</agent-message>', wait: false, origin: TYPED })
  await clock.advance(150)
  await back
  expect(sent.length).toBe(calls)
  const carried = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(carried.text).toBe('effort low · jev routine step 0.95 (carried)')
})

test('the tail of a long answer is cut with the cut named', () => {
  expect(tailOf('short')).toBe('short')
  const long = 'a'.repeat(600) + 'b'.repeat(500)
  expect(tailOf(long)).toBe(`… (+600 characters cut) … ${'b'.repeat(500)}`)
})

test('unsure, no work asked, a timeout and a 401 hand the turn to the rules, with one toast per failure kind', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'jev' })
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  let behave: 'unsure' | 'none' | 'hang' | 'unauthorized' | 'bad-request' | 'server' = 'unsure'
  on('http.fetch', async () => {
    if (behave === 'hang') await clock.sleep(5000)
    if (behave === 'unauthorized') return { value: { ok: false, status: 401, headers: {}, text: '{"detail":"bad key"}' } }
    if (behave === 'bad-request') return { value: { ok: false, status: 422, headers: {}, text: '{"detail":[]}' } }
    if (behave === 'server') return { value: { ok: false, status: 502, headers: {}, text: '' } }
    if (behave === 'none') return { value: { ...OK, text: answer('prompt', { asks_for_work: 0.05, asks_review: 0.9 }) } }

    return { value: { ...OK, text: answer('prompt', { asks_for_work: 0.9, asks_review: 0.5 }) } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  let submit = $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  await clock.advance(HOLD_MS + 10)
  await submit
  let shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · verification words (jev unsure)')

  // Rules silent and Jev unsure: what was deciding goes on; the band says no change and why Jev stood aside.
  submit = $.prompt.submit({ text: 'Promote M7', wait: false, origin: TYPED })
  await clock.advance(10)
  await submit
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort medium · no change (jev unsure)')
  // A stage skill is what goes on deciding; the band still says no change, then marks the turn's end, then re-evaluates.
  await $.tool.call({ tool: 'Skill', skill: 'build', agentId: undefined } as never)
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort medium · no change (jev unsure)')
  await $.turn.start({ text: 'Promote M7', turnId: 'tu' })
  await $.turn.complete({ turnId: 'tu', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort medium · no change (jev unsure) (last turn)')
  submit = $.prompt.submit({ text: 'Promote M8', wait: false, origin: TYPED })
  await clock.advance(10)
  await submit
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort medium · no change (jev unsure)')

  // No work asked: the rules' "review" word is overruled; an acknowledgement is low.
  behave = 'none'
  submit = $.prompt.submit({ text: 'ok, review it when you get to it, thanks', wait: false, origin: TYPED })
  await clock.advance(10)
  await submit
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort low · jev no work asked 0.05')

  behave = 'hang'
  const text = 'Review the diff since abc123'
  submit = $.prompt.submit({ text, wait: false, origin: TYPED })
  await clock.advance(1000)
  await submit
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · verification words (jev: timeout)')
  expect(toasts.filter(t => t.includes('no answer within 1000 ms'))).toHaveLength(1)
  // The late answer lands on this prompt's turn row even before turn.start opens it.
  await clock.advance(5000)
  await $.turn.start({ text, turnId: 't1' })
  const last = await $.command.run({ command: 'effort-jev', args: 'last', origin: TYPED, presentation: SCREEN })
  expect(last.text).toContain('· late')
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 6000, isAborted: false, reason: 'answer' })
  const report = await $.command.run({ command: 'effort-report', args: '', origin: TYPED, presentation: SCREEN })
  expect(report.text).toContain('late 1')

  submit = $.prompt.submit({ text: 'Review it again', wait: false, origin: TYPED })
  await clock.advance(1000)
  await submit
  expect(toasts.filter(t => t.includes('no answer within 1000 ms'))).toHaveLength(1)
  await clock.advance(5000)

  behave = 'unauthorized'
  submit = $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  await clock.advance(10)
  await submit
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · verification words (jev: unauthorized)')
  const failed = await $.command.run({ command: 'effort-jev', args: 'last', origin: TYPED, presentation: SCREEN })
  expect(failed.text).toContain('failed: unauthorized (401)')
  expect(toasts.filter(t => t.includes('the key was refused'))).toHaveLength(1)

  behave = 'bad-request'
  submit = $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  await clock.advance(10)
  await submit
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · verification words (jev: bad-request)')
  behave = 'server'
  submit = $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  await clock.advance(10)
  await submit
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · verification words (jev: server)')
})

test('rules mode never calls Jev; /effort-mode switches and persists; Manual still asks for the record', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  let calls = 0
  on('http.fetch', () => {
    calls += 1

    return { value: { ...OK, text: answer('prompt', { asks_for_work: 0.9, asks_review: 0.9 }) } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(toasts).toContain('effort: rules mode; /effort-mode jev to try Jev')
  const mode = await $.command.run({ command: 'effort-mode', args: '', origin: TYPED, presentation: SCREEN })
  expect(mode.text).toBe(`auto-effort ${VERSION} · effort mode rules · TYPESAFE_API_KEY found`)

  await first($, clock, 'Explain the Horde')
  expect(calls).toBe(0)
  let shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort low · prose or lookup words')

  // A skill run as a slash command: its arguments are the ask, and it sets the stage the Skill tool would; bare, only the stage.
  await $.prompt.submit({ text: '<command-message>build</command-message>\n<command-name>/build</command-name>\n<command-args>Build the W22 tidy</command-args>', command: { name: 'build', args: 'Build the W22 tidy' }, wait: false, origin: TYPED } as never)
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort medium · build words')
  await $.prompt.submit({ text: '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args></command-args>', command: { name: 'review', args: '' }, wait: false, origin: TYPED } as never)
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · review skill')
  // The mod's own commands and the app's are left alone.
  await $.prompt.submit({ text: '/effort-show', command: { name: 'effort-show', args: '' }, wait: false, origin: TYPED } as never)
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · review skill')
  const last = await $.command.run({ command: 'effort-jev', args: 'last', origin: TYPED, presentation: SCREEN })
  expect(last.text).toContain('no Jev request yet')

  const bad = await $.command.run({ command: 'effort-mode', args: 'maybe', origin: TYPED, presentation: SCREEN })
  expect(bad.text).toContain('Usage')
  const on1 = await $.command.run({ command: 'effort-mode', args: 'jev', origin: TYPED, presentation: SCREEN })
  expect(on1.text).toBe('effort mode jev.')
  const after = await $.command.run({ command: 'effort-mode', args: '', origin: TYPED, presentation: SCREEN })
  expect(after.text).toBe(`auto-effort ${VERSION} · effort mode jev · TYPESAFE_API_KEY found`)

  // Manual: Jev is still asked for the record; Manual wins; nothing is logged.
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'manual' })
  await ui.unmount()
  await $.prompt.submit({ text: 'find every edge case', wait: false, origin: TYPED })
  await clock.settle()
  expect(calls).toBe(1)
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort default · user override')
  const misses = await $.command.run({ command: 'effort-report', args: '', origin: TYPED, presentation: SCREEN })
  expect(misses.text).toBe('auto-effort: nothing recorded yet.')

  const test = await $.command.run({ command: 'effort-jev', args: 'test', origin: TYPED, presentation: SCREEN })
  expect(calls).toBe(2)
  expect(test.text).toContain('key found')
  expect(test.text).toContain('jev test at')
  expect(test.text).toContain('Review the diff since main for regressions in the motion code')
  expect(test.text).toContain('high · jev asks a review 0.90')

  const off = await $.command.run({ command: 'effort-mode', args: 'rules', origin: TYPED, presentation: SCREEN })
  expect(off.text).toBe('effort mode rules.')
  await $.prompt.submit({ text: 'Explain the Horde', wait: false, origin: TYPED })
  expect(calls).toBe(2)
})

test('without a key, jev mode asks nothing and says so', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'jev' })
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  let calls = 0
  on('http.fetch', () => {
    calls += 1

    return { value: { ...OK, text: '{}' } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const mode = await $.command.run({ command: 'effort-mode', args: '', origin: TYPED, presentation: SCREEN })
  expect(mode.text).toBe(`auto-effort ${VERSION} · effort mode jev · no TYPESAFE_API_KEY in the environment`)
  await first($, clock, 'Review the diff since abc123')
  expect(calls).toBe(0)
  const shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · verification words (jev: no-key)')
  const test = await $.command.run({ command: 'effort-jev', args: 'test', origin: TYPED, presentation: SCREEN })
  expect(test.text).toContain('nothing sent')
})

test('a step left and re-entered keeps its Jev signal without a second call; the mode is read from the store after a reload', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'jev' })
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok' }))
  let calls = 0
  on('http.fetch', () => {
    calls += 1

    return { value: { ...OK, text: answer('step', { verifies: 0.9 }) } }
  })

  // No session.start: the signals mirror of the mode is empty, as after a shape bump; the store still says jev.
  await first($, clock, 'Promote M7')
  await clock.settle()
  expect(calls).toBe(1)
  await $.turn.start({ text: 'Promote M7', turnId: 't1' })
  const items = [
    { content: 'Run the tests', status: 'in_progress' },
    { content: 'Write the log line', status: 'pending' },
  ]
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items } as never)
  await clock.settle()
  expect(calls).toBe(2)
  let shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · jev verifying step 0.90')

  // The plan is replaced with no step in progress, then the same step comes back.
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: items.map(i => ({ ...i, status: 'pending' })) } as never)
  await clock.settle()
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort medium · no change (jev: bad-answer)')
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items } as never)
  await clock.settle()
  expect(calls).toBe(2)
  shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · jev verifying step 0.90')
})

test('the first typed prompt waits HOLD_MS with a countdown in the band, then enters; the next prompt does not wait', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let entered = 0
  on('prompt.submit', (_, e) => {
    entered++

    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Held: the band counts down, Send now in place of Auto, Manual still there; the prompt has not entered.
  // (The kit wedges on a press while a hook sleeps on its clock, so Send now and Manual mid-hold are not pressed here.)
  const submit = $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /sending in/ }))?.text).toBe('sending in 3…')
  // Send now stands where Auto does, Manual second, as in the ordinary band.
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props?.label)).toEqual(['Send now', 'Manual'])
  expect(await ui.find({ key: 'auto' })).toBeUndefined()
  expect(entered).toBe(0)
  await clock.advance(1000)
  expect((await ui.find({ type: 'Text', text: /sending in/ }))?.text).toBe('sending in 2…')
  await clock.advance(1000)
  expect((await ui.find({ type: 'Text', text: /sending in/ }))?.text).toBe('sending in 1…')
  expect(entered).toBe(0)
  // The hold runs out: the judges read the prompt, the band is back to its two buttons.
  await clock.advance(1000)
  await submit
  expect(entered).toBe(1)
  expect((await ui.find({ type: 'Text', text: /^high$/ }))?.text).toBe('high')
  expect(await ui.find({ type: 'Text', text: /sending in/ })).toBeUndefined()
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  expect(await ui.find({ key: 'auto' })).toBeDefined()
  await ui.unmount()

  // The second prompt goes straight in.
  await $.prompt.submit({ text: 'Explain the Horde', wait: false, origin: TYPED })
  expect(entered).toBe(2)
})

test('Manual already set: the first prompt does not wait; an agent-started turn neither waits nor spends the hold', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // A hand-back opens the session: no hold, and the person's first prompt still gets one.
  await $.prompt.submit({ text: '<task-notification>done</task-notification>', wait: false, origin: TYPED })
  const submit = $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  await clock.settle()
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /sending in/ }))?.text).toBe('sending in 3…')
  await ui.unmount()
  await clock.advance(HOLD_MS)
  await submit
})

test('Manual before the first prompt: no hold', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'manual' })
  await ui.unmount()
  // Resolves with the clock still: the hold saw Manual and ended at once.
  await $.prompt.submit({ text: 'Review the diff since abc123', wait: false, origin: TYPED })
  expect(clock.now()).toBe(0)
})

test('the draft is painted: the rule\'s span underlined, the verdict as ghost text after it; jev mode marks it the rules\' read', async () => {
  expect(readPromptMatch('Review the diff since abc123')).toEqual({ signal: { level: 'high', reason: 'verification words' }, start: 0, end: 6 })
  expect(readPromptMatch('  Where is the news kept?  ')).toEqual({ signal: { level: 'low', reason: 'prose or lookup words' }, start: 2, end: 10 })
  expect(readPromptMatch('Promote M7?')).toEqual({ signal: { level: 'low', reason: 'short question' }, start: 10, end: 11 })
  expect(paintDraft('', 'rules')).toEqual([])
  expect(paintDraft('   ', 'rules')).toEqual([])
  expect(paintDraft('Please review it', 'rules')).toEqual([
    { start: 7, end: 13, underline: true },
    { start: 16, end: 16, virtualText: ' → high · verification words', dimColor: true },
  ])
  expect(paintDraft('Promote M7', 'rules')).toEqual([{ start: 10, end: 10, virtualText: ' → nothing matched', dimColor: true }])
  expect(paintDraft('Promote M7', 'jev')[0]?.virtualText).toBe(' → nothing matched (rules\' read)')
})

test('a prompt judgment whooshes across the band\'s reason, then the reason settles; the reason truncates, the rest never does', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, {})
  on('tool.call', () => ({ result: 'ok' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await first($, clock, 'Review the diff since abc123')
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const width = WHOOSH.GRADES.length
  const reason = 'verification words'
  // Frame 0: the window's leading edge is on the first character, the strongest grade; the tail is off the left edge.
  const edge = await ui.find({ type: 'Text', text: /^v$/ })
  expect(edge?.props?.bold).toBe(true)
  expect(edge?.props?.dimColor).toBe(false)
  const whole = await ui.find({ type: 'Text', text: /verification words/ })
  expect(whole?.props?.wrap).toBe('truncate-end')
  expect(whole?.props?.dimColor).toBe(true)
  // The reason's box fills the row (so the buttons sit at the right edge) and is the one that shrinks.
  const grower = (await ui.findAll({ type: 'Box' })).find(b => b.props?.flexGrow === 1)
  expect(grower?.props?.flexShrink).toBe(1)
  expect(grower?.props?.minWidth).toBe(0)
  // Frame width - 1: the window is fully in, two bold undimmed characters at the leading edge, no color; two dim bold, then a plain one, behind.
  await clock.advance((width - 1) * WHOOSH.MS)
  const lead = await ui.find({ type: 'Text', text: new RegExp(`^${reason[width - 1]}$`) })
  expect(lead?.props?.bold).toBe(true)
  expect(lead?.props?.dimColor).toBe(false)
  expect(lead?.props?.color).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^v$/ }))?.props).toEqual({ bold: false, dimColor: false })
  expect((await ui.find({ type: 'Text', text: /^e$/ }))?.props).toEqual({ bold: true, dimColor: true })
  const graded = (all: { text?: string; props?: Record<string, unknown> }[]) => all.filter(t => t.text?.length === 1 && t.props?.dimColor === false)
  expect(graded(await ui.findAll({ type: 'Text' }))).toHaveLength(3)
  // Past the last frame the reason is whole and dim, no graded character left.
  await clock.advance((reason.length + width) * WHOOSH.MS)
  expect((await ui.find({ type: 'Text', text: /verification words/ }))?.text).toBe('· verification words')
  expect(graded(await ui.findAll({ type: 'Text' }))).toHaveLength(0)
  // The level is green, the countdown (not up) is not.
  expect((await ui.find({ type: 'Text', text: /^high$/ }))?.props?.color).toBe('success')
  // A plan step newly in progress whooshes too; the same step sent again does not.
  const planStep = (content: string) => $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content, status: 'in_progress' }] } as never)
  await planStep('Write the log line')
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /writing step/ }))?.text).toBe('· writing step')
  expect(graded(await ui.findAll({ type: 'Text' }))).toHaveLength(1)
  await clock.advance(('writing step'.length + width) * WHOOSH.MS)
  expect(graded(await ui.findAll({ type: 'Text' }))).toHaveLength(0)
  await planStep('Write the log line')
  await clock.settle()
  expect(graded(await ui.findAll({ type: 'Text' }))).toHaveLength(0)
  await ui.unmount()
})

test('levers.ts is tables only: no function leaves it, every walk row names a question, every question is walked or the null case', async () => {
  const levers = leversModule as Record<string, unknown>
  for (const [name, value] of Object.entries(levers)) expect(typeof value, name).not.toBe('function')
  for (const [kind, rows] of [['prompt', PROMPT_WALK], ['step', STEP_WALK]] as const) {
    const qs = kind === 'prompt' ? PROMPT_QUESTIONS : STEP_QUESTIONS
    for (const row of rows) for (const id of row.needs) expect(Object.keys(qs), `${kind} walk row "${row.reason}" needs ${id}`).toContain(id)
    const walked = new Set(rows.flatMap(r => r.needs))
    for (const id of Object.keys(qs)) expect(walked.has(id) || NULL_CASE[kind] === id, `${kind} question ${id} is never walked`).toBe(true)
  }
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
})

// --- 0.3.9: the default per model, grilling rounds, Manual recorded, envelopes ------

test('the default follows the model: fable high, the others medium, the model named in the reason and the ghost', async () => {
  expect(decide({ model: 'claude-fable-5-1' })).toEqual({ level: 'high', reason: 'nothing matched (fable default)', source: 'default' })
  expect(decide({ model: 'claude-opus-5-5' })).toEqual({ level: 'medium', reason: 'nothing matched (opus default)', source: 'default' })
  expect(decide({ model: 'claude-sonnet-5-5' })).toEqual({ level: 'medium', reason: 'nothing matched (sonnet default)', source: 'default' })
  expect(decide({ model: 'claude-haiku-5' })).toEqual({ level: 'medium', reason: 'nothing matched (haiku default)', source: 'default' })
  expect(decide({ model: 'some-other-model' })).toEqual({ level: 'medium', reason: 'nothing matched', source: 'default' })
  // The floors are unchanged.
  expect(applyFloor('claude-sonnet-5-5', 'low')).toEqual({ level: 'medium', floor: 'sonnet floor' })
  expect(paintDraft('Promote M7', 'rules', { model: 'claude-fable-5-1' })).toEqual([{ start: 10, end: 10, virtualText: ' → nothing matched (fable default)', dimColor: true }])
})

test('on fable the main loop defaults to high; a subagent keeps the main pick, then its own model\'s floor', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const efforts: (string | number | undefined)[] = []
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)
    yield* []

    return { turnId: e.turnId, index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await first($, clock, 'Promote M7')
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, effort: 'low', model: 'claude-fable-5-1', messageCount: 1 } as never)) void _
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, effort: 'low', model: 'claude-haiku-5', messageCount: 1, agentId: 'a1' } as never)) void _
  expect(efforts).toEqual(['high', 'high'])
  const shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  // The prompt was placed nowhere: the band says no change, and names the model's default.
  expect(shown.text).toBe('effort high · no change (fable default)')
})

test('a grilling-round answer runs high in a grilling, wayfinder or design stage; elsewhere the usual rules read it', async () => {
  const grilling = STAGE_BY_SKILL.grilling
  expect(grilling).toEqual({ level: 'high', reason: 'grilling skill' })
  expect(STAGE_BY_SKILL['wayfinder-obsidian']?.level).toBe('high')
  expect(PROMPT_WALK.find(r => r.reason === 'answers decide')?.level).toBe('high')
  expect(readPrompt('Q7, let\'s call them Autoplayers', grilling)).toEqual({ level: 'high', reason: 'grilling' })
  expect(readPrompt('1, yes. 2, skip', STAGE_BY_SKILL['wayfinder-obsidian'])).toEqual({ level: 'high', reason: 'grilling' })
  expect(readPrompt('1. as recommended', STAGE_BY_SKILL['codebase-design'])).toEqual({ level: 'high', reason: 'grilling' })
  expect(readPromptMatch('Q15, sure', grilling)).toEqual({ signal: { level: 'high', reason: 'grilling' }, start: 0, end: 3 })
  // An explicit ask still reaches xhigh; a decimal is not a round answer; no stage, no round.
  expect(readPrompt('Q2, think it through', grilling)?.level).toBe('xhigh')
  expect(readPrompt('1.5 seconds is fine', grilling)).toBeUndefined()
  expect(readPrompt('Q7, let\'s call them Autoplayers')).toBeUndefined()
  expect(readPrompt('Q7, let\'s call them Autoplayers', STAGE_BY_SKILL.build)).toBeUndefined()
  expect(paintDraft('Q7, ok', 'rules', { stage: grilling })[1]?.virtualText).toBe(' → high · grilling')
})

test('in jev mode a grilling-round answer runs high though Jev reads it as an answer only', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  on('http.fetch', () => ({ value: { ...OK, text: answer('prompt', { asks_for_work: 0.9, answer_only: 0.9, answers_questions: 0.2 }) } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Skill', skill: 'grilling' } as never)
  await first($, clock, 'Q7, let\'s not talk about them as players but Autoplayers')
  const shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort high · grilling')
})

test('a Manual turn is recorded with what Auto would have run; the report sets them side by side', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    yield* []

    return { turnId: e.turnId, index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'manual' })
  await ui.unmount()
  await first($, clock, 'Explain the Horde')
  await $.turn.start({ text: 'Explain the Horde', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, effort: 'xhigh', model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  const report = await $.command.run({ command: 'effort-report', args: '', origin: TYPED, presentation: SCREEN })
  expect(report.text).toContain('manual   1 turns by hand · Auto would have run lower 1 · the same 0 · higher 0')
  expect(report.text).toContain('low (prompt: prose or lookup words) → xhigh  "Explain the Horde"')
  // An Auto turn adds nothing there.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'auto' })
  await band.unmount()
  await $.prompt.submit({ text: 'Explain it again', wait: false, origin: TYPED })
  await $.turn.start({ text: 'Explain it again', turnId: 't2' })
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, effort: 'xhigh', model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
  await $.turn.complete({ turnId: 't2', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  const again = await $.command.run({ command: 'effort-report', args: '', origin: TYPED, presentation: SCREEN })
  expect(again.text).toContain('manual   1 turns by hand')
})

test('another session\'s message carries; a reply\'s quoted lines go to previous_reply, the ask to message', async ($, on) => {
  expect(isCarried('<cross-session-message from="local_9f5a">done</cross-session-message>')).toBe(true)
  const quoted = '<!-- reply 1 -->\n> The shown body goes with the next model change.\n> It is cut.\n\nwhat does that mean?'
  expect(focus(quoted)).toBe('what does that mean?')
  expect(quotedReply(quoted)).toBe('The shown body goes with the next model change.\nIt is cut.')
  expect(quotedReply('what does that mean?')).toBe('')
  expect(focus('> only a quote')).toBe('')

  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const sent: string[] = []
  on('http.fetch', (_, e) => {
    sent.push(e.init?.body ?? '')

    return { value: { ...OK, text: answer('prompt', { asks_for_work: 0.9, answer_only: 0.9 }) } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await first($, clock, quoted)
  expect(JSON.parse(sent[0] ?? '{}').state).toEqual({ message: 'what does that mean?', previous_reply: 'The shown body goes with the next model change.\nIt is cut.' })
})

test('the wrap-up runs low under any floor: the closing message is the one exception besides an acknowledgement', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  const efforts: (string | number | undefined)[] = []
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)
    yield* []

    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await first($, clock, 'Build the Horde')
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' } as never)
  for (const model of ['claude-haiku-5', 'claude-sonnet-5-5']) {
    for await (const _ of $.turn.step({ turnId: 't1', index: 1, effort: 'high', model, messageCount: 1 } as never)) void _
  }
  expect(efforts).toEqual(['low', 'low'])
  const shown = await $.command.run({ command: 'effort-show', args: '', origin: TYPED, presentation: SCREEN })
  expect(shown.text).toBe('effort low · wrap-up')
})

test('what the store keeps is scrubbed, notes included; /effort-report clear forgets everything the mod holds', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { mode: 'rules' })
  mock.env(on, { AUTO_EFFORT_REDACT: 'Jane' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const run = async (command: string, args: string) => (await $.command.run({ command, args, origin: TYPED, presentation: SCREEN })).text

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const text = 'Explain why Jane set password=hunter2 at https://intranet.corp/x'
  await first($, clock, text)
  await $.turn.start({ text, turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  const logged = await run('effort-miss', 'high mail jane.roe@example.com')
  for (const gone of ['Jane', 'hunter2', 'intranet', 'jane.roe']) expect(logged).not.toContain(gone)
  const report = await run('effort-report', '')
  for (const gone of ['Jane', 'hunter2', 'intranet', 'jane.roe']) expect(report).not.toContain(gone)
  expect(report).toContain('<name>')
  expect(report).toContain('<email>')

  expect(await run('effort-report', 'clear')).toBe('auto-effort: turns, misses, manual choices and the last Jev request cleared.')
  expect(await run('effort-report', '')).toBe('auto-effort: nothing recorded yet.')
  expect(await run('effort-jev', 'last')).toBe('effort: no Jev request yet this session.')
  expect(await run('effort-miss', 'low')).toBe('auto-effort: no finished turn to mark yet.')
})
