// The levers: every table a person tunes, and nothing that runs. TypeSafe's
// guidance for reviewing System One code is that the questions and the
// threshold constants sit in one file, found without spelunking; this is it,
// and the word rules, the stage table, the floors and the agent-type table sit
// beside them, since the hill climb (/effort-report) compares the judges and a
// floor changes what the walk's "low" means. The functions that read these
// tables are in rules.ts; register.tsx talks to the engine. A test in
// register.test.tsx checks that this file exports no function and that every
// walk row names a question that exists.
//
// /effort-jev questions prints the version and the question set the installed
// copy actually asks, for checking a session is on the code you think it is.

import type { AutoEffortLevel, AutoEffortSignal } from '../types'

/** The mod's version, as plugin.json says it (the zip step checks they agree). /effort-jev questions and /effort-mode print it. */
export const VERSION = '0.4.4'

// --- the stage: which skill the session is working through ------------------

/** Effort per skill, keyed as the Skill tool spells the name. A skill not listed leaves the stage as it was. */
export const STAGE_BY_SKILL: Readonly<Record<string, AutoEffortSignal>> = {
  review: { level: 'high', reason: 'review skill' },
  'code-review': { level: 'high', reason: 'code-review skill' },
  'security-review': { level: 'high', reason: 'security review' },
  'codebase-design': { level: 'high', reason: 'design round' },
  build: { level: 'medium', reason: 'build skill' },
  tdd: { level: 'medium', reason: 'tdd skill' },
  research: { level: 'medium', reason: 'research skill' },
  simplify: { level: 'medium', reason: 'simplify skill' },
  promote: { level: 'low', reason: 'promote skill' },
  settle: { level: 'low', reason: 'settle skill' },
  'wayfinder-obsidian': { level: 'high', reason: 'wayfinder skill' },
  'domain-modeling': { level: 'low', reason: 'domain-modeling skill' },
  'obsidian-mermaid': { level: 'low', reason: 'mermaid skill' },
  grilling: { level: 'high', reason: 'grilling skill' },
  prototype: { level: 'medium', reason: 'prototype skill' },
  pr: { level: 'low', reason: 'pr skill' },
}

/** What each stage skill is for, in a line: the state Jev reads when a stage is set, in place of the band's label. */
export const SKILL_PURPOSE: Readonly<Record<string, string>> = {
  review: 'reviewing a diff for standards and against its spec',
  'code-review': 'reviewing a diff for standards and against its spec',
  'security-review': 'reviewing the branch for security problems',
  'codebase-design': 'designing a module\'s interface before building it',
  build: 'building a spec\'s tickets test-first on a branch',
  tdd: 'building test-first',
  research: 'researching a question against primary sources',
  simplify: 'simplifying code just written',
  promote: 'promoting a finished slice into core: tags, docs, ceremony',
  settle: 'working the ledger of provisional rules',
  'wayfinder-obsidian': 'planning a large piece of work as a map of decision tickets',
  'domain-modeling': 'editing the glossary and architecture decision records',
  'obsidian-mermaid': 'drawing a diagram in a vault note',
  grilling: 'stress-testing a plan with questions',
  prototype: 'building a throwaway prototype to answer a design question',
  pr: 'writing a pull request body',
}
// --- subagents ---------------------------------------------------------------

/** Effort per subagent type, in Auto. A type not listed runs at the main loop's decision; an effort the Agent call named is overruled (the mod's Auto wins); Manual leaves every request alone. */
export const LEVEL_BY_AGENT_TYPE: Readonly<Record<string, AutoEffortSignal>> = {
  reviewer: { level: 'high', reason: 'reviewer agent' },
  Explore: { level: 'medium', reason: 'Explore agent' },
  Plan: { level: 'medium', reason: 'Plan agent' },
  'claude-code-guide': { level: 'low', reason: 'guide agent' },
}

// --- the floor per model ------------------------------------------------------

/** The least effort the mod will pick for a model, matched on the model id. Sonnet and Haiku at low read airy even for a lookup. A model not listed has no floor. */
export const FLOOR_BY_MODEL: readonly { test: RegExp; level: AutoEffortLevel; reason: string }[] = [
  { test: /sonnet/i, level: 'medium', reason: 'sonnet floor' },
  { test: /haiku/i, level: 'medium', reason: 'haiku floor' },
]
// --- the prompt's focus: what the judges read --------------------------------

/** A reply to a passage of the last answer opens with this marker and the passage as `>` lines: the quote is the previous reply, sent to Jev as `previous_reply`, and the judges read the rest. 0.3.9: 19 rows had been judged on the quote. */
export const REPLY_MARK = /^[ \t]*<!-- reply \d+ -->[ \t]*$/gm
export const QUOTE_LINE = /^[ \t]*>.*$/gm

/** Blocks the app wraps around a message that are not its ask (the "Linked sessions" reminder, an event): dropped before the judges and the row read it. 0.2.12: the M13 replay's brief was judged on its reminder. */
export const STRIPPED_BLOCKS: readonly RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<side-sessions-event>[\s\S]*?<\/side-sessions-event>/g,
  /<ci-monitor-event>[\s\S]*?<\/ci-monitor-event>/g,
]

/** A session started from another opens with a Background paragraph and its ask under this line: the judges read from the line on, so the head of the state is the ask, not the Background. */
export const ASK_MARK = /^Task:[ \t]*$/m

/** Openings of a turn the agent started, not Mac: a subagent's hand-back, a background task's notification. The turn carries the spawning turn's prompt signal instead of being judged on the envelope. 0.3.0: 31 hand-back rows had been judged on their envelope; 0.3.9 adds another session's message (7 rows). */
export const CARRIED_OPENINGS: readonly RegExp[] = [/^\s*(?:Another Claude session sent a message:\s*)?<agent-message\b/, /^\s*<task-notification\b/, /^\s*<side-sessions-event\b/, /^\s*<cross-session-message\b/]

// --- the prompt --------------------------------------------------------------

export type WordRule = { level: AutoEffortLevel; reason: string; test: RegExp }

/** First match wins: an explicit ask for deeper thinking, then verification words, then build words, then prose words. */
export const PROMPT_RULES: readonly WordRule[] = [
  {
    level: 'xhigh',
    reason: 'explicit ask',
    test: /\b(think (?:harder|hard|it through|this through)|try harder|be thorough|take your time|deep(?:er|ly)? (?:thought|think|dive))\b/i,
  },
  {
    level: 'high',
    reason: 'verification words',
    test: /\b(review|verify|verif(?:ied|ies|ication)|audit|bugs?|regression|broken|fail(?:s|ed|ing|ure)?|crash(?:es|ed|ing)?|root cause|security|edge[- ]?cases?|flaky|diagnose|debug|tests?|why (?:does|is|did|do|are|won't|doesn't|isn't|aren't|can't|didn't))\b/i,
  },
  {
    level: 'medium',
    reason: 'build words',
    test: /\b(build|implement|add|create|write|refactor|move|extract|wire|ticket|fix(?:es|ed|ing)?|change|update|rework|port|migrate)\b/i,
  },
  {
    level: 'low',
    reason: 'prose or lookup words',
    test: /\b(explain|what (?:is|are|does|do)|where (?:is|are|does|do)|how (?:does|do|is|are|many|much)|summari[sz]e|list|show me|log line|glossary|vault|wayfinder|chart|brainstorm|sketch|ideas?|quick(?:ly)?|rename|typo|wording)\b/i,
  },
]

/**
 * A grilling-round answer: a message opening `Q7,` or `1,` / `1.` while the
 * stage is one that asks numbered rounds. High, since the answers send the
 * agent off to look things up and settle the next round, and at low it asks
 * instead of looking (0.3.9: every round answer had been set to high or max by
 * hand, Jev scoring answers_questions 0.10 to 0.49 on them). An explicit ask
 * for deeper thought still wins. In jev mode this rule decides over Jev.
 */
export const ROUND_ANSWER = {
  test: /^\s*(?:Q\d+\b|1[,.](?!\d))/i,
  stages: ['grilling', 'wayfinder-obsidian', 'codebase-design'],
  level: 'high' as const,
  reason: 'grilling',
}

/** A short message ending in a question mark is a question: low. */
export const SHORT_QUESTION = { chars: 200, level: 'low' as const, reason: 'short question' }

// --- the plan's step ---------------------------------------------------------

/** The in_progress step's words. First match wins: verifying, then writing. No match leaves the step signal empty. */
export const STEP_RULES: readonly WordRule[] = [
  {
    level: 'high',
    reason: 'verifying step',
    test: /\b(verif(?:y|ies|ied|ying)|tests?(?:ed|ing)?|review(?:s|ed|ing)?|check(?:s|ed|ing)?|validat(?:e|es|ed|ing)|confirm|diagnose|reproduce|compare|stills)\b/i,
  },
  {
    level: 'low',
    reason: 'writing step',
    test: /\b(log|note|glossary|index|docs?|write-?up|wording|rename|tidy|readme|milestones?|ledger|chapter|recap)\b/i,
  },
]
// --- the decision --------------------------------------------------------------

/** The wrap-up tool ends a turn: its closing message runs low on any model, the floor set aside (`underFloor`, 0.3.10): a recap needs no depth. The other exception to the floor is Jev's no-work-asked verdict. */
export const WRAP_UP: AutoEffortSignal = { level: 'low', reason: 'wrap-up', underFloor: true }
/**
 * What Auto runs when no signal spoke, per model, matched on the model id like
 * the floors; the reason names the model ("nothing matched (fable default)").
 * A model not listed runs DEFAULT_OTHER, the reason bare. Added 2026-10-28 so
 * Auto always picks ("reply ok" at the app's max was the case); per model 0.3.9.
 */
export const DEFAULT_BY_MODEL: readonly { test: RegExp; level: AutoEffortLevel; name: string }[] = [
  { test: /haiku/i, level: 'medium', name: 'haiku' },
  { test: /sonnet/i, level: 'medium', name: 'sonnet' },
  { test: /opus/i, level: 'medium', name: 'opus' },
  { test: /fable/i, level: 'high', name: 'fable' },
]
export const DEFAULT_OTHER: AutoEffortSignal = { level: 'medium', reason: 'nothing matched' }
/** The session's first typed prompt waits this long before the judges read it, the band counting down with Manual and Send now: the chance to set Manual before Auto takes the session. Whole seconds. */
export const HOLD_MS = 3000

// --- the band and the draft: how the pick is shown ----------------------------

/** The draft is painted as it is typed: the words the prompt rules fired on underlined, the level they reach as ghost text after the draft. Off hides both. 0.3.3. In jev mode the ghost is the rules' read, marked so, since Jev speaks only at submit. */
export const DRAFT_PAINT = true
/** The whoosh: at each prompt judgment a window slides across the band's reason one character per frame, a frame every MS, so a new request is seen to happen; a plan step newly in progress whooshes too (0.3.6). GRADES is the window left to right, a comet: the leading (rightmost) character the strongest, the tail fading behind it toward the dim reason. The installed engine allows `bold` and `dimColor` on a Text but refuses `weight`, `size` and `tabular` though its types list them, so the ladder, left to right, is plain, dim bold, dim bold, bold, bold; no color, the reason's own white. 0.3.3; a tail since 0.3.5 (a hump before), this ladder 0.3.6. */
export const WHOOSH = {
  MS: 40,
  GRADES: [
    { bold: false, dimColor: false },
    { bold: true, dimColor: true },
    { bold: true, dimColor: true },
    { bold: true, dimColor: false },
    { bold: true, dimColor: false },
  ],
} as const

// --- JEV: TypeSafe's System One model as the judge of prompt and step -------------
//
// The model, the deadline, the thresholds, the questions and their criteria,
// the decision walk. Jev answers narrow yes/no questions (Nouls) about the
// prompt or the step; `walk` in rules.ts runs a first-match table over the
// answers to a level, the way PROMPT_RULES walks the words.

export const JEV = {
  MODEL: 'jev-1.14.0',
  URL: 'https://api.typesafe.ai/v1/systemone',
  DEADLINE_MS: 1000,
  /** A Noul at or above `yes` reads as yes, at or below `no` as no; between, the question is unsettled. Starting values from the TypeSafe docs, untuned. */
  GATE: { yes: 0.7, no: 0.3 },
  /** The prompt is cut to this many characters before it leaves the machine: a head and a tail, since a long brief often puts the ask last. */
  STATE_CHARS: 1500,
  TAIL_CHARS: 500,
} as const
/** The kinds of state Jev is asked about. */
export type JevKind = 'prompt' | 'step'

/** The levels the walk can reach: never max, which stays a hand choice. */
export type JevLevel = Exclude<AutoEffortLevel, 'max'>

/** One Noul: the yes/no question and what each answer means, structured as TypeSafe recommends (what / not_for / examples). */
export type JevQuestion = {
  instructions: string
  criteria: {
    true: { what: string; examples: readonly string[] }
    false: { what: string; not_for?: string; examples: readonly string[] }
  }
}

/**
 * The questions about a prompt, every one answered in the one request. Ids are
 * not sent to the model; the text is. Each asks one thing a person could judge
 * at a glance; `false` is a situation, not a negation, and `not_for` names the
 * case that confuses. The examples are not the test suite's strings, so a live
 * probe on those is not contaminated.
 */
export const PROMPT_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  asks_for_work: {
    instructions: 'Does `message` ask for work or an answer, in its own words or by pointing at what `previous_reply` offered?',
    criteria: {
      true: { what: 'Names something to do, change or answer, or green-lights work the previous reply proposed or asked about', examples: ['Port the room loader to Rules', 'Where does the Simulation keep the news?', 'yes, do that', 'push them please'] },
      false: { what: 'Acknowledges or thanks with nothing left to do: the previous reply finished and offered nothing', not_for: 'A short yes to an offer', examples: ['Thanks', 'ok', 'got it'] },
    },
  },
  asks_deeper_thinking: {
    instructions: 'Does `message` ask, in its own words, for more careful or deeper thought than usual?',
    criteria: {
      true: { what: 'Asks for extra care, depth or time in so many words', examples: ['Think this through properly before you touch anything', 'Give this real thought, I want every angle'] },
      false: { what: 'Asks for the work and says nothing about how carefully', not_for: 'A hard task described plainly', examples: ['Port the room loader to Rules'] },
    },
  },
  open_design: {
    instructions: 'Is the shape of the solution left for the assistant to decide in the work `message` asks for, by reference to `previous_reply` included?',
    criteria: {
      true: { what: 'The outcome is named but not how to get there; design choices remain', examples: ['Make the enemies feel more dangerous without touching damage numbers'] },
      false: { what: 'Says what to change and roughly how, or asks only for an answer', not_for: 'A question', examples: ['Rename Footing to Stance in the Glossary', 'Add a retreat step to the enemy turn'] },
    },
  },
  many_parts: {
    instructions: 'Does `message` ask for several distinct pieces of work, by reference to `previous_reply` included?',
    criteria: {
      true: { what: 'Two or more separate deliverables the assistant must complete, named in the message or in the proposal it green-lights', examples: ['Port the loader, update the Glossary and add the milestone row', 'go ahead with all three'] },
      false: { what: 'One piece of work, or one question, however long its description', not_for: 'One task with several steps of its own', examples: ['Fix the knockback bug'] },
    },
  },
  asks_review: {
    instructions: 'Does `message` ask the assistant to review, verify or check work that already exists?',
    criteria: {
      true: { what: 'Asks for a judgment on existing code, a diff, a document or a result', examples: ['Review core/motion since the merge', 'Check the stills against the baseline'] },
      false: { what: 'Asks to make something, or asks a question about how things work', not_for: 'Asking to run the tests after a change', examples: ['Port the room loader to Rules', 'Explain how effort differs from the model'] },
    },
  },
  reports_defect: {
    instructions: 'Does `message` say that something behaves wrongly?',
    criteria: {
      true: { what: 'Names a failure, a crash, a wrong result or a behavior that should not happen', examples: ['The enemy skips its sixth step', 'The build fails with MSB3027'] },
      false: { what: 'Everything named works as intended; the message asks for an addition, a change, an answer or a cosmetic fix', not_for: 'A curious why or how question about intended behavior, or a typo', examples: ['Add a retreat step to the enemy turn', 'Why does the Simulation keep the news in a list?', 'Fix the typo in the README'] },
    },
  },
  settled_build: {
    instructions: 'Does `message` ask to build or change something whose shape is already stated, in the message or in the `previous_reply` it green-lights?',
    criteria: {
      true: { what: 'Asks for an implementation, an addition or a refactor whose result is already described', examples: ['Port the room loader to Rules per the spec', 'Extract the enemy turn into its own class', 'yes, build it that way'] },
      false: { what: 'Asks only for an answer, a review or a design', examples: ['Where is the news kept?', 'Review core/motion since the merge'] },
    },
  },
  answers_questions: {
    instructions: 'Does `message` answer questions `previous_reply` put, a numbered or lettered round, so that the work the answers settle can go on?',
    criteria: {
      true: { what: 'Picks options or answers numbered questions the previous reply asked; the decisions feed work the assistant then does', examples: ['Q2, (b). Q3, (c) and the default engine is fine', 'Both as recommended', 'Q11, I am not sure, start with (a)'] },
      false: { what: 'Asks a question of its own, or asks for work in its own words', not_for: 'A single yes to a single offer', examples: ['Where is the news kept?', 'Port the room loader to Rules'] },
    },
  },
  answer_only: {
    instructions: 'Does `message` ask only for an answer, an explanation or a lookup, with no change to code or files?',
    criteria: {
      true: { what: 'A question, an explanation, a summary or a search; the answer is words', examples: ['Explain how effort differs from the model', 'List the open tickets'] },
      false: { what: 'Asks for a change to code or files', not_for: 'A question that asks for a fix in the same breath', examples: ['Fix the typo in the README'] },
    },
  },
  one_place: {
    instructions: 'Is the work `message` asks for, by reference to `previous_reply` included, a change in one place: a line, a name, a note, a log line?',
    criteria: {
      true: { what: 'A single small edit with one obvious location', examples: ['Rename Footing to Stance in the Glossary', 'Add the milestone row', 'Fix the typo in the README'] },
      false: { what: 'Touches several places, or asks only for an answer', not_for: 'A question', examples: ['Port the room loader to Rules', 'Explain how effort differs from the model'] },
    },
  },
  routine_step: {
    instructions: 'Does `message` ask only to carry out a settled, mechanical step, with nothing left to work out: commit, push, run the tests, reload, format, rebuild?',
    criteria: {
      true: { what: 'Names or green-lights one routine action whose outcome is already settled, on work that is done', examples: ['push them please', 'commit it', 'run the tests again', 'ok, rebuild the zip'] },
      false: { what: 'Asks for work that has to be thought out, or green-lights a plan or a build', not_for: 'A short yes to a plan: how short the message is says nothing about how big the work is', examples: ['yes, do that', 'go ahead with the three steps', 'Fix the knockback bug'] },
    },
  },
}

/**
 * The questions about a plan step. The state is `{ prompt, plan: { step, done?, ahead? }, stage? }`:
 * `plan.step` is the step in progress, `prompt` the message the plan answers,
 * `plan.done` and `plan.ahead` the steps around it when there are any.
 */
export const STEP_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  verifies: {
    instructions: 'Does `plan.step`, the step the assistant is on for `prompt`, check, test, review or compare work that already exists?',
    criteria: {
      true: { what: 'Runs tests, verifies, reviews, compares, reproduces or confirms something', examples: ['Run the suite', 'Compare the stills against the baseline', 'Confirm the result in the app'] },
      false: { what: 'Makes, reads or writes something without judging existing work', examples: ['Implement the retreat step', 'Add the milestone row'] },
    },
  },
  hunts_defect: {
    instructions: 'Does `plan.step`, the step the assistant is on for `prompt`, look for the cause of something that behaves wrongly?',
    criteria: {
      true: { what: 'Diagnoses, reproduces or finds the root cause of a failure', examples: ['Diagnose why the enemy skips its sixth step', 'Reproduce the crash'] },
      false: { what: 'Builds, verifies or documents something that works as intended', not_for: 'Running the tests after a change', examples: ['Run the suite', 'Implement the retreat step'] },
    },
  },
  changes_code: {
    instructions: 'Does `plan.step`, the step the assistant is on for `prompt`, change source code?',
    criteria: {
      true: { what: 'Writes, edits, refactors or wires code, tests included', examples: ['Implement the retreat step', 'Extract the room loader', 'Add a test for the knockback'] },
      false: { what: 'Reads, verifies or writes prose only', examples: ['Read how the enemy turn is set up', 'Add the milestone row'] },
    },
  },
  prose_only: {
    instructions: 'Is `plan.step`, the step the assistant is on for `prompt`, writing or tidying prose: a note, a log line, a glossary entry, wording?',
    criteria: {
      true: { what: 'Documentation, notes, naming or wording, no code', examples: ['Add the milestone row', 'Update the Glossary entry', 'Tidy the README wording'] },
      false: { what: 'Code, tests or reading', examples: ['Run the suite', 'Read how the enemy turn is set up'] },
    },
  },
  packages: {
    instructions: 'Is `plan.step`, the step the assistant is on for `prompt`, a settled release chore: a version bump, a zip, a commit, a push, a log line, a note brought up to date?',
    criteria: {
      true: { what: 'Packaging and recording work already done; nothing left to work out', examples: ['Tests, zip, 0.2.9', 'Note and log', 'Commit it', 'Rebuild the zip and bump the patch'] },
      false: { what: 'Makes, checks or reads something', not_for: 'Running the tests, which is a check', examples: ['Implement the retreat step', 'Run the suite'] },
    },
  },
  reads_only: {
    instructions: 'Does `plan.step`, the step the assistant is on for `prompt`, only read or look at code or notes, changing nothing?',
    criteria: {
      true: { what: 'Reading, locating, mapping or looking at how something is set up; the result is understanding', examples: ['Read how the Horde is set up', 'Look at how the band is rendered', 'Locate the floor call sites'] },
      false: { what: 'Changes, runs or writes something', not_for: 'A review, which judges what it reads', examples: ['Implement the retreat step', 'Compare the stills against the baseline'] },
    },
  },
}

export const QUESTIONS: Readonly<Record<JevKind, Readonly<Record<string, JevQuestion>>>> = { prompt: PROMPT_QUESTIONS, step: STEP_QUESTIONS }

/** One row of the walk: the level it reaches when every question in `needs` is a yes. */
export type WalkRow = { level: JevLevel; reason: string; needs: readonly string[] }

/**
 * The decision walk, first match wins, the way PROMPT_RULES walks the words:
 * a yes is a Noul at or above GATE.yes. The null case comes first: a prompt that
 * asks for no work gets no signal, whatever else the answers say. A higher row
 * whose answer sits in the unsettled band is passed over for a lower row that
 * is a yes (decided 2026-10-28): the band shows the row taken.
 */
export const PROMPT_WALK: readonly WalkRow[] = [
  { level: 'xhigh', reason: 'asks deeper thinking', needs: ['asks_deeper_thinking'] },
  { level: 'xhigh', reason: 'open design in many parts', needs: ['open_design', 'many_parts'] },
  { level: 'high', reason: 'asks a review', needs: ['asks_review'] },
  { level: 'high', reason: 'reports a defect', needs: ['reports_defect'] },
  { level: 'high', reason: 'open design', needs: ['open_design'] },
  { level: 'low', reason: 'one place', needs: ['one_place'] },
  { level: 'low', reason: 'routine step', needs: ['routine_step'] },
  { level: 'medium', reason: 'settled build', needs: ['settled_build'] },
  { level: 'medium', reason: 'many parts', needs: ['many_parts'] },
  { level: 'high', reason: 'answers decide', needs: ['answers_questions'] },
  { level: 'low', reason: 'answer only', needs: ['answer_only'] },
]

export const STEP_WALK: readonly WalkRow[] = [
  { level: 'high', reason: 'verifying step', needs: ['verifies'] },
  { level: 'high', reason: 'defect hunt', needs: ['hunts_defect'] },
  { level: 'medium', reason: 'code step', needs: ['changes_code'] },
  { level: 'low', reason: 'prose step', needs: ['prose_only'] },
  { level: 'low', reason: 'packaging step', needs: ['packages'] },
  { level: 'low', reason: 'reading step', needs: ['reads_only'] },
]

/** The null-case question of each kind: a no there ends the walk with no signal. A plan step is work by construction, so none. */
export const NULL_CASE: Readonly<Record<JevKind, string | undefined>> = { prompt: 'asks_for_work', step: undefined }
