# The compaction port

What was carried over from `claude-jev` v0.22.0, what had to change because pi's
host contract is different, and what was deliberately left behind.

Source: `scripts/compactor.py` (the `rows` path), `scripts/jev.py`, and the
`session.compact` handler in `hooks/register.ts`. Design rationale and the
measured Claude Code baseline live in claude-jev's `docs/compaction-design.md`;
nothing here re-derives it.

## The host contract is the whole difference

| | Claude Code | pi |
| --- | --- | --- |
| Hook | `session.compact` function hook | `session_before_compact` event |
| Input | rows: `{role, text, toolUses, toolResults, handle}` | `preparation.messagesToSummarize` as `AgentMessage[]` |
| Output | replacement rows, passed back by handle where untouched | one `summary` string plus `firstKeptEntryId` |
| Recent tail | none — the digest is the whole post-compaction context | pi keeps `keepRecentTokens` (default 20k) verbatim on its own |
| Previous digest | still rows in the conversation, re-judged next time | handed over separately as `preparation.previousSummary` |
| Off switch | `userConfig` row in `/claude-jev` and `/config` | absent key, or pi's `compaction.enabled` |

Everything below follows from the output column: pi takes a string, so the kept
blocks have to be concatenated, and a concatenated digest has to be splittable
again for the next pass.

## Symbol map

| claude-jev | pi-jev | Notes |
| --- | --- | --- |
| `compactor.py` constants | `src/compaction/select.ts` constants | unchanged, see table below |
| `judgeable` | `judgeable` | same meta prefixes, same ack gate |
| `block_text` | `src/pi/blocks.ts` `blockFrom` | reads pi content blocks instead of Anthropic ones |
| `row_text` | folded into `blockFrom` | pi has no row/handle shape to flatten |
| `session_context` | `sessionContext` | |
| `compact_state` | `compactState` | |
| `CHECKS` / `keep_questions` | `CHECKS` / `keepQuestions` | question text byte-identical |
| `verdicts` | `verdicts` | |
| `ask_chunked` | `askChunked` | thread pool → promise pool, same 16-wide cap |
| `cut_marked` / `truncate_block` | `cutMarked` / `truncateBlock` | |
| `fit_kept` | `fitKept` | |
| `block_kind` / `block_rows` | `blockKind` / `blockRows` | |
| `select_blocks` | `selectBlocks` | takes `ask` as a parameter so tests need no network |
| `rows_out` | `src/pi/digest.ts` `renderDigest` | rows → one string |
| — | `splitSummary` | new, required by pi's `previousSummary` |
| `log_stats` | `src/jev/log.ts` `appendRecord` | same record shape; the path is an argument |
| `jev.py` `ask` / `resolve` / `provider_for` / `status` | `src/jev/client.ts` | |
| `jev.py` `config_dir` | `src/pi/paths.ts` `configDir` | `$CLAUDE_CONFIG_DIR` → `$PI_CODING_AGENT_DIR`, and now pi-side |
| `register.ts` `session.compact` handler | `extensions/jev.ts` | |

## Deviations, and why each one is safe

**Rows became a delimited string.** pi stores one `summary`, so kept blocks are
joined with `---[jev:<n>:<role>]---` lines. The digest is therefore
`TARGET_CHARS` of transcript bytes plus about 25 chars of structure per kept
block — 17,237 chars measured at the cap, against a 16,000-char block budget.
The "no generated prose" invariant holds: the delimiters are structure, and the
header is the only sentence the package writes.

**Handle pass-through is gone.** Claude Code restored the original message
object when a plain row's text survived untouched, so an image or a custom
content block could survive compaction. pi's `CompactionEntry` carries a string,
so every kept block is text. Nothing is lost that pi's own compaction would have
kept — it serializes to text too.

**`firstKeptEntryId` comes from pi, unchanged.** claude-jev replaced the whole
context and relied on `PIN_TAIL` for the live tail. pi already keeps
`keepRecentTokens` verbatim, so the digest covers only the summarized span and
the pin applies inside that span. Overriding the boundary to retain nothing
would have thrown away pi's own recent-message handling for no measured gain.

**Tool results get the role `tool`, not `user`.** pi hands each tool result over
as its own message; Claude Code attaches them to a user-role row. Labelling them
`user` here would put command output into `sessionContext`'s "Most recent user
requests" header and crowd out real requests. This is a small improvement over
the Claude version, where the header does include tool results.

**Roles pi folds into `user` are read before the fold.** `convertToLlm` maps
`bashExecution`, `branchSummary`, and `compactionSummary` onto user messages,
erasing which they were. `blocksFrom` converts one message at a time so the
original role is still in hand, and relabels those three as `bash` and `summary`.
A command the user ran with `!` still deserves a judgment — its output may be an
error only the user has seen — but it is not a request, and neither is a summary
pi already wrote. Claude Code tags the first `<bash-` and `judgeable` drops it
outright; keeping it judged is deliberate.

**Pairing a kept tool result with its call uses pi's `toolCallId`, not text
adjacency.** claude-jev pulls in `blocks[i-1]` when it starts with `[tool_use`.
In pi that misses whenever the assistant said something before calling the tool,
which is the common case: over 14 replayed sessions, 237 of 462 tool results —
51% — would have been orphaned by the adjacency rule. `blocksFrom` links each
result to the block carrying its call id, and `selectBlocks` follows that link.
The adjacency rule survives only as a fallback for blocks that arrive as plain
text with no ids left, such as a re-digested summary.

**A previous summary is split back into blocks.** pi does not include the
previous summary in `messagesToSummarize`, and everything it covered is
otherwise gone, so dropping it would lose all earlier work. `splitSummary`
re-blocks it three ways: a jev digest splits on its own delimiters and keeps
each block's original role, so it is re-judged block by block exactly as
claude-jev re-judges its own rows; pi's structured summary splits on its `## `
sections; anything else is one block. Non-jev blocks get the role `summary`, not
`user`, for the same reason as tool results.

**The block budget reserves room for that summary.** claude-jev took the newest
`MAX_BLOCKS + RESCUE_BLOCKS` rows and let older ones fall off. Doing that to the
combined list here would push the previous summary off the front on any session
over 300 blocks — losing precisely the thing that cannot be recovered. `prior`
is kept whole and the fresh span is capped to the remaining room.

**The transcript path was not ported.** `transcript_blocks`, `judge`,
`visible_text`, `injected`, and `compaction_marker` exist in `compactor.py` so
claude-jev's `eval/` can replay recorded Claude Code transcripts.
`scripts/replay.ts` fills that role here by reading pi's session store through
pi's own `parseSessionEntries` and `buildSessionContext`, which is a closer
analogue than porting the JSONL reader would have been.

**The settings pane was not ported.** Claude Code's `userConfig` rows and the
`/claude-jev` pane have no package-level equivalent in pi. Configuration is
environment variables, and `/jev` is read-only status.

**`stats.py` was not ported.** The compaction log carries the same per-block
`rows`, so a report can be written against it later without another pass over
the selection.

**Delimiter collisions cost a judgment, not content.** A kept block whose own
text contains a line matching `---[jev:<n>:<role>]---` splits into two blocks on
the next pass — which is a live risk in a session about this repository. Both
halves are still kept verbatim and each is judged on its own, so the failure is
one extra question. The replay's `roundtrip` column watches for it; 15 of 15
real sessions round-tripped.

**Character counting differs on non-BMP text.** Python's `len()` counts code
points, JavaScript's `.length` counts UTF-16 units, so a budget can be spent
slightly earlier on emoji. Not worth normalizing.

**HTTP errors are not retried.** Parity with `jev.py`: a refused connection is
retried once if it came back in under a second, a non-2xx is not retried at all.
`jev-ultrafast` retries 429/503/529; that policy was not carried across because
compaction has a fallback and a retry costs wall time the fallback does not.

## Constants

Unchanged from claude-jev v0.22.0, so the eval numbers there still describe
this code's behaviour.

| Constant | Value | | Constant | Value |
| --- | --- | --- | --- | --- |
| `KEEP_THRESHOLD` | 0.5 | | `BLOCK_CHARS` | 1200 |
| `MAX_BLOCKS` | 150 | | `KEEP_CHARS` | 1500 |
| `RESCUE_BLOCKS` | 150 | | `HEAD_CHARS` | 400 |
| `ASK_TIMEOUT_MS` | 4000 | | `HEAD_SLACK` | 200 |
| `PIN_TAIL` | 4 | | `TARGET_CHARS` | 16000 |
| `BLOCKS_PER_CHUNK` | 10 | | `REF_CHARS` | 160 |
| `DIRECTIVE_CHARS` | 500 | | `TOOL_INPUT_CHARS` | 400 |
| `HEADER_CHARS` | 1500 | | `TOOL_RESULT_CHARS` | 800 |
| `MAX_WORKERS` | 16 | | `DEFAULT_TIMEOUT_MS` | 8000 |

## Layering

`docs/SPEC_PI_EXTENSION.md` §11 requires the framework-agnostic modules to be
reusable by the standalone track, so the boundary is enforced rather than
intended. `src/jev` and `src/compaction` contain no reference to
`@earendil-works/*`, `PI_CODING_AGENT_DIR`, or any pi path; `grep` for those
outside `src/pi` and `extensions` returns nothing.

Two things make that hold:

- **The engine defines its own input type.** `selectBlocks` works on
  `{ role, text, needs? }` and never sees an `AgentMessage`, a
  `CompactionPreparation`, or an `ExtensionContext`. `src/pi/blocks.ts` is the
  only place pi's message shape is read.
- **The Jev transport is injected.** `selectBlocks` takes `ask: AskFn`. The
  adapter supplies one wired to pi's `AbortSignal` and pi's log paths; the tests
  supply a stub. File locations are arguments (`JevFiles`), not module state, so
  the client has no default directory to be wrong about.

`src/pi/digest.ts` sits on the pi side deliberately. It renders `Kept[]` into
the single string pi's `CompactionEntry.summary` holds, and `splitSummary`
recognises pi's own `## ` section format — both are pi contracts. The engine
returns `Selection.kept`, which is what a `ContextView`-building runtime would
consume directly; nothing in `src/compaction` imports the digest, so the
dependency only ever points toward pi.

The budgets are the part that would not transfer. `TARGET_CHARS`, `PIN_TAIL`,
and `BLOCK_BUDGET` assume a host that keeps its own recent tail and lets an
extension fill one summary slot. A per-step `ContextView` would want different
numbers; see the measurements below.

## Re-fetch coverage on real pi transcripts

`scripts/coverage.ts` ports the metric from claude-jev's `eval/compare.py`. It
needs no labels: a real compaction boundary splits a session into before and
after, and any location fetched on both sides is an artifact the session needed
again. The question is whether the post-compaction context names that location
well enough to re-fetch it. `verbatim` counts only locations whose route
survives in a block kept whole, not in a 400-char head.

The default side is free: pi stores its own summary in the `CompactionEntry`, so
no LLM has to be paid to reproduce it. Both sides get the same retained tail,
and the "alone" column strips it so the summary and the digest can be compared
directly.

Over every session in `~/.pi/agent/sessions` that contains a compaction entry —
69 boundaries with signal, 6,609 re-fetch events, live Jev:

| pointer lines | index chars median | default | jev digest | jev verbatim | floor 70% |
| --- | --- | --- | --- | --- | --- |
| 0 | 0 | 90% | 84% | 66% | FAIL |
| 15 | 611 | 90% | 88% | 77% | PASS |
| 30 | 1,339 | 90% | 91% | 82% | PASS |
| 60 | 2,628 | 90% | 95% | 91% | PASS |
| **40, shipped** | **1,910** | **90%** | **91%** | **83%** | **PASS** |

The first four rows spend the index on top of a 16,000-char block budget, so the
digest grows to 19,178 chars at 60 lines. The shipped row reserves
`POINTER_CHARS = 2000` out of `TARGET_CHARS` instead, which is why its coverage
sits between the 30- and 60-line rows while its digest median is 16,456 chars —
*smaller* than the 16,972 of the no-index row, and inside the cap. Buying the
index out of the budget rather than adding it costs about 8 points of coverage
against the unbudgeted 60-line run and keeps the digest bounded, which is the
trade worth making: an unbounded summary is the failure mode compaction exists
to prevent.

Shipped: 83% verbatim against a 70% floor, 91% for the digest against pi's 90%
on identical footing, 85% against 76% when the shared retained tail is stripped
so only the differing part is compared.

Without the index the digest spends 17.0k chars to reach 66% while pi's summary
spends 10.8k to reach 90%. pi wins because its summary ends with deterministic
`<read-files>` and `<modified-files>` indexes — the same mechanism claude-jev's
`compaction-design.md` proposes as its item 2 and ranks as paying soonest. The
measurement says the proposal is not optional on pi: pi's default already has
it, so shipping without it is a regression against the thing being replaced.

These numbers are not comparable to claude-jev's 76–82%. The extractor below is
generic, so bash commands and generated code contribute locations that
claude-jev's tool-name table never saw; 6,609 events against its 107–274.

### Locating what a tool call touched

The first version of this named tools: a table of `read` / `edit` / `write` /
`grep`, plus a regex for `fabric_exec`'s generated JavaScript. That does not
survive contact with a real pi install, which had `agent_browser`,
`exec_command`, `jev_browse`, `scrape`, `subagent_spawn`, `recall`, `workflow`
and a dozen more behind it — and `fabric_exec` came from a package that was
uninstalled between writing the table and running it.

`src/pi/refs.ts` replaces the table with a walk over the argument tree. No tool
is named anywhere. A string is a location if its key looks like one (`path`,
`file`, `target`, `dest`, `source`, `dir`, `url`, `uri`, `pattern`, `glob` and
close variants), or — for free text such as a shell command or generated code —
if it contains a path- or URL-shaped substring. Nesting and arrays are walked to
a bounded depth, and the whole scan is capped so one argument cannot dominate
the index.

That covers a third-party tool the moment it passes a path, without anyone
having seen it. It also fails honestly: a wrapper that builds paths out of
variables and template literals exposes nothing to any local rule, and the
location is simply not found. Reaching those would mean asking Jev, which is the
TypeSafe-native answer and a per-call cost `compaction-design.md` deliberately
avoids for pointers.

The residual risk is over-collection rather than under-collection: a path
mentioned incidentally in a bash command becomes a pointer line. The 60-line
bound caps the cost at ~650 tokens median, and an extra correct-looking path in
the index is cheap next to a missing one.

`Block.refs` carries the locations into the engine, lifted from the full
arguments before they are truncated to 400 chars — a head of `[tool_use edit]
{"edits":[…]}` loses the `path` field, so it cannot be recovered afterwards.

### Shipped

`pointerIndex` lives in `src/pi/digest.ts` and is the one implementation: the
extension calls it, and so does `scripts/coverage.ts`, so the number the eval
reports is the digest production writes. `MAX_POINTER_LINES = 40`,
`POINTER_CHARS = 2000`, and `selectBlocks` is handed
`TARGET_CHARS - POINTER_CHARS` so the index is paid for out of the block budget
rather than added on top of it.

The index is stripped by `splitSummary` before a digest is re-blocked. It is
derived from the selection that produced it and the next compaction rebuilds its
own, so re-judging it would spend questions on paths and keep them twice.

`scripts/coverage.ts --pointer-lines N` sweeps the budget; `0` turns the index
off and lifts the reservation, which is how the table above was produced.

## Deliberately not implemented

claude-jev's `docs/compaction-design.md` ranks four items it has designed but
not shipped: a `kind` / `recoverable` / `tool_value` question set, merged tool
units with local classification and pointer lines, `fit_kept` ordered by kind,
and a stratified question budget above `MAX_BLOCKS`. None is in v0.22.0.

Item 2 is now partly here, and only because the coverage eval forced it: the
pointer lines ship, the merged tool units and local classification do not. The
remaining three are still unshipped, and the reason is unchanged — porting an
unmeasured proposal makes the two implementations diverge before either has a
number behind it.

Merging `[tool_use]` / `[tool_result]` pairs into one judged unit remains the
cheapest next step. The replayed digests are dominated by those pairs, and the
pairing already links them by `toolCallId`, so the unit boundary is known
without any new parsing.

## Measured on real pi transcripts

`node scripts/replay.ts --limit 40`, 2026-09-25, live Jev via TypeSafe. 24 of
40 sessions were long enough to compact; the rest were skipped.

| | |
| --- | --- |
| blocks judged | 2,298 → 469 kept |
| transcript bytes | 1,393,417 → 218,515 (84% smaller) |
| digest size | 4,112–17,322 chars (~1.0k–4.3k tok) |
| time to compact | 255–1,424 ms |
| blocks left unscored | 0 of 2,298 |
| digest round-trips | 24/24 |
| tool results linked by id | 1,071 |
| of those, missed by text adjacency | 472 (44%) |
| kept results still without their call | 12 (1.1%, dropped by the digest cap) |
| rescue window fired | 6 sessions |
| `BLOCK_BUDGET` (300) binding | 4 sessions, from 381–595 summarized messages |

### The budget constants

`TARGET_CHARS` and `PIN_TAIL` are inherited from claude-jev, where the digest
replaced the entire context. In pi the digest only fills the summary slot beside
a tail pi keeps verbatim, so both had to be re-checked rather than assumed.

| | |
| --- | --- |
| sessions where the 16k cap binds | 7 of 24 (29%) |
| blocks the cap dropped | 246 |
| blocks the cap downgraded to heads | 32 |
| digest on cap-bound sessions | median 16,987 chars |
| pinned share, cap-bound sessions | median 16%, max 21% |
| pinned share, sessions with slack | median 40% |
| pinned chars | median 2,227, max 3,327 of 16,000 |

The cap earns its place: it is the binding constraint on roughly a third of real
sessions, and on those the digest lands at ~4.2k tokens.

`PIN_TAIL` does not compete with it. The headline pinned share — median 29%,
p90 68%, max 100% — is an artifact of short sessions with 10k chars of unused
budget. On the sessions where the cap actually binds, the pin costs 16% median
and 21% worst case, about 550–830 tokens. It buys continuity at the seam
immediately before pi's own verbatim tail, which is where a model is most likely
to lose the thread. Keep it, but it is now a measured tradeoff rather than an
inherited constant.

This corrects claude-jev's `docs/compaction-design.md`, which reports pinned
shares of median 24% / p90 31% / p99 40% at an 8k cap and predicts "at 16k those
shares halve." On pi transcripts at a 16k cap the median is 29%, not ~12%. Part
of the difference is structural: in pi the pinned blocks are the newest four of
the *summarized* span, adjacent to a tail pi already keeps, rather than the live
tail of the whole conversation.

### The `PIN_TAIL = 0` experiment

`node scripts/replay.ts --pin-tail 0` against the same 20 session files, live
Jev, paired with a `--pin-tail 4` baseline. The question: pi already keeps
`keepRecentTokens` verbatim, so is the pin redundant?

Fate of the four newest blocks of the summarized span — the seam between the
digest and pi's own retained tail — when they are judged instead of pinned
(n=80):

| verdict | |
| --- | --- |
| kept whole | 10 (13%) |
| truncated to a head | 22 (28%) |
| dropped | 48 (60%) |

What got cut: 28 tool results, 16 assistant texts, 11 `fabric_exec` calls, 5
tool results truncated, 3 `bash` calls, 3 assistant texts, one each of `edit`,
`write`, `read` — and **one user message, truncated**.

| | `PIN_TAIL 4` | `PIN_TAIL 0` |
| --- | --- | --- |
| digest median, all sessions | 9,757 | 8,407 |
| digest median, cap-bound sessions | 17,002 | 17,133 |
| blocks the cap dropped | 188 | 176 |
| blocks kept | 397 | 372 |

The decisive row is the second. **On sessions where the cap binds, the pin costs
nothing**: the digest is ~17.0k chars either way, because `fitKept` drops blocks
to hit `TARGET_CHARS` regardless. The pin does not enlarge the digest there, it
only reserves a slot in it — guaranteeing the seam is among the blocks that
survive. It is free exactly where budget is scarce, and costs ~1,350 chars
median (~340 tokens, roughly 3.5% of a 40k context) only on sessions that had
10k chars of slack anyway.

Dropping 60% of the seam for 340 tokens on slack sessions is a bad trade, so
`PIN_TAIL = 4` stays.

The nuance worth keeping: most of what gets dropped is defensible in isolation.
`Successfully wrote to <path>`, `Successfully replaced 2 block(s) in <path>`, a
search command a rerun would reproduce — the `rerunnable` check is right to
demote those. Jev is not making a mistake. The seam simply has a structural role
the five checks never ask about: it is the lead-in to the messages pi keeps
verbatim, and dropping it leaves the retained tail referring to edits and
commands that are no longer in context. That is a deterministic guarantee, not a
semantic judgment, which is why it is a pin and not a question — the same
distinction `PRODUCT_VISION.md` draws in principle 9: semantic judgment does not
replace deterministic policy.

The replay approximates pi's cut point by walking `estimateTokens` back to
`keepRecentTokens`; production gets the real boundary from
`prepareCompaction`. It measures size, latency, pairing, and budget pressure,
not re-fetch coverage — that needs the labelled replay in claude-jev's `eval/`,
which reports 76–82% verbatim coverage against Claude Code transcripts.
