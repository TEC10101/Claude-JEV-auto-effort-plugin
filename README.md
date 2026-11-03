# auto-effort

A Claude Code mod that picks the **effort** of each model request from what the session is doing: the skill in use, the plan's current step, and the prompt's words. A band above the prompt shows the pick and why, with two buttons: **Auto** (the mod picks) and **Manual** (the app's own effort setting runs).

## How it decides

In order, the first that speaks wins:

1. **Manual**: the app's setting, set by the band's button or by changing the effort in the app.
2. **Plan step**: the in-progress step of the session's plan (verify, test, review → high; log, note, rename → low). The closing wrap-up runs low.
3. **Prompt**: what the message asks.
4. **Stage**: the skill last loaded (a review runs high, a grilling round high).
5. **Default** for the model (Fable high, the others medium).

Haiku and Sonnet have a floor of medium, except for an acknowledgement and the wrap-up. Subagents run at their type's level, else the main loop's pick.

A switch between Auto and Manual pressed mid-turn waits for the next turn; the band keeps showing what the running turn uses, marked `(last turn)`.

## The judge: Jev or the word lists

With a `TYPESAFE_API_KEY` in the environment, the prompt and each plan step are judged by **Jev**, TypeSafe's System One model, at `api.typesafe.ai`. Without one, or when Jev times out or is unsure, scripted word lists decide. `/effort-mode rules` switches to the word lists alone.

**What is sent to Jev:** the prompt (up to 1500 characters), the tail of the assistant's previous reply (500 characters), the plan's step and its neighbors, and the stage. Every text is scrubbed first, best effort: URLs, email addresses, keys and credentials, home paths, IP addresses and phone numbers are replaced with placeholders, and names listed in `AUTO_EFFORT_REDACT` (comma-separated) become `<name>`. The scrubber matches patterns: a name you have not listed, or a street address, passes through. `/effort-jev last` prints the last request exactly as sent.

## Commands

| Command | Does |
|---|---|
| `/effort-show [seconds]` | Shows the band; `0` hides it, `-1` keeps it up |
| `/effort-mode [jev\|rules]` | Shows or sets the judge |
| `/effort-jev last\|test\|questions` | The last Jev request; a canned test request; the question set |
| `/effort-miss <level> [note]` | Marks the last turn as one that should have run at `<level>` |
| `/effort-report [clear]` | The hill climb: turns, misses and Manual turns beside what Auto would have run; `clear` forgets them |

The store keeps up to 400 turns, 200 misses and 200 Manual turns, prompts scrubbed and cut to 80 characters, for tuning the rules in `hooks/levers.ts`.

## Install

Zip the folder (`.claude-plugin`, `hooks`, `types`, `tsconfig.json`), add the zip in the Claude desktop app under Settings → Plugins, then run `/reload-plugins`.

## Develop

`hooks/levers.ts` holds the tables (word lists, levels, Jev's questions and walk), `hooks/rules.ts` the pure functions that read them, `hooks/register.tsx` the hooks and the band.

```
claude plugin test .
claude plugin validate .
```

## License

MIT
