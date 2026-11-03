// The contract of the auto-effort mod: what it keeps in `$.state` (the live
// signals the band draws) and the rows it keeps in `$.store` (the hill climb).

export type AutoEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What a decision may name: a level, or `manual`, the app's own setting with the rules set aside (`session` is the same in rows from before 0.2.0). */
export type AutoEffortChoice = AutoEffortLevel | 'manual' | 'session'

/** One signal: a level and the words the band shows beside it. */
export type AutoEffortSignal = {
  level: AutoEffortLevel
  reason: string
  /** Who produced it when not the slot's own name: `jev` on a prompt or step signal Jev decided. */
  source?: AutoEffortSource
  /** The model's floor does not apply: the turn is an acknowledgement and low is low on any model. */
  underFloor?: true
}

/** Where a decision came from, in the order `decide` consults them. */
export type AutoEffortSource = 'carried' | 'manual' | 'step' | 'prompt' | 'stage' | 'jev' | 'default' | 'pinned' | 'override'

/** Which judge produces the prompt and step signals: Jev (TypeSafe's System One model) or the scripted word lists. */
export type AutoEffortMode = 'jev' | 'rules'

/** Jev's answers about one prompt or step: one probability per question of that kind. The decision walk in hooks/rules.ts reads a level from them. */
export type AutoEffortJudgment = {
  kind: 'prompt' | 'step'
  /** Question id → the probability of yes, 0 to 1. */
  nouls: Record<string, number>
  /** Round trip in milliseconds. */
  ms: number
  model: string
  /** The answer arrived after the deadline; the rules decided the turn. */
  late?: true
}

/** Why Jev gave no answer; the rules decided. */
export type AutoEffortJevFailure = {
  kind: 'no-key' | 'unauthorized' | 'rate-limit' | 'overloaded' | 'server' | 'timeout' | 'network' | 'bad-request' | 'bad-answer'
  status?: number
  ms?: number
  /** The failure arrived after the deadline; the row keeps its timeout. */
  late?: true
}

export type AutoEffortJevResult = AutoEffortJudgment | AutoEffortJevFailure

/** Everything a decision is made from. `decide` in hooks/rules.ts folds it. */
export type AutoEffortSignals = {
  /** The session's own effort, as the first request of the last main turn carried it. */
  engine?: AutoEffortLevel | number
  /** The model of the last main turn's first request, so the band can show the model's floor. */
  model?: string
  /** The stage the last loaded skill put the session in. Lasts the session. */
  stage?: AutoEffortSignal
  /** What the prompt's words said. Lasts the turn. */
  prompt?: AutoEffortSignal
  /** What the plan's in_progress step said. Until the next step, or the turn's end. */
  step?: AutoEffortSignal
  /** Manual: the app's own setting runs, the rules set aside, until Auto. Set by the band's Manual button or by a change of the app's setting. */
  manual?: { reason: string }
  /** Manual or Auto pressed while a turn's effort was on the band (0.3.11): it takes effect when the next turn opens; until then the band keeps the turn's level marked `(last turn)` and the buttons show the choice. */
  pending?: { to: 'manual' | 'auto'; reason: string }
  /** The prompt was evaluated and placed nowhere (Jev unsure or nothing fits, the word rules silent): the band says `no change`, with the why. Lasts the turn. */
  unplaced?: { reason: string }
  /** What the last finished turn ran at, as the band showed it: drawn between turns until the next prompt. Display only. */
  last?: { level: string; reason: string }
  /** The choice the band last showed; a decision that differs pops the band. Absent reads as `manual`. */
  shown?: AutoEffortChoice
  /** The band is drawn while the clock is before this time; absent, it is hidden. */
  bandUntil?: number
  /** The session's first typed prompt has had its hold (HOLD_MS): later prompts go straight to the judges. */
  held?: true
  /** Seconds left of the first prompt's hold, drawn in the band; cleared by Send now or the hold's end. */
  countdown?: number
  /** The whoosh's frame while a prompt judgment ripples across the band's reason: the window's leading edge, in characters from the reason's start; absent between. */
  ripple?: number
  /** Mirror of the store's `mode`, so a drawing can read it. Absent reads as `rules`. */
  mode?: AutoEffortMode
  /** The last Jev request: its state exactly as sent, and what came back. `/effort-jev last` prints it. */
  lastJev?: { at: string; kind: 'prompt' | 'step' | 'test'; state: string; result: AutoEffortJevResult }
}

export type AutoEffortDecision = { level: AutoEffortChoice; reason: string; source: AutoEffortSource; underFloor?: true }

/** One main-loop turn as the store remembers it: a row of the hill climb. */
export type AutoEffortTurn = {
  /** ISO time the turn ended. */
  at: string
  /** The prompt's first 80 characters. */
  prompt: string
  /** The decision in force when the turn ended (most often the wrap-up step); absent when the engine's own level ran. */
  decision?: AutoEffortDecision
  /** The decision in force at the turn's first model request: the pick the prompt (or the stage) made. 0.3.0. */
  first?: AutoEffortDecision
  /** What each main-loop request ran at, after the mod's rewrite and the floor: the honest tally of the turn, where `decision` is one moment of it. 0.3.0. */
  ran?: Record<string, number>
  /** The session's own level, for comparison. */
  engine?: AutoEffortLevel | number
  /** Model requests the turn made. */
  steps: number
  seconds: number
  outputTokens?: number
  /** The judge in force when the turn ran. Absent on rows from before the switch: rules. */
  mode?: AutoEffortMode
  /** Jev's answers this turn, in jev mode: the prompt's and each in_progress step's (at most 8). */
  jev?: { prompt?: AutoEffortJevResult; steps?: AutoEffortJevResult[] }
  /** What the word lists said this turn, kept beside Jev's answers to compare the judges; `steps` is parallel to `jev.steps`, null where no rule matched. */
  rules?: { prompt?: AutoEffortSignal; steps?: (AutoEffortSignal | null)[] }
}

/**
 * A miss: the rules ran a level and Mac chose another (`ran` set), by
 * /effort-miss. The store's `manual` list holds the same row for each turn run
 * in Manual (`how` `manual`, 0.3.9): `ran` is then what Auto would have run,
 * `chosen` what the app's setting ran at the turn's first request.
 */
export type AutoEffortMiss = {
  at: string
  prompt: string
  /** What ran. Absent when nothing but the engine's own level was in force. (`override`, and `how` other than `miss-command`, are rows from before 0.2.0.) */
  ran?: AutoEffortDecision
  chosen: AutoEffortChoice
  how: 'once' | 'pin' | 'prefix' | 'band' | 'miss-command' | 'manual'
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'auto-effort': { signals: Shaped<AutoEffortSignals> }
  }
}
