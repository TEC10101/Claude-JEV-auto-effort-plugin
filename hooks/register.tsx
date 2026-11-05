// auto-effort: picks the effort of each model request from the stage skill,
// the plan's step and the prompt's words; a band above the prompt shows the
// pick with Auto and Manual buttons: Manual leaves the app's own setting in
// charge (and a change of that setting switches to Manual by itself), Auto
// lets the rules pick again.
// Levels are the app's business; /effort-miss and /effort-report run the hill
// climb. In jev mode
// (/effort-mode jev) TypeSafe's Jev answers narrow yes/no questions about the
// prompt and the step, and a walk in rules.ts reads a level from them, in
// place of the word lists, which still run in its shadow for the report.
//
// The rules are in rules.ts. This file wires them to the engine's events.
// Helpers that take `$` are top-level functions: the validator follows `$`
// only into those.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AutoEffortDecision,
  AutoEffortChoice,
  AutoEffortJevFailure,
  AutoEffortJevResult,
  AutoEffortLevel,
  AutoEffortMiss,
  AutoEffortMode,
  AutoEffortSignal,
  AutoEffortSignals,
  AutoEffortTurn,
} from '../types'
import {
  applyFloor,
  applyPlan,
  buildRequest,
  capState,
  isCarried,
  isLevel,
  quotedReply,
  ROUND_ANSWER,
  VERSION,
  PROMPT_QUESTIONS,
  STEP_QUESTIONS,
  PROMPT_WALK,
  STEP_WALK,
  tailOf,
  combine,
  standAside,
  decide,
  defaultName,
  failureOf,
  focus,
  formatReport,
  HOLD_MS,
  inProgress,
  paintDraft,
  WHOOSH,
  isJudgment,
  JEV,
  LEVEL_BY_AGENT_TYPE,
  levelWord,
  parseAnswer,
  readLevel,
  readPrompt,
  readStep,
  redactNames,
  scrub,
  STAGE_BY_SKILL,
  stageState,
  walk,
  WRAP_UP,
} from './rules'
import type { JevKind, JevState, PlanArgs, PlanItem } from './rules'

// Bump the shape tag when AutoEffortSignals changes: a reload then declines
// what the old code stored.
const signals = atom({ plugin: 'auto-effort', key: 'signals' } as const, {} as AutoEffortSignals, {
  shape: 'signals-10',
})

/** How long the band stays up after the effort changes, and after /effort-show with no number. */
const BAND_MS = 4000
const SHOW_MS = 10000
/** `bandUntil` for /effort-show -1: the band stays until /effort-show 0. */
const ALWAYS = Number.MAX_SAFE_INTEGER

const TURNS = 'turns'
const MISSES = 'misses'
const MANUAL = 'manual'
const MODE = 'mode'
const TURNS_KEPT = 400
const MISSES_KEPT = 200
const MANUAL_KEPT = 200
const JEV_STEPS_KEPT = 8
/** The most plan items of each kind (done, ahead) sent with a step: the nearest ones. */
const JEV_PLAN_ITEMS = 12
const TEST_PROMPT = 'Review the diff since main for regressions in the motion code'

type Running = {
  id: string
  head: string
  steps: number
  startedAt: number
  /** The submit this turn answers, so a late Jev answer finds its row. */
  token?: number
  /** Jev's answers on the prompt and on each step this turn, in jev mode. */
  jevPrompt?: AutoEffortJevResult
  jevSteps?: AutoEffortJevResult[]
  /** What the word lists said, kept beside Jev's answers; `rulesSteps` is parallel to `jevSteps`. */
  rulesPrompt?: AutoEffortSignal
  rulesSteps?: (AutoEffortSignal | null)[]
  /** What each main-loop request ran at, and the decision at the first one. */
  ran: Record<string, number>
  first?: AutoEffortDecision
  /** In Manual: what Auto would have run at the first request (the floor applied), and what did run. The Manual row of the hill climb. */
  auto?: AutoEffortDecision
  firstRan?: string
}

// The session's running state. Module variables start over on a hot reload,
// which only forgets the turn in flight; the signals and the store survive.
let plan: PlanItem[] = []
let running: Running | undefined
let head = ''
let lastTurn: AutoEffortTurn | undefined
/** The prompt's two verdicts, held from prompt.submit until the turn.start of the same prompt opens the row. */
let pendingPrompt: { head: string; token: number; jev?: AutoEffortJevResult; rules?: AutoEffortSignal } | undefined
let submits = 0
/** The turn's prompt as Jev may see it (scrubbed, capped), for the step's state. */
let promptState = ''
/** The tail of the assistant's last answer, scrubbed: sent with the next prompt as `previous_reply`, since a short message often answers it. */
let lastReply = ''
/** The last finished turn's prompt signal: a turn the agent started (a hand-back, a notification) carries it instead of being judged on the envelope. */
let lastPrompt: AutoEffortSignal | undefined
/** The step last judged and what the slot got, so a plan update that keeps or re-enters the step does not ask again. */
let lastStep: { content: string; signal: AutoEffortSignal | undefined } | undefined
/** Requests made this session; a late answer to an older one does not overwrite `lastJev`. */
let requests = 0
const agentTypes = new Map<string, string>()
/** The failure kinds already toasted this session: one toast per kind. */
const toasted = new Set<string>()

/** The names AUTO_EFFORT_REDACT gives, read at session.start: scrubbed with the patterns. */
let redact: string[] = []
/** Every text that leaves the machine or enters the store goes through here. */
const clean = (text: string): string => scrub(text, redact)
/** A prompt's first 80 characters, scrubbed: the row's `prompt`. */
const headOf = (text: string): string => clean(text).replace(/\s+/g, ' ').trim().slice(0, 80)

/** The signals without the keys named: `$.state` takes no `undefined` field. */
function without(s: AutoEffortSignals, ...keys: (keyof AutoEffortSignals)[]): AutoEffortSignals {
  const rest: AutoEffortSignals = { ...s }
  for (const key of keys) delete rest[key]
  return rest
}

async function stamp($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString()
}

async function push($: EngineInterface, key: string, item: unknown, cap: number): Promise<void> {
  const list = ((await $.store.get(key)) as unknown[] | undefined) ?? []
  list.push(item)
  await $.store.set(key, list.slice(-cap))
}

/** Manual: the app's own setting runs, the rules set aside, until Auto. */
async function setManual($: EngineInterface, reason: string): Promise<void> {
  await switchTo($, 'manual', reason)
}

/** Auto: the rules (or Jev) pick again. */
async function setAuto($: EngineInterface): Promise<void> {
  await switchTo($, 'auto', '')
}

/**
 * Manual or Auto from the band. While the band shows a turn's effort (the turn
 * running, past its first model request, or the last one between turns) the
 * switch waits for the next judgment (`pending`): a prompt, a plan step newly
 * in progress, the wrap-up, a stage skill loaded (0.4.3; until then, the next
 * prompt). Nothing is judged at the press, the requests in between run as they
 * were, and the band keeps its level marked `(last turn)`. Pressing back calls
 * the switch off. Before any turn, in the first prompt's hold, or in a turn not
 * yet sent to the model (0.4.2: a slash command's turn opens a few seconds
 * before its first request), it is at once.
 */
async function switchTo($: EngineInterface, to: 'manual' | 'auto', reason: string): Promise<void> {
  const s = await read($, signals)
  const turnRan = running !== undefined && running.steps > 0
  if ((turnRan || (running === undefined && s.last !== undefined)) && s.countdown === undefined) {
    const already = to === 'manual' ? s.manual !== undefined : s.manual === undefined
    await update($, signals, x => (already ? without(x, 'pending') : { ...x, pending: { to, reason } }))
    return
  }
  await update($, signals, x => (to === 'manual' ? { ...without(x, 'pending'), manual: { reason } } : without(x, 'pending', 'manual')))
  await announce($)
}

/** The next judgment: a switch pressed since the last one takes effect. */
async function applyPending($: EngineInterface): Promise<void> {
  if (!(await read($, signals)).pending) return
  await update($, signals, s => {
    const p = s.pending
    if (!p) return s
    const rest = without(s, 'pending', 'manual')
    return p.to === 'manual' ? { ...rest, manual: { reason: p.reason } } : rest
  })
  await announce($)
}

/** Draws the band until `until`, then hides it: the hide is a timer that clears `bandUntil` unless a later or longer show moved it. A band kept up (ALWAYS) is never shortened. */
async function showBand($: EngineInterface, ms: number): Promise<void> {
  const until = (await $.clock.now()) + ms
  await update($, signals, s => ({ ...s, bandUntil: Math.max(s.bandUntil ?? 0, until) }))
  $.clock.after(ms + 50, () => {
    void update($, signals, s => (s.bandUntil !== undefined && s.bandUntil <= until ? without(s, 'bandUntil') : s))
  })
}

/**
 * Holds the session's first typed prompt for HOLD_MS, a second at a time, the
 * band counting down: Manual (the app's setting keeps the session) or Send now
 * ends it early, as does the person's interrupt. Marks the hold done either way.
 */
async function hold($: EngineInterface, signal: AbortSignal): Promise<void> {
  const whole = Math.round(HOLD_MS / 1000)
  for (let left = whole; left > 0; left--) {
    const s = await read($, signals)
    if (s.manual || (left < whole && s.countdown === undefined)) break
    await update($, signals, x => ({ ...x, countdown: left }))
    try {
      await $.clock.sleep(1000, { signal })
    } catch {
      break
    }
  }
  await update($, signals, x => ({ ...without(x, 'countdown'), held: true as const }))
}

/** The whoosh's generation: a judgment that lands mid-ripple starts a new one, and the old frames stop. */
let whooshes = 0

/** How many frames the whoosh over `reason` takes: the window enters from the left edge and leaves past the right. */
const whooshFrames = (reason: string): number => reason.length + WHOOSH.GRADES.length - 1

/**
 * The whoosh: shows the band and slides `ripple`, the window's leading edge,
 * across the reason one character per frame, a frame every WHOOSH.MS, then
 * clears it. Scheduled on the clock, not awaited: the submit goes on while the
 * band moves.
 */
async function whoosh($: EngineInterface): Promise<void> {
  const gen = ++whooshes
  await showBand($, BAND_MS)
  const frames = whooshFrames(describeEffort(await read($, signals)).reason)
  for (let i = 0; i < frames; i++) {
    $.clock.after(i * WHOOSH.MS, () => {
      if (gen === whooshes) void update($, signals, s => ({ ...s, ripple: i }))
    })
  }
  $.clock.after(frames * WHOOSH.MS, () => {
    if (gen === whooshes) void update($, signals, s => without(s, 'ripple'))
  })
}

type Grade = (typeof WHOOSH.GRADES)[number]

/** The reason split for the whoosh's frame: the plain text before the window, each character in it with its grade, the plain text after. */
function rippled(reason: string, frame: number | undefined): { before: string; window: { char: string; grade: Grade }[]; after: string } {
  if (frame === undefined) return { before: reason, window: [], after: '' }
  const width = WHOOSH.GRADES.length
  // The leading edge is at `frame`; the window's first character sits width - 1 before it, off the left edge in the first frames.
  const start = frame - (width - 1)
  const window: { char: string; grade: Grade }[] = []
  for (let k = 0; k < width; k++) {
    const at = start + k
    const grade = WHOOSH.GRADES[k]
    if (at >= 0 && at < reason.length && grade) window.push({ char: reason[at] ?? '', grade })
  }
  const from = Math.max(0, start)
  const to = Math.min(reason.length, start + width)
  return { before: reason.slice(0, from), window, after: reason.slice(Math.max(from, to)) }
}

/** Send now: ends the first prompt's hold. */
async function sendNow($: EngineInterface): Promise<void> {
  await update($, signals, s => without(s, 'countdown'))
}

/**
 * The words the band and /effort-show print: the level (the model's floor
 * applied, named in the reason) or the app's setting. Between turns the last
 * turn's pick stays up marked `(last turn)`, whatever decided it; the next
 * turn's first event (the prompt, or the turn itself when the agent started
 * it) drops the mark, so a reason without it is this turn's.
 */
function describeEffort(s: AutoEffortSignals): { level: string; reason: string } {
  const d = decide(s)
  // Between turns (`last` is set) the mark says the words are not this turn's, in Manual too; so does a switch
  // pressed mid-turn (`pending`): the turn runs on as it was until the next.
  const mark = s.last || s.pending ? ' (last turn)' : ''
  // Manual: the app's setting runs; the Manual button on the band says so, the level needs no suffix.
  if (d.level === 'manual' || d.level === 'session') return { level: levelWord(s.engine), reason: `${d.reason}${mark}` }
  if (s.last) return { level: s.last.level, reason: `${s.last.reason}${mark}` }
  const floored = applyFloor(s.model ?? '', d.level, d.underFloor)
  // The prompt was evaluated and placed nowhere: what was deciding goes on deciding, and the band says so.
  // The default names its model there too: `no change (jev unsure; fable default)`.
  const notes = [s.unplaced?.reason, d.source === 'default' ? defaultName(s.model) : undefined].filter(Boolean)
  const reason = (d.source === 'stage' || d.source === 'default') && s.unplaced ? (notes.length ? `no change (${notes.join('; ')})` : 'no change') : d.reason
  return { level: floored.level, reason: `${floored.floor ? `${reason} (${floored.floor})` : reason}${mark}` }
}

/** /effort-show's argument: seconds to show, 0 to hide, -1 to keep it up; none is SHOW_MS. */
async function showFor($: EngineInterface, arg: string): Promise<string> {
  const word = arg.trim()
  const n = word === '' ? SHOW_MS / 1000 : Number(word)
  if (!Number.isFinite(n) || n < -1) return 'Usage: /effort-show [seconds] — ten by default; 0 hides the band; -1 keeps it up until /effort-show 0.'
  if (n === 0) {
    await update($, signals, s => without(s, 'bandUntil'))
    return 'band hidden'
  }
  if (n === -1) {
    await update($, signals, s => ({ ...s, bandUntil: ALWAYS }))
    return 'band up until /effort-show 0'
  }
  await showBand($, n * 1000)
  return `band up for ${n} s`
}

/** Pops the band for BAND_MS when the decision differs from the choice it last showed. */
async function announce($: EngineInterface): Promise<void> {
  const s = await read($, signals)
  const choice: AutoEffortChoice = decide(s).level
  if (choice === s.shown) return
  await update($, signals, x => ({ ...x, shown: choice }))
  await showBand($, BAND_MS)
}

// --- Jev ----------------------------------------------------------------------

/** The judge in force: `rules` only when the store says so; the default is `jev` (0.2.0), which falls back to the rules by itself without a key. */
async function readMode($: EngineInterface): Promise<AutoEffortMode> {
  return (await $.store.get(MODE)) === 'rules' ? 'rules' : 'jev'
}

async function setMode($: EngineInterface, mode: AutoEffortMode): Promise<void> {
  await $.store.set(MODE, mode)
  await update($, signals, s => ({ ...s, mode }))
}

const hasKey = async ($: EngineInterface): Promise<boolean> => ((await $.env.get('TYPESAFE_API_KEY')) ?? '') !== ''

/** A one-shot timer as a promise: resolves `undefined` when the deadline passes; `cancel` to drop it. */
function deadline($: EngineInterface, ms: number): { passed: Promise<undefined>; cancel: () => void } {
  let timer: { cancel: () => void } | undefined
  const passed = new Promise<undefined>(resolve => {
    timer = $.clock.after(ms, () => resolve(undefined))
  })
  return { passed, cancel: () => timer?.cancel() }
}

function toastFailure($: EngineInterface, failure: AutoEffortJevFailure): void {
  if (toasted.has(failure.kind)) return
  toasted.add(failure.kind)
  const words: Record<AutoEffortJevFailure['kind'], string> = {
    'no-key': 'no TYPESAFE_API_KEY in the environment',
    unauthorized: 'the key was refused',
    'rate-limit': 'rate limited',
    overloaded: 'TypeSafe is overloaded',
    server: 'TypeSafe answered with a server error',
    timeout: `no answer within ${JEV.DEADLINE_MS} ms`,
    network: `network error${failure.status ? ` (${failure.status})` : ''}`,
    'bad-request': 'TypeSafe refused the request as malformed',
    'bad-answer': 'the answer had the wrong shape',
  }
  $.ui.toast(`effort: jev ${words[failure.kind]}; the rules decide. /effort-mode rules to stop asking`)
}

/**
 * Asks Jev the questions of `kind` about `state`, with the deadline: the
 * answers, or the failure that stood in their way (the rules decide then). A
 * late answer is recorded on the turn row through `onLate` with its real latency.
 */
async function judge(
  $: EngineInterface,
  kind: JevKind | 'test',
  state: JevState,
  onLate?: (result: AutoEffortJevResult) => void,
): Promise<AutoEffortJevResult> {
  const asked: JevKind = kind === 'step' ? 'step' : 'prompt'
  const request = ++requests
  const key = await $.env.get('TYPESAFE_API_KEY')
  const started = await $.clock.now()
  const record = async (result: AutoEffortJevResult) => {
    const at = new Date(await $.clock.now()).toISOString()
    if (request === requests) await update($, signals, s => ({ ...s, lastJev: { at, kind, state: JSON.stringify(state), result } }))
    if (!isJudgment(result)) toastFailure($, result)
    return result
  }
  if (!key) return record({ kind: 'no-key' })
  try {
    return await ask($, asked, key, state, started, record, onLate)
  } catch (error) {
    return record({ kind: 'network', ms: (await $.clock.now()) - started }).then(r => {
      $.ui.toast(`effort: jev call failed: ${String(error)}`)
      return r
    })
  }
}

async function ask(
  $: EngineInterface,
  asked: JevKind,
  key: string,
  state: JevState,
  started: number,
  record: (result: AutoEffortJevResult) => Promise<AutoEffortJevResult>,
  onLate: ((result: AutoEffortJevResult) => void) | undefined,
): Promise<AutoEffortJevResult> {
  const body = buildRequest(asked, state)
  const reply = $.http
    .fetch(JEV.URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body })
    .then(
      async (r): Promise<AutoEffortJevResult> => {
        const ms = (await $.clock.now()) - started
        return r.ok ? parseAnswer(r.text, asked, ms) : failureOf(r.status, ms)
      },
      async (): Promise<AutoEffortJevResult> => ({ kind: 'network', ms: (await $.clock.now()) - started }),
    )
  const limit = deadline($, JEV.DEADLINE_MS)
  const first = await Promise.race([reply, limit.passed])
  limit.cancel()
  if (first !== undefined) return record(first)
  void reply.then(result => {
    result.late = true
    if (isJudgment(result)) onLate?.(result)
    void record(result)
  })
  return record({ kind: 'timeout', ms: JEV.DEADLINE_MS })
}

/** The /effort-jev printout of one request. */
function describeJev(last: NonNullable<AutoEffortSignals['lastJev']>): string {
  const r = last.result
  let answer: string
  if (isJudgment(r)) {
    const v = walk(r)
    const verdict = v.kind === 'level' ? `${v.signal.level} · ${v.signal.reason}` : v.kind === 'none' ? `${v.signal.level} · ${v.signal.reason}` : 'unsure · the rules decide'
    answer =
      `${verdict} · ${r.ms} ms · ${r.model}${r.late ? ' · late' : ''}\n` +
      `answers ${Object.entries(r.nouls)
        .map(([id, p]) => `${id} ${p.toFixed(2)}`)
        .join(' · ')}`
  } else {
    answer = `failed: ${r.kind}${r.status ? ` (${r.status})` : ''}${r.ms !== undefined ? ` after ${r.ms} ms` : ''}`
  }
  return `jev ${last.kind} at ${last.at}\nstate ${last.state}\n${answer}`
}

/** Jev's answers and the rules' signal on one state, combined: what the slot gets, and both verdicts for the row. */
async function judgeSignal(
  $: EngineInterface,
  kind: JevKind,
  state: JevState,
  rules: AutoEffortSignal | undefined,
  onLate: (result: AutoEffortJevResult) => void,
): Promise<{ signal: AutoEffortSignal | undefined; jev: AutoEffortJevResult }> {
  const jev = await judge($, kind, state, onLate)
  return { signal: combine(jev, rules), jev }
}

/** The version and the question set the installed copy asks, with the walk: what a session is really running. */
function describeQuestions(): string {
  const set = (name: string, qs: Readonly<Record<string, { instructions: string }>>, walk: readonly { level: string; reason: string; needs: readonly string[] }[]) => [
    `${name}: ${Object.keys(qs).length} questions`,
    ...Object.entries(qs).map(([id, q]) => `  ${id}: ${q.instructions}`),
    `  walk: ${walk.map(r => `${r.needs.join('+')} → ${r.level}`).join(' · ')}`,
  ]
  return [`auto-effort ${VERSION} · levers.ts`, ...set('prompt', PROMPT_QUESTIONS, PROMPT_WALK), ...set('step', STEP_QUESTIONS, STEP_WALK)].join('\n')
}

async function registerCommands($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'effort-mode',
    description: 'Which judge reads the prompt and the step: jev (TypeSafe, the default) or rules (the word lists); with none, prints the mode and whether a key was found',
    immediate: true,
  })
  await $.command.register({
    name: 'effort-jev',
    description: 'last: the last Jev request as sent and its answer; test: fire a canned prompt at Jev and print the same; questions: the version and the question set this copy asks',
    immediate: true,
  })
  await $.command.register({
    name: 'effort-show',
    description: 'Show the effort band: for ten seconds, for N seconds, 0 to hide it, -1 to keep it up',
    immediate: true,
  })
  await $.command.register({
    name: 'effort-miss',
    description: 'Mark the last turn as one that should have run at this effort',
    immediate: true,
  })
  await $.command.register({
    name: 'effort-report',
    description: 'The hill climb: turns by level and source, and every miss; "clear" empties it',
    immediate: true,
  })
}

async function markLastTurn($: EngineInterface, level: AutoEffortLevel, note: string): Promise<string> {
  if (!lastTurn) return 'auto-effort: no finished turn to mark yet.'
  const miss: AutoEffortMiss = { at: await stamp($), prompt: lastTurn.prompt, chosen: level, how: 'miss-command' }
  if (lastTurn.decision) miss.ran = lastTurn.decision
  if (note) miss.note = clean(note)
  await push($, MISSES, miss, MISSES_KEPT)
  const ran = lastTurn.decision
    ? `${lastTurn.decision.level} (${lastTurn.decision.reason})`
    : `${levelWord(lastTurn.engine)} (app setting)`
  return `Logged: "${lastTurn.prompt}" ran ${ran}, should have been ${level}.`
}

async function report($: EngineInterface, args: string): Promise<string> {
  if (args.trim() === 'clear') {
    await $.store.delete(TURNS)
    await $.store.delete(MISSES)
    await $.store.delete(MANUAL)
    // What the session holds in memory goes too: the last request as sent, the last turn, the last reply and prompt.
    await update($, signals, s => without(s, 'lastJev'))
    lastTurn = undefined
    lastReply = ''
    promptState = ''
    head = ''
    pendingPrompt = undefined
    return 'auto-effort: turns, misses, manual choices and the last Jev request cleared.'
  }
  const turns = ((await $.store.get(TURNS)) as AutoEffortTurn[] | undefined) ?? []
  const misses = ((await $.store.get(MISSES)) as AutoEffortMiss[] | undefined) ?? []
  const manual = ((await $.store.get(MANUAL)) as AutoEffortMiss[] | undefined) ?? []
  return formatReport(turns, misses, manual)
}

async function finishTurn($: EngineInterface, outputTokens: number | undefined, answer: string): Promise<void> {
  lastReply = tailOf(clean(answer))
  const s = await read($, signals)
  if (!s.prompt || s.prompt.source !== 'carried') lastPrompt = s.prompt
  const now = await $.clock.now()
  const turn: AutoEffortTurn = {
    at: new Date(now).toISOString(),
    prompt: running?.head || head,
    steps: running?.steps ?? 0,
    seconds: running ? Math.round((now - running.startedAt) / 1000) : 0,
  }
  turn.decision = decide(s)
  if (running?.first) turn.first = running.first
  if (running && Object.keys(running.ran).length) turn.ran = running.ran
  if (s.engine !== undefined) turn.engine = s.engine
  if (outputTokens !== undefined) turn.outputTokens = outputTokens
  turn.mode = s.mode ?? 'rules'
  if (running?.jevPrompt || running?.jevSteps) {
    turn.jev = {}
    if (running.jevPrompt) turn.jev.prompt = running.jevPrompt
    if (running.jevSteps) turn.jev.steps = running.jevSteps
  }
  if (running?.rulesPrompt || running?.rulesSteps) {
    turn.rules = {}
    if (running.rulesPrompt) turn.rules.prompt = running.rulesPrompt
    if (running.rulesSteps) turn.rules.steps = running.rulesSteps
  }
  await push($, TURNS, turn, TURNS_KEPT)
  if (running?.first?.source === 'manual' && running.auto && running.firstRan && isLevel(running.firstRan)) {
    const row: AutoEffortMiss = { at: turn.at, prompt: turn.prompt, ran: running.auto, chosen: running.firstRan, how: 'manual' }
    await push($, MANUAL, row, MANUAL_KEPT)
  }
  lastTurn = turn
  running = undefined
  head = ''
  lastStep = undefined
  const last = describeEffort(without(s, 'pending'))
  await update($, signals, x => ({ ...without(x, 'prompt', 'step', 'unplaced'), last }))
}

export const register: Register = on => {
  // --- commands ---------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    redact = redactNames(await $.env.get('AUTO_EFFORT_REDACT'))
    await registerCommands($)
    const mode = await readMode($)
    // The band is up by default (0.2.1): /effort-show 0 hides it for the session, /effort-show N for a while.
    await update($, signals, s => ({ ...s, mode, bandUntil: s.bandUntil ?? ALWAYS }))
    if (mode === 'rules' && (await hasKey($))) $.ui.toast('effort: rules mode; /effort-mode jev to try Jev')

    return next(e)
  })

  on('command.run', { command: 'effort-mode' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    if (word === '') {
      const mode = await readMode($)
      const key = (await hasKey($)) ? 'TYPESAFE_API_KEY found' : 'no TYPESAFE_API_KEY in the environment'
      return { text: `auto-effort ${VERSION} · effort mode ${mode} · ${key}` }
    }
    if (word !== 'jev' && word !== 'rules') return { text: 'Usage: /effort-mode [jev|rules] — jev asks TypeSafe\'s Jev about each prompt and step; rules uses the word lists. No argument prints the mode.' }
    await setMode($, word)
    const note = word === 'jev' && !(await hasKey($)) ? ' (no TYPESAFE_API_KEY found: the rules will decide until a session sees one)' : ''

    return { text: `effort mode ${word}${note}.` }
  })

  on('command.run', { command: 'effort-jev' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    if (word === 'test') {
      if (!(await hasKey($))) return { text: 'effort: no TYPESAFE_API_KEY in the environment; nothing sent.' }
      const s = await read($, signals)
      await judge($, 'test', { message: capState(clean(TEST_PROMPT)), ...stageState(s.stage) })
      const last = (await read($, signals)).lastJev
      return { text: last ? `key found\n${describeJev(last)}` : 'effort: nothing recorded.' }
    }
    if (word === 'last' || word === '') {
      const last = (await read($, signals)).lastJev
      return { text: last ? describeJev(last) : 'effort: no Jev request yet this session.' }
    }

    if (word === 'questions') return { text: describeQuestions() }
    return { text: 'Usage: /effort-jev last|test|questions — last prints the last request as sent and its answer; test fires a canned prompt; questions prints the version and the question set.' }
  })

  on('command.run', { command: 'effort-show' }, async ($, e) => {
    const shown = await showFor($, e.args)
    if (shown.startsWith('Usage')) return { text: shown }
    const s = await read($, signals)
    const shownEffort = describeEffort(s)
    const effort = `effort ${shownEffort.level} · ${shownEffort.reason}`

    return { text: e.args.trim() === '' ? effort : `${effort} (${shown})` }
  })

  on('command.run', { command: 'effort-miss' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    const level = readLevel(first)
    if (!level) return { text: 'Usage: /effort-miss <level> [note] — marks the last finished turn as one that should have run at <level>.' }

    return { text: await markLastTurn($, level, rest.join(' ')) }
  })

  on('command.run', { command: 'effort-report' }, async ($, e) => ({ text: await report($, e.args) }))

  // --- signals ----------------------------------------------------------------

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta) return next(e)
    // A skill run as a slash command sets the stage the Skill tool would; its arguments are the ask. Any other command is the app's.
    let raw = e.text
    let commandStage: AutoEffortSignal | undefined
    if (e.command) {
      commandStage = STAGE_BY_SKILL[e.command.name]
      if (!commandStage) return next(e)
      raw = e.command.args
    }
    // The turn this prompt opens takes a switch pressed during the last one.
    await applyPending($)
    if (commandStage) {
      if (!raw.trim()) {
        const stage = commandStage
        await update($, signals, s => ({ ...without(s, 'prompt', 'step', 'last', 'unplaced'), stage }))
        await announce($)

        return next(e)
      }
    }
    // The judges and the row read the ask, not the app's reminders nor a brief's Background; a message that is only a reminder is read whole.
    const text = focus(raw) || raw
    head = headOf(text)
    promptState = capState(clean(text))
    lastStep = undefined
    // A reply quoting the last answer: the quote is the previous reply, the rest the ask (focus dropped it).
    const quote = quotedReply(raw)
    const stageNow = commandStage ?? (await read($, signals)).stage
    const rules = readPrompt(text, stageNow)
    let prompt = rules
    let why = ''
    const carried = isCarried(text)
    // The session's first typed prompt waits HOLD_MS so Manual can be set first; a turn the agent started is not the person's.
    if (!carried && !(await read($, signals)).held) await hold($, next.signal)
    const before = await read($, signals)
    const token = ++submits
    const pending: NonNullable<typeof pendingPrompt> = { head, token }
    if (rules) pending.rules = rules
    pendingPrompt = pending
    if (carried) {
      // The agent started this turn: the ask is the last turn's, so its prompt signal carries.
      prompt = lastPrompt ? { ...lastPrompt, reason: `${lastPrompt.reason} (carried)`, source: 'carried' } : undefined
      why = lastPrompt ? '' : 'carried, no prompt to carry'
    } else if ((await readMode($)) === 'jev') {
      const previous = quote ? tailOf(clean(quote)) : lastReply
      const state: JevState = { message: promptState, ...(previous ? { previous_reply: previous } : {}), ...stageState(commandStage ?? before.stage) }
      const judged = await judgeSignal($, 'prompt', state, rules, late => {
        if (pendingPrompt?.token === token) pendingPrompt.jev = late
        else if (running?.token === token) running.jevPrompt = late
      })
      // A grilling-round answer is the word rule's, whatever Jev read (ROUND_ANSWER).
      const round = rules?.reason === ROUND_ANSWER.reason
      prompt = round ? rules : judged.signal
      why = round ? '' : standAside(judged.jev)
      // A late answer may have landed while the timeout was being recorded: it stays.
      if (!isJudgment(pending.jev)) pending.jev = judged.jev
    }
    await update($, signals, s => {
      const changed = without(s, 'prompt', 'step', 'last', 'unplaced')
      if (commandStage) changed.stage = commandStage
      if (prompt) changed.prompt = prompt
      else changed.unplaced = { reason: why }

      return changed
    })
    await announce($)
    await whoosh($)

    return next(e)
  })

  // The draft, painted as it is typed: the rules' span underlined, their verdict as ghost text (DRAFT_PAINT).
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    const s = await read($, signals)
    const mine = paintDraft(r.text, await readMode($), { ...(s.model ? { model: s.model } : {}), ...(s.stage ? { stage: s.stage } : {}) })
    return mine.length ? { ...r, decorations: [...(r.decorations ?? []), ...mine] } : r
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const stage = e.agentId === undefined ? STAGE_BY_SKILL[e.skill] : undefined
    if (stage) {
      await update($, signals, s => ({ ...s, stage }))
      await applyPending($)
      await announce($)
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      plan = applyPlan(plan, e as unknown as PlanArgs)
      const step = inProgress(plan)
      // A step newly in progress is a judgment, in rules mode too: the band whooshes for it below.
      const judged = step !== undefined && step.content !== lastStep?.content
      const rules = step ? readStep(step.content) : undefined
      let signal = rules
      if (step && (await readMode($)) === 'jev') {
        if (lastStep?.content === step.content) {
          signal = lastStep.signal
        } else {
          const before = await read($, signals)
          const steps = running ? (running.jevSteps ??= []) : []
          const rulesSteps = running ? (running.rulesSteps ??= []) : []
          const at = steps.length
          const kept = at < JEV_STEPS_KEPT
          if (kept) {
            steps.push({ kind: 'timeout' })
            rulesSteps.push(rules ?? null)
          }
          // Plan text is capped like the prompt: each item, and the lists as a whole.
          const done = plan.filter(i => i.status === 'completed').map(i => capState(clean(i.content))).slice(-JEV_PLAN_ITEMS)
          const ahead = plan.filter(i => i.status === 'pending').map(i => capState(clean(i.content))).slice(0, JEV_PLAN_ITEMS)
          const state: JevState = {
            prompt: promptState,
            plan: { step: capState(clean(step.content)), ...(done.length ? { done } : {}), ...(ahead.length ? { ahead } : {}) },
            ...stageState(before.stage),
          }
          const judged = await judgeSignal($, 'step', state, rules, late => {
            if (kept) steps[at] = late
          })
          if (kept && !isJudgment(steps[at])) steps[at] = judged.jev
          signal = judged.signal
          lastStep = { content: step.content, signal }
        }
      }
      if (step) lastStep = { content: step.content, signal }
      await update($, signals, s => (signal ? { ...s, step: signal } : without(s, 'step')))
      // A step newly in progress is the next judgment: a switch pressed since the last one takes effect here.
      if (judged) await applyPending($)
      await announce($)
      if (judged) await whoosh($)
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, signals, s => ({ ...s, step: WRAP_UP }))
      await applyPending($)
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId) agentTypes.set(spawned.agentId, e.subagentType)

    return spawned
  })

  // --- the switch -------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      running = { id: e.turnId, head: head || headOf(e.text), steps: 0, startedAt: await $.clock.now(), ran: {} }
      if (pendingPrompt && pendingPrompt.head === headOf(e.text)) {
        running.token = pendingPrompt.token
        if (pendingPrompt.jev) running.jevPrompt = pendingPrompt.jev
        if (pendingPrompt.rules) running.rulesPrompt = pendingPrompt.rules
      }
      pendingPrompt = undefined
      await applyPending($)
      // The turn is on, whoever started it: the last turn's mark comes off the band.
      await update($, signals, s => without(s, 'last'))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let level: AutoEffortChoice | undefined
    let underFloor: true | undefined
    if (e.agentId === undefined) {
      if (running) running.steps += 1
      const s = await read($, signals)
      if (e.index === 0 && s.model !== e.model) {
        const model = e.model
        await update($, signals, x => ({ ...x, model }))
      }
      // The app's setting, read at every request (0.4.4; the first request only before): `e.effort` is the
      // setting, never the mod's last pick, so the band names what Manual runs at once it moves mid-turn.
      if (e.effort !== undefined && s.engine !== e.effort) {
        const engine = e.effort
        const changed = s.engine !== undefined
        if (e.index === 0) {
          // Changed since the last turn: that is the choice, Manual until Auto, from this request.
          await update($, signals, x => (changed ? { ...x, engine, manual: { reason: 'user override' } } : { ...x, engine }))
          if (changed) await announce($)
        } else {
          // Changed mid-turn: the same choice, and like the Manual button it waits for the next judgment.
          await update($, signals, x => ({ ...x, engine }))
          if (changed) await switchTo($, 'manual', 'user override')
        }
      }
      const now = await read($, signals)
      const d = decide(now)
      level = d.level
      underFloor = d.underFloor
      if (running && !running.first) {
        running.first = d
        // In Manual, what Auto would have run here, the floor applied: the row the hill climb learns from.
        if (d.source === 'manual') {
          const auto = decide(without(now, 'manual'))
          if (auto.level !== 'manual' && auto.level !== 'session') running.auto = { ...auto, level: applyFloor(e.model, auto.level, auto.underFloor).level }
        }
      }
    } else {
      // A subagent: in Auto the mod's pick wins over the Agent call's own effort (its type's row, else the
      // main loop's decision); in Manual everything is left alone, the subagent included.
      const s = await read($, signals)
      const type = agentTypes.get(e.agentId)
      level = s.manual ? 'manual' : ((type === undefined ? undefined : LEVEL_BY_AGENT_TYPE[type]?.level) ?? decide(s).level)
    }
    const picked = level === undefined || level === 'manual' || level === 'session' ? undefined : applyFloor(e.model, level, underFloor).level
    const ran = levelWord(picked ?? e.effort)
    if (e.agentId === undefined && running) {
      running.ran[ran] = (running.ran[ran] ?? 0) + 1
      running.firstRan ??= ran
    }
    if (picked === undefined || picked === e.effort) return yield* next(e)

    return yield* next({ ...e, effort: picked })
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await finishTurn($, e.usage?.output_tokens, e.answer ?? '')

    return next(e)
  })

  // --- the band ---------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, signals)
    if (s.bandUntil === undefined || s.bandUntil <= (await $.clock.now())) return next(e)
    const { level, reason } = describeEffort(s)
    const { Box, Button, Text } = $.ui.resolve(e)
    // The buttons show the choice, a switch waiting for the next turn included; the level shows what runs.
    const manualOn = s.pending ? s.pending.to === 'manual' : s.manual !== undefined

    const r = rippled(reason, s.ripple)

    // One row at any width: the reason fills the row and gives way (truncated with an ellipsis), so the buttons sit at the right edge; the label, the level and the buttons never wrap.
    return (
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0} flexDirection="row" gap={1}>
          <Text dimColor>effort</Text>
          <Text bold color="success">{level}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            · {r.before}
            {r.window.map((w, i) => (
              <Text key={`w${i}`} bold={w.grade.bold} dimColor={w.grade.dimColor}>
                {w.char}
              </Text>
            ))}
            {r.after}
          </Text>
        </Box>
        <Box flexShrink={0} flexDirection="row" gap={1}>
          {s.countdown !== undefined && <Text color="warning">sending in {s.countdown}…</Text>}
          {s.countdown === undefined && <Button key="auto" label="Auto" variant={manualOn ? 'secondary' : 'primary'} onPress={() => void setAuto($)} />}
          {s.countdown !== undefined && <Button key="send" label="Send now" variant="secondary" onPress={() => void sendNow($)} />}
          <Button key="manual" label="Manual" variant={manualOn ? 'primary' : 'secondary'} onPress={() => void setManual($, 'user override')} />
        </Box>
      </Box>
    )
  })
}
