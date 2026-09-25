# pi-jev

Jev-powered compaction for [pi](https://pi.dev), and the first feature of a
TypeSafe-first experiment built around Pi and Jev.

When pi's context fills up, it asks a frontier model to write a summary of what
it is about to drop. That costs a minute or two and replaces your transcript
with prose about your transcript. This package asks
[TypeSafe's Jev](https://docs.typesafe.ai/introduction) instead — a System One
model that returns typed answers rather than generating text — which blocks
still matter, and keeps those blocks **verbatim**. No model writes a summary.

Ported from [`claude-jev`](https://github.com/0x7067/claude-jev) v0.22.0, where
the same selection runs against Claude Code's `session.compact` hook.

For the wider plan see [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md),
[`docs/SPEC_PI_EXTENSION.md`](docs/SPEC_PI_EXTENSION.md), and
[`docs/SPEC_STANDALONE.md`](docs/SPEC_STANDALONE.md).

## Install

```bash
pi install git:github.com/0x7067/pi-jev
```

Then set `TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` for an `sk-or-` key. pi
does not load `~/.pi/agent/.env` into the process environment, so this package
reads that file directly too — either place works.

Without a key the extension switches off silently and pi's own summary runs.

Turn auto-compaction on if you have it disabled:

```json
{ "compaction": { "enabled": true } }
```

`/compact` works either way.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | Jev key. Read first, and an `sk-or-` value still routes to OpenRouter |
| `OPENROUTER_API_KEY` | — | Read second when `TYPESAFE_API_KEY` is unset |
| `JEV_PROVIDER` | `auto` | `typesafe` or `openrouter` pins one provider and its own variable |
| `JEV_MODEL` | `jev-latest` | System One model id |

Both key variables are read from the launch environment first, then from
`~/.pi/agent/.env` (or `$PI_CODING_AGENT_DIR/.env`).

## Commands

`/jev` — key source, provider, package version, the last Jev call, and the last
compaction. Never prints the key.

## How the selection works

1. **Blocks.** pi's `messagesToSummarize` plus any split-turn prefix become one
   block per message, rendered with the `[tool_use name]` and `[tool_result]`
   markers claude-jev uses, so the checks and thresholds carry over unchanged.
   Thinking blocks are skipped. A previous summary is split back into blocks so
   it competes in this selection instead of being cut to one head.
2. **Windows.** The newest 150 blocks get all five checks; the 150 before them
   get the constraint check alone, so a rule stated early in a long session
   still reaches Jev. The newest 4 are kept unjudged — that is the live context.
3. **Checks.** Five concrete yes/no questions per block: `constraint`,
   `decision`, `error`, `open`, `rerunnable`. Keep is the max of the first four
   at 0.5. The verbatim score is `constraint`, or `error` unless `rerunnable`
   also fires — output a rerun would print again keeps a 400-char head with a
   re-read pointer, not the whole block.
4. **Pairing.** A kept tool result pulls its tool call back in, linked by pi's
   `toolCallId` rather than by position — pi assistants usually say something
   before calling a tool, and text adjacency misses about half the pairs.
5. **Cap.** 16,000 chars of transcript bytes. Over that, the least confident
   whole keeps are downgraded to heads first, then the weakest blocks are
   dropped, oldest first on a tie. The pinned tail is exempt.
6. **Digest.** The kept blocks are joined with `---[jev:<n>:<role>]---` lines
   and returned as pi's `summary`, so pi stores it in the `CompactionEntry` and
   injects it as the compacted history.

Requests are chunked at 10 blocks each with up to 16 in flight, so a compaction
costs about one round trip regardless of session length.

## Failure behaviour

Everything fails open. No key, an unreachable API, a timeout, or an empty span
returns nothing from the hook and pi's own summary runs. A chunk that fails
contributes no answers, and an unscored block is kept whole rather than guessed
about — partial failure grows the digest, it does not shrink it.

## Measured

`node scripts/replay.ts` replays real transcripts from pi's own session store
through the ported pipeline. Over 24 sessions replayed with live Jev judgments:

| | |
| --- | --- |
| blocks judged | 2,298 → 469 kept |
| transcript bytes | 1,393,417 → 218,515 (84% smaller) |
| digest size | 4,112–17,322 chars (~1.0k–4.3k tok) |
| time to compact | 255–1,424 ms |
| blocks left unscored | 0 |
| digest round-trips | 24/24 |
| tool results paired with their call | 1,071, of which 472 would have been missed by text adjacency |
| sessions where the 16k cap binds | 7 of 24, dropping 246 blocks |
| pinned share where the cap binds | median 16%, max 21% |

The replay approximates pi's cut point by walking token estimates back to
`keepRecentTokens`; production uses pi's own `prepareCompaction`. It does not
measure re-fetch coverage — claude-jev's `eval/` does, against Claude Code
transcripts, and reports 76–82% verbatim coverage there.
`docs/compaction-port.md` has the full budget analysis.

## Layout

```
extensions/jev.ts        pi adapter: event wiring, /jev, nothing else
src/pi/blocks.ts         pi messages -> judge-visible blocks
src/pi/digest.ts         kept blocks -> pi's summary string, and back
src/pi/paths.ts          pi's config dir, .env, logs, session store
src/compaction/select.ts the selection engine, framework-agnostic
src/jev/client.ts        System One client, key and provider resolution
src/jev/env.ts           process env with an optional dotenv fallback
src/jev/log.ts           JSONL append and tail read, paths supplied
scripts/replay.ts        replay real pi transcripts through the pipeline
```

Per `docs/SPEC_PI_EXTENSION.md` §11, no selection logic lives in an event
handler. `src/jev` and `src/compaction` reference nothing pi-specific — not the
package, not `PI_CODING_AGENT_DIR`, not a log path — so the standalone track can
reuse them unchanged. File locations are arguments, not defaults.
`docs/compaction-port.md` records what the port changed, what it left alone, and
what the budget constants measure on real transcripts.

Logs land in `~/.pi/agent/jev-calls.jsonl` (one line per Jev call) and
`~/.pi/agent/jev-compact-log.jsonl` (one line per compaction, including the
per-block scores).

## Development

```bash
npm install
npm run check          # tsc --noEmit && node --test
npm run replay         # newest 5 real sessions
npm run replay -- --limit 20 --show 40
```

Tests are deterministic and need no key. The replay uses live Jev when a key
resolves and says loudly when it is stubbing instead.

## License

MIT
