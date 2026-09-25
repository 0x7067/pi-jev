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
| `rows_out` | `src/compaction/digest.ts` `renderDigest` | rows → one string |
| — | `splitSummary` | new, required by pi's `previousSummary` |
| `log_stats` | `src/jev/log.ts` `appendRecord` | same file name and record shape |
| `jev.py` `ask` / `resolve` / `provider_for` / `status` | `src/jev/client.ts` | |
| `jev.py` `config_dir` | `src/jev/env.ts` `configDir` | `$CLAUDE_CONFIG_DIR` → `$PI_CODING_AGENT_DIR` |
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

## Deliberately not implemented

claude-jev's `docs/compaction-design.md` ranks four items it has designed but
not shipped: a `kind` / `recoverable` / `tool_value` question set, merged tool
units with local classification and pointer lines, `fit_kept` ordered by kind,
and a stratified question budget above `MAX_BLOCKS`. None is in v0.22.0, so none
is here. Porting an unshipped proposal would have made the two implementations
diverge before either was measured.

The one that would pay soonest on pi transcripts is item 2. The replayed
digests are dominated by `[tool_use]` / `[tool_result]` pairs, and pointer lines
for read-class tools would cut the unit count roughly in half.

## Measured on real pi transcripts

`node scripts/replay.ts --limit 25`, 2026-09-25, live Jev via TypeSafe. 14 of
25 sessions were long enough to compact; the rest were skipped.

| | |
| --- | --- |
| blocks judged | 984 → 270 kept |
| transcript bytes | 727,477 → 131,338 (82% smaller) |
| digest size | 4,269–16,986 chars (~1.1k–4.2k tok) |
| time to compact | 259–1,295 ms |
| blocks left unscored | 0 of 984 |
| digest round-trips | 14/14 |
| tool results linked by id | 462 |
| of those, missed by text adjacency | 237 (51%) |
| kept results still without their call | 6 (1.3%, dropped by the digest cap) |
| rescue window fired | 2 sessions, 3 early constraints kept |

Digest sizes sit in the 3.2–3.9k token band claude-jev measures for its own
digest, and latency in its 0.9–1.1 s band, on the largest sessions. The replay
approximates pi's cut point by walking `estimateTokens` back to
`keepRecentTokens`; production gets the real boundary from
`prepareCompaction`. It measures size, latency, and pairing, not re-fetch
coverage — that needs the labelled replay in claude-jev's `eval/`, which reports
76–82% verbatim coverage against Claude Code transcripts.
