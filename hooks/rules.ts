// The rules: pure functions and tables, no `$`. This is the file to edit when
// the hill climb (/effort-report) shows a pattern of misses.
//
// Reading order of a decision, in `decide`: Manual > step > prompt
// > stage > the model's default (DEFAULT_BY_MODEL): in Auto the mod always picks, so the app's own
// setting runs only in Manual. Automatic
// sources never pick max, and xhigh only for an explicit ask in the prompt or
// a Jev walk that reaches it; any other level is the app's own setting.
// Every table a person tunes (the word rules, the stage table, the floors, the
// JEV block with its questions and walk) is in levers.ts; this file reads them.
// The JEV section at the end holds the walk, the scrubber and the combiner.

import type {
  AutoEffortChoice,
  AutoEffortDecision,
  AutoEffortJevFailure,
  AutoEffortJevResult,
  AutoEffortJudgment,
  AutoEffortLevel,
  AutoEffortSignal,
  AutoEffortMiss,
  AutoEffortMode,
  AutoEffortSignals,
  AutoEffortTurn,
} from '../types'
import type { PromptDecoration } from 'claude-code'
import {
  DEFAULT_BY_MODEL,
  DEFAULT_OTHER,
  DRAFT_PAINT,
  FLOOR_BY_MODEL,
  JEV,
  NULL_CASE,
  PROMPT_RULES,
  PROMPT_WALK,
  QUESTIONS,
  SHORT_QUESTION,
  SKILL_PURPOSE,
  ASK_MARK,
  QUOTE_LINE,
  REPLY_MARK,
  ROUND_ANSWER,
  CARRIED_OPENINGS,
  STAGE_BY_SKILL,
  STRIPPED_BLOCKS,
  STEP_RULES,
  STEP_WALK,
  type JevKind,
} from './levers'

export * from './levers'

export const LEVELS: readonly AutoEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const isLevel = (word: string): word is AutoEffortLevel =>
  (LEVELS as readonly string[]).includes(word)

/** `med` and `mid` read as medium; anything else must be a level's own name. */
export const readLevel = (word: string): AutoEffortLevel | undefined => {
  const w = word.trim().toLowerCase()
  if (w === 'med' || w === 'mid') return 'medium'
  return isLevel(w) ? w : undefined
}

/** The stage as Jev's state: the skill's name and purpose, found from the stage signal's words. */
export function stageState(stage: AutoEffortSignal | undefined): { stage?: { skill: string; purpose: string } } {
  if (!stage) return {}
  const skill = Object.keys(STAGE_BY_SKILL).find(k => STAGE_BY_SKILL[k]?.reason === stage.reason)
  if (!skill) return {}
  return { stage: { skill, purpose: SKILL_PURPOSE[skill] ?? stage.reason } }
}

/** `level` raised to the model's floor when it sits under it; the floor's reason comes back with it. `underFloor` lets it stand. */
export function applyFloor(model: string, level: AutoEffortLevel, underFloor?: true): { level: AutoEffortLevel; floor?: string } {
  const floor = FLOOR_BY_MODEL.find(f => f.test.test(model))
  if (!floor || underFloor || LEVELS.indexOf(level) >= LEVELS.indexOf(floor.level)) return { level }
  return { level: floor.level, floor: floor.reason }
}

/** A prompt rule's verdict and the span of `text` it fired on, `[start, end)` in code units; the short question's span is its question mark. */
export type PromptMatch = { signal: AutoEffortSignal; start: number; end: number }

/** The skill a stage signal names, found from its words as stageState does. */
const stageSkill = (stage: AutoEffortSignal | undefined): string | undefined =>
  stage ? Object.keys(STAGE_BY_SKILL).find(k => STAGE_BY_SKILL[k]?.reason === stage.reason) : undefined

/** The prompt's verdict and span. `stage` lets a grilling-round answer (ROUND_ANSWER) speak; an explicit ask for deeper thought still wins over it. */
export function readPromptMatch(text: string, stage?: AutoEffortSignal): PromptMatch | undefined {
  const t = text.trim()
  if (t === '') return undefined
  let found: PromptMatch | undefined
  for (const rule of PROMPT_RULES) {
    const m = rule.test.exec(text)
    if (m) {
      found = { signal: { level: rule.level, reason: rule.reason }, start: m.index, end: m.index + m[0].length }
      break
    }
  }
  const skill = stageSkill(stage)
  const round = skill && ROUND_ANSWER.stages.includes(skill) ? ROUND_ANSWER.test.exec(text) : null
  if (round && found?.signal.level !== 'xhigh') {
    const start = round.index + round[0].length - round[0].trimStart().length
    return { signal: { level: ROUND_ANSWER.level, reason: ROUND_ANSWER.reason }, start, end: round.index + round[0].length }
  }
  if (found) return found
  if (t.length <= SHORT_QUESTION.chars && /\?\s*$/.test(t)) {
    const end = text.trimEnd().length
    return { signal: { level: SHORT_QUESTION.level, reason: SHORT_QUESTION.reason }, start: end - 1, end }
  }
  return undefined
}

export const readPrompt = (text: string, stage?: AutoEffortSignal): AutoEffortSignal | undefined => readPromptMatch(text, stage)?.signal

/** What Auto runs when no signal spoke: the model's default (DEFAULT_BY_MODEL), named in the reason; DEFAULT_OTHER for a model not listed or not yet seen. */
export function defaultFor(model: string | undefined): AutoEffortSignal {
  const row = model ? DEFAULT_BY_MODEL.find(d => d.test.test(model)) : undefined
  return row ? { level: row.level, reason: `${DEFAULT_OTHER.reason} (${defaultName(model)})` } : { ...DEFAULT_OTHER }
}

/** `fable default` for a listed model; undefined for any other. */
export function defaultName(model: string | undefined): string | undefined {
  const row = model ? DEFAULT_BY_MODEL.find(d => d.test.test(model)) : undefined
  return row ? `${row.name} default` : undefined
}

/**
 * What the draft is painted with as it is typed (DRAFT_PAINT): the span a
 * prompt rule fired on underlined, and after the draft, dim, the level it
 * reaches with its reason; `nothing matched` when none did. In jev mode the
 * ghost says it is the rules' read: Jev speaks only at submit.
 */
export function paintDraft(text: string, mode: AutoEffortMode, s: { model?: string; stage?: AutoEffortSignal } = {}): PromptDecoration[] {
  if (!DRAFT_PAINT || text.trim() === '') return []
  const m = readPromptMatch(text, s.stage)
  const verdict = m ? `${m.signal.level} · ${m.signal.reason}` : defaultFor(s.model).reason
  const ghost = ` → ${verdict}${mode === 'jev' ? ' (rules\' read)' : ''}`
  const out: PromptDecoration[] = []
  if (m) out.push({ start: m.start, end: m.end, underline: true })
  out.push({ start: text.length, end: text.length, virtualText: ghost, dimColor: true })
  return out
}

export function readStep(text: string): AutoEffortSignal | undefined {
  for (const rule of STEP_RULES) {
    if (rule.test.test(text)) return { level: rule.level, reason: rule.reason }
  }
  return undefined
}

// --- the plan tool's arguments, folded into the in_progress step --------------

export type PlanItem = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export type PlanArgs = {
  items?: readonly { content: string; status: string }[]
  advance?: boolean
  done?: readonly number[]
  start?: number
}

/** The plan after one update_plan call, from the plan before it. */
export function applyPlan(before: readonly PlanItem[], args: PlanArgs): PlanItem[] {
  let items: PlanItem[] = args.items
    ? args.items.map(i => ({
        content: i.content,
        status: i.status === 'in_progress' || i.status === 'completed' ? i.status : 'pending',
      }))
    : before.map(i => ({ ...i }))
  const mark = (at: number, status: PlanItem['status']) => {
    const item = items[at]
    if (item) item.status = status
  }
  if (args.done) for (const n of args.done) mark(n - 1, 'completed')
  if (args.advance) {
    mark(items.findIndex(i => i.status === 'in_progress'), 'completed')
    mark(items.findIndex(i => i.status === 'pending'), 'in_progress')
  }
  if (args.start !== undefined && items[args.start - 1]) {
    items = items.map(i => (i.status === 'in_progress' ? { ...i, status: 'pending' } : i))
    mark(args.start - 1, 'in_progress')
  }
  return items
}

export const inProgress = (items: readonly PlanItem[]): PlanItem | undefined =>
  items.find(i => i.status === 'in_progress')

// --- the decision --------------------------------------------------------------

export function decide(s: AutoEffortSignals): AutoEffortDecision {
  if (s.manual) return { level: 'manual', reason: s.manual.reason, source: 'manual' }
  if (s.step) return { ...s.step, source: s.step.source ?? 'step' }
  if (s.prompt) return { ...s.prompt, source: s.prompt.source ?? 'prompt' }
  if (s.stage) return { ...s.stage, source: 'stage' }
  return { ...defaultFor(s.model), source: 'default' }
}

export const levelWord = (level: AutoEffortLevel | number | undefined): string =>
  level === undefined ? 'default' : String(level)

// --- the report: what /effort-report prints -------------------------------------

const when = (iso: string): string => iso.slice(5, 16).replace('T', ' ')

const tally = (words: readonly string[]): string => {
  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  return [...counts].map(([w, n]) => `${w} ${n}`).join(' · ') || 'none'
}

export function formatReport(
  turns: readonly AutoEffortTurn[],
  misses: readonly AutoEffortMiss[],
  manual: readonly AutoEffortMiss[] = [],
): string {
  if (turns.length === 0 && misses.length === 0 && manual.length === 0) return 'auto-effort: nothing recorded yet.'
  const first = turns[0]?.at ?? misses[0]?.at ?? ''
  const rate = turns.length ? Math.round((100 * misses.length) / turns.length) : 0
  const lines = [
    `auto-effort — ${turns.length} turns since ${when(first)} · ${misses.length} misses (${rate}%)`,
    `ran      ${sumRan(turns)} (requests, after the floor)`,
    `first    ${tally(turns.map(t => t.first?.level ?? '-'))} (the decision at the turn's first request)`,
    `ended    ${tally(turns.map(t => t.decision?.level ?? levelWord(t.engine)))} (the decision at the turn's end, most often the wrap-up)`,
    `sources  ${tally(turns.map(t => t.decision?.source ?? 'default'))}`,
    `modes    ${tally(turns.map(t => t.mode ?? 'rules'))}`,
  ]
  if (misses.length) {
    lines.push('misses (newest first)')
    for (const m of [...misses].reverse().slice(0, 20)) {
      const ran = m.ran ? `${m.ran.level} (${m.ran.source}: ${m.ran.reason})` : 'default'
      lines.push(`  ${when(m.at)}  ${ran} → ${m.chosen} via ${m.how}  "${m.prompt}"${m.note ? `  — ${m.note}` : ''}`)
    }
  }
  if (manual.length) {
    // Each Manual turn beside what Auto would have run: the labels the hill climb learns from (0.3.9).
    const rank = (c: string) => LEVELS.indexOf(c as AutoEffortLevel)
    const compared = manual.filter(m => m.ran && rank(m.ran.level) >= 0 && rank(m.chosen) >= 0)
    const lower = compared.filter(m => rank(m.ran?.level ?? '') < rank(m.chosen)).length
    const same = compared.filter(m => rank(m.ran?.level ?? '') === rank(m.chosen)).length
    lines.push(`manual   ${manual.length} turns by hand · Auto would have run lower ${lower} · the same ${same} · higher ${compared.length - lower - same}`)
    for (const m of [...manual].reverse().slice(0, 20)) {
      const auto = m.ran ? `${m.ran.level} (${m.ran.source}: ${m.ran.reason})` : 'silent'
      lines.push(`  ${when(m.at)}  ${auto} → ${m.chosen}  "${m.prompt}"`)
    }
  }
  lines.push(...formatJevSection(turns, misses))
  lines.push('levers: hooks/levers.ts in the mod folder · docs/reference/Claude Auto-Effort Mod.md · /effort-report clear')
  return lines.join('\n')
}

/** The jev section of the report: the two judges side by side. Empty when no turn ran in jev mode. */
export function formatJevSection(turns: readonly AutoEffortTurn[], misses: readonly AutoEffortMiss[]): string[] {
  const jevTurns = turns.filter(t => t.mode === 'jev')
  if (jevTurns.length === 0) return []
  const results: AutoEffortJevResult[] = []
  const pairs: { jev: AutoEffortJudgment; rules: AutoEffortSignal | null | undefined }[] = []
  for (const t of jevTurns) {
    if (t.jev?.prompt) {
      results.push(t.jev.prompt)
      if (isJudgment(t.jev.prompt)) pairs.push({ jev: t.jev.prompt, rules: t.rules?.prompt })
    }
    const steps = t.jev?.steps ?? []
    steps.forEach((s, i) => {
      results.push(s)
      if (isJudgment(s)) pairs.push({ jev: s, rules: t.rules?.steps?.[i] })
    })
  }
  const judgments = results.filter(isJudgment)
  const failures = results.filter((r): r is AutoEffortJevFailure => !isJudgment(r))
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const latencies = judgments.map(j => j.ms).sort((a, b) => a - b)
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0
  const verdicts = judgments.map(j => walk(j))
  const spoke = pairs
    .map(p => ({ verdict: walk(p.jev), rules: p.rules }))
    .filter((p): p is { verdict: JevVerdict & { kind: 'level' }; rules: AutoEffortSignal } => p.verdict.kind === 'level' && p.rules != null)
  const agreed = spoke.filter(p => p.verdict.signal.level === p.rules.level).length
  const bySource = tally(misses.map(m => m.ran?.source ?? 'none'))
  const failWords = failures.length ? ` (${tally(failures.map(f => f.kind))})` : ''
  const agreePct = spoke.length ? Math.round((100 * agreed) / spoke.length) : 0
  const levels = verdicts.flatMap(v => (v.kind === 'level' ? [v.signal.level] : []))
  const rows = verdicts.flatMap(v => (v.kind === 'level' ? [v.row] : []))
  return [
    `jev      ${jevTurns.length} turns in jev mode · ${results.length} calls · ${failures.length} failures${failWords}`,
    `         levels ${tally(levels)} · unsure ${verdicts.filter(v => v.kind === 'unsure').length} · nothing fits ${verdicts.filter(v => v.kind === 'gap').length} · no work asked ${verdicts.filter(v => v.kind === 'none').length}`,
    `         rows ${tally(rows)}`,
    `         agrees with the rules ${agreePct}% (${agreed}/${spoke.length} where both spoke) · misses by source ${bySource}`,
    `         latency mean ${Math.round(mean(latencies))} ms · 95th ${p95} ms · late ${judgments.filter(j => j.late).length}`,
  ]
}

// --- JEV: TypeSafe's System One model as the judge of prompt and step -------------
//
// The walk over Jev's answers, the scrubber, the request and answer shapes, the
// combiner. The levers (model, deadline, thresholds, questions, walk rows) are
// in levers.ts. Nothing here touches the network; register.tsx sends what
// buildRequest returns.

/**
 * What the walk came to: a level; no work asked (low, whatever the rules say:
 * an acknowledgement is the cheapest turn there is); a gap, every answer a settled no (the question set has no row for it:
 * the rules decide); or unsure, some answer in the band (the rules decide).
 */
export type JevVerdict = { kind: 'level'; signal: AutoEffortSignal; row: string } | { kind: 'none'; signal: AutoEffortSignal } | { kind: 'gap' } | { kind: 'unsure' }

export function walk(j: AutoEffortJudgment): JevVerdict {
  const n = j.nouls
  const yes = (id: string) => (n[id] ?? 0) >= JEV.GATE.yes
  const no = (id: string) => (n[id] ?? 1) <= JEV.GATE.no
  const nullCase = NULL_CASE[j.kind]
  if (nullCase && no(nullCase)) return { kind: 'none', signal: { level: 'low', reason: `jev no work asked ${(n[nullCase] ?? 0).toFixed(2)}`, source: 'jev', underFloor: true } }
  const rows = j.kind === 'prompt' ? PROMPT_WALK : STEP_WALK
  for (const row of rows) {
    if (row.needs.every(yes)) {
      const sure = Math.min(...row.needs.map(id => n[id] ?? 0))
      return { kind: 'level', row: row.reason, signal: { level: row.level, reason: `jev ${row.reason} ${sure.toFixed(2)}`, source: 'jev' } }
    }
  }
  const settled = Object.keys(QUESTIONS[j.kind]).every(id => id === nullCase || no(id))
  return settled ? { kind: 'gap' } : { kind: 'unsure' }
}


/**
 * A long run of letters and digits reads as a secret when it looks random. A
 * CamelCase identifier or a path has capitals one at a time and few digits; a
 * key has runs of two or more capitals side by side, and digits among them.
 */
export function looksRandom(run: string): boolean {
  const upperRuns = (run.match(/[A-Z]{2,}/g) ?? []).length
  const digits = run.replace(/\D/g, '').length
  return (upperRuns >= 3 && digits >= 1) || (upperRuns >= 2 && digits >= 6)
}

/**
 * The scrub table, in order: URLs first (their userinfo would read as an email)
 * and addresses, so nothing inside one is read as a key; then keys by their shape; then homes, hosts and phones.
 * Identifiers and file paths are left alone: a key prefix needs its separator,
 * a long run has to look random (`looksRandom`), a `key=` needs its own word.
 */
const SCRUB: readonly [RegExp, string | ((...m: string[]) => string)][] = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '<url>'],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, '<secret>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <secret>'],
  [/\b(?:sk|ghp|gho|ghu|ghs|ghr|xox[abp]|ts_live|ts_test)[-_][A-Za-z0-9_-]{8,}/g, '<secret>'],
  [/\bAKIA[A-Z0-9]{16}\b/g, '<secret>'],
  [/\b((?:[A-Za-z0-9]+[_-])?(?:api[_-]?key|key|token|secret|password|passwd))=(\S+)/gi, '$1=<secret>'],
  // A quoted pair, double or single quotes (JSON, a Python dict, a JS object): the value's quotes stay.
  [/((["'])(?:[A-Za-z0-9]+[_-])?(?:api[_-]?key|key|token|secret|password|passwd|pwd)\2\s*:\s*)(["'])(?:(?!\3).)*\3/gi, '$1$3<secret>$3'],
  // An unquoted name: the value alone goes, quoted or bare; a closing brace or bracket after it stays.
  [/\b((?:[A-Za-z0-9]+[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd)):[ \t]*(?!<secret>)(?:'[^']*'|"[^"]*"|[^\s,;'"{}[\]()]+)/gi, '$1: <secret>'],
  [/\b(?=[A-Fa-f0-9]*\d)(?=[A-Fa-f0-9]*[A-Fa-f])[A-Fa-f0-9]{24,}\b/g, '<secret>'],
  [/(?<![\w/\\.-])[A-Za-z0-9+/=-]{32,}(?![\w/\\.-])/g, run => (looksRandom(run) ? '<secret>' : run)],
  [/[A-Za-z]:\\Users\\[^\\\s]+/g, '<home>'],
  [/(?:\/home|\/Users)\/[^/\s]+/g, '<home>'],
  [/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, '<ip>'],
  [/(?<!\w)(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[.-])\d{3}[.-]\d{4}\b/g, '<phone>'],
  [/(?<![\w.+-])\+?\d{10,15}(?![\w.-])/g, '<phone>'],
]

/** The part of a message the judges read: the app's wrapper blocks dropped, and a started session's brief read from its `Task:` line. Empty when nothing is left. */
export function focus(text: string): string {
  let out = text
  for (const re of STRIPPED_BLOCKS) out = out.replace(re, '')
  out = out.replace(REPLY_MARK, '').replace(QUOTE_LINE, '')
  const ask = ASK_MARK.exec(out)
  if (ask) out = out.slice(ask.index + ask[0].length)
  return out.trim()
}

/** The passage a reply quotes (its `>` lines, the marks dropped), for Jev's `previous_reply`; empty when the message quotes nothing. */
export function quotedReply(text: string): string {
  let out = text
  for (const re of STRIPPED_BLOCKS) out = out.replace(re, '')
  return (out.match(QUOTE_LINE) ?? []).map(l => l.replace(/^[ \t]*>[ \t]?/, '')).join('\n').trim()
}

/** A turn the agent started: a hand-back or a notification opens it. */
export const isCarried = (text: string): boolean => CARRIED_OPENINGS.some(re => re.test(text))

/** What the turns' requests ran at, summed: `low 120 · medium 80`. */
export function sumRan(turns: readonly AutoEffortTurn[]): string {
  const sum: Record<string, number> = {}
  for (const t of turns) for (const [level, n] of Object.entries(t.ran ?? {})) sum[level] = (sum[level] ?? 0) + n
  const order = ['low', 'medium', 'high', 'xhigh', 'max']
  return Object.entries(sum).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([l, n]) => `${l} ${n}`).join(' · ') || 'none'
}

/**
 * Strips, best effort, what should not leave the machine or sit in the store:
 * addresses, keys and credentials, home paths, URLs whole, phone numbers, and
 * the names given (AUTO_EFFORT_REDACT, matched as whole words, any case). It
 * catches patterns; a name it was not given, or a street address, passes.
 */
export function scrub(text: string, names: readonly string[] = []): string {
  let out = text
  for (const [re, to] of SCRUB) out = typeof to === 'string' ? out.replace(re, to) : out.replace(re, to)
  for (const name of names) out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '<name>')
  return out
}

/** AUTO_EFFORT_REDACT's names: comma-separated, blanks dropped. */
export function redactNames(value: string | undefined): string[] {
  return (value ?? '').split(',').map(n => n.trim()).filter(Boolean)
}

/** The marker the cap leaves between head and tail; a text shorter than the cap plus the marker is sent whole. */
const CUT_MARK = ' … (+N characters cut) … '

/** The head and the tail of a long text, the cut named between them. */
export function capState(text: string): string {
  if (text.length <= JEV.STATE_CHARS + CUT_MARK.length) return text
  const head = JEV.STATE_CHARS - JEV.TAIL_CHARS
  const cut = text.length - JEV.STATE_CHARS
  return `${text.slice(0, head)}${CUT_MARK.replace('N', String(cut))}${text.slice(text.length - JEV.TAIL_CHARS)}`
}

/** The tail of a long text, the cut named before it: what the assistant last said, where the next step is named. */
export function tailOf(text: string): string {
  if (text.length <= JEV.TAIL_CHARS + CUT_MARK.length) return text
  return `${CUT_MARK.replace('N', String(text.length - JEV.TAIL_CHARS)).trimStart()}${text.slice(text.length - JEV.TAIL_CHARS)}`
}

/** What a request carries: nested JSON, the fields the questions name in backticks. */
export type JevState = Readonly<Record<string, unknown>>

/** The request body: every Noul of the kind, over the one state. When a stage is sent, each question is told what it is. */
export function buildRequest(kind: JevKind, state: JevState): string {
  const questions: Record<string, unknown> = {}
  const parts = [
    'stage' in state ? '`stage` is the kind of work the session is already doing' : '',
    'previous_reply' in state ? '`previous_reply` is the end of what the assistant last said; a short message often answers it' : '',
  ].filter(Boolean)
  const context = parts.length ? { context: parts.join('. ') } : {}
  for (const [id, q] of Object.entries(QUESTIONS[kind])) {
    questions[id] = { type: 'noul', instructions: { question: q.instructions, ...context }, criteria: q.criteria }
  }
  return JSON.stringify({ model: JEV.MODEL, state, questions })
}

export const isJudgment = (r: AutoEffortJevResult | undefined): r is AutoEffortJudgment => r !== undefined && 'nouls' in r

/** Reads one Noul per question of the kind from the response body; anything off is a bad answer. */
export function parseAnswer(text: string, kind: JevKind, ms: number): AutoEffortJevResult {
  const bad: AutoEffortJevFailure = { kind: 'bad-answer', ms }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return bad
  }
  if (typeof body !== 'object' || body === null) return bad
  const b = body as { model?: unknown; answers?: Record<string, { type?: unknown; noul?: unknown } | undefined> }
  if (typeof b.model !== 'string') return bad
  const nouls: Record<string, number> = {}
  for (const id of Object.keys(QUESTIONS[kind])) {
    const a = b.answers?.[id]
    if (!a || a.type !== 'noul' || typeof a.noul !== 'number' || a.noul < 0 || a.noul > 1) return bad
    nouls[id] = a.noul
  }
  return { kind, nouls, ms, model: b.model }
}

/** The failure an HTTP status names. */
export function failureOf(status: number, ms: number): AutoEffortJevFailure {
  const kinds: Record<number, AutoEffortJevFailure['kind']> = {
    400: 'bad-request',
    401: 'unauthorized',
    403: 'unauthorized',
    422: 'bad-request',
    429: 'rate-limit',
    503: 'overloaded',
    529: 'overloaded',
  }
  return { kind: kinds[status] ?? (status >= 500 ? 'server' : 'network'), status, ms }
}

/**
 * The combiner, v1: Jev's walk decides where it reaches a level or says no work
 * was asked; a gap or an unsure walk, like a failed call, leaves it to the
 * rules, their reason saying why Jev stood aside.
 */
export function combine(jev: AutoEffortJevResult | undefined, rules: AutoEffortSignal | undefined): AutoEffortSignal | undefined {
  if (isJudgment(jev)) {
    const v = walk(jev)
    if (v.kind === 'level' || v.kind === 'none') return v.signal
  }
  if (!rules) return undefined
  const why = standAside(jev)
  return why ? { level: rules.level, reason: `${rules.reason} (${why})` } : rules
}

/** Why Jev gave no level, for the band: `jev unsure`, `jev: nothing fits`, `jev: timeout`; empty when it did, or was not asked. */
export function standAside(jev: AutoEffortJevResult | undefined): string {
  if (!jev) return ''
  if (!isJudgment(jev)) return `jev: ${jev.kind}`
  const v = walk(jev)
  return v.kind === 'gap' ? 'jev: nothing fits' : v.kind === 'unsure' ? 'jev unsure' : ''
}
