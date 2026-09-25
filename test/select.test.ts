import assert from "node:assert/strict";
import { test } from "node:test";
import { JevError, type Answers } from "../src/jev/client.ts";
import {
	ASK_CHECKS,
	cutMarked,
	elision,
	fitKept,
	HEAD_CHARS,
	HEAD_SLACK,
	KEEP_CHARS,
	KEEP_THRESHOLD,
	MAX_BLOCKS,
	PIN_TAIL,
	RESCUE_BLOCKS,
	selectBlocks,
	truncateBlock,
	verdicts,
	judgeable,
	keepQuestions,
	type AskFn,
	type Block,
	type Kept,
} from "../src/compaction/select.ts";

const block = (role: string, text: string): Block => ({ role, text });
const blocks = (n: number, make = (i: number) => block("user", `block ${i}`)): Block[] =>
	Array.from({ length: n }, (_, i) => make(i));

/** Answers every check for block `i` from a table, so a test states only the
 * scores it cares about and every other check reads as a confident no. */
function answerWith(scores: Record<number, Partial<Record<string, number>>>): AskFn {
	return async (_state, questions) => {
		const answers: Answers = {};
		for (const key of Object.keys(questions)) {
			const [name, index] = key.split("_");
			answers[key] = { noul: scores[Number(index)]?.[name] ?? 0 };
		}
		return answers;
	};
}

test("judgeable drops harness writes and one-word acks", () => {
	assert.equal(judgeable("user", ""), undefined);
	assert.equal(judgeable("user", "<system-reminder>be careful</system-reminder>"), undefined);
	assert.equal(judgeable("user", "<command-name>/compact</command-name>"), undefined);
	assert.equal(judgeable("user", "<task-notification>agent finished</task-notification>"), undefined);
	assert.equal(judgeable("user", "ok"), undefined);
	assert.equal(judgeable("user", "OK."), undefined);
	assert.equal(judgeable("user", "thanks"), undefined);
	assert.equal(judgeable("assistant", "ok"), "ok", "the ack gate is about the user channel only");
	assert.equal(judgeable("user", "ok, but keep the tests green"), "ok, but keep the tests green");
});

test("cutMarked leaves a short block alone", () => {
	assert.equal(cutMarked("short", 100), "short");
	assert.equal(cutMarked("exactly ten", 11), "exactly ten");
});

test("cutMarked prefers a paragraph break and reports what it cut", () => {
	const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}`;
	const cut = cutMarked(text, 400);
	assert.equal(cut, `${"a".repeat(300)}\n${elision(text.length - 300)}`);
	assert.ok(elision(302).includes("re-read the file or re-run the command"), "says how to get it back");
});

test("cutMarked cuts mid-paragraph when there is no break to prefer", () => {
	const text = "x".repeat(1000);
	const cut = cutMarked(text, 100);
	assert.equal(cut.split("\n")[0], "x".repeat(100));
	assert.ok(cut.includes("900 chars elided"));
});

test("truncateBlock keeps a block that is only just over the head length", () => {
	const atSlack = "y".repeat(HEAD_CHARS + HEAD_SLACK);
	assert.equal(truncateBlock(atSlack), atSlack);
	assert.ok(truncateBlock(`${atSlack}z`.repeat(2)).includes("chars elided"));
});

test("verdicts keeps on the strongest of the four keep checks", () => {
	const answers: Answers = {
		constraint_0: { noul: 0.1 },
		decision_0: { noul: 0.9 },
		error_0: { noul: 0 },
		open_0: { noul: 0.2 },
		rerunnable_0: { noul: 0 },
	};
	const { keep, full, checks } = verdicts(answers, 0);
	assert.equal(keep, 0.9);
	assert.equal(full, 0.1, "verbatim needs a constraint, not just a reason to keep");
	assert.equal(Object.keys(checks).length, ASK_CHECKS.length);
});

test("verdicts lets a rerunnable score silence an error", () => {
	const rerunnable: Answers = { error_1: { noul: 0.9 }, rerunnable_1: { noul: KEEP_THRESHOLD } };
	assert.equal(verdicts(rerunnable, 1).full, 0, "output a rerun would print again keeps a head, not whole");

	const notRerunnable: Answers = { error_1: { noul: 0.9 }, rerunnable_1: { noul: KEEP_THRESHOLD - 0.01 } };
	assert.equal(verdicts(notRerunnable, 1).full, 0.9);
});

test("verdicts answers null when nothing was scored, so the block is kept whole", () => {
	const { keep, full, checks } = verdicts({}, 7);
	assert.equal(keep, null);
	assert.equal(full, null);
	assert.deepEqual(checks, {});
});

test("keepQuestions indexes every check by block position", () => {
	const questions = keepQuestions(3);
	assert.equal(Object.keys(questions).length, 3 * ASK_CHECKS.length);
	assert.deepEqual(questions["constraint_2"], {
		type: "noul",
		instructions: "Does block [2] state a requirement, restriction, or preference from the user about how the work must be done: something not to touch, a tool or approach to use, a deadline, a scope limit?",
	});
	assert.deepEqual(Object.keys(keepQuestions(5, ["constraint"])), [
		"constraint_0",
		"constraint_1",
		"constraint_2",
		"constraint_3",
		"constraint_4",
	]);
});

const kept = (i: number, chars: number, extra: Partial<Kept> = {}): Kept => ({
	i,
	text: "z".repeat(chars),
	kind: "full",
	keep: 1,
	full: 1,
	...extra,
});

test("fitKept does nothing under the cap", () => {
	const input = [kept(0, 100), kept(1, 100)];
	assert.deepEqual(fitKept(input, blocks(2), 1000), input);
});

test("fitKept downgrades the least confident whole keep before dropping anything", () => {
	const source = blocks(2, () => block("user", `${"w".repeat(500)}\n\n${"v".repeat(500)}`));
	const input = [kept(0, 800, { full: 0.9 }), kept(1, 800, { full: 0.2 })];
	const out = fitKept(input, source, 1300);
	assert.equal(out.length, 2, "one downgrade is enough, so nothing is dropped");
	assert.equal(out[0].kind, "full", "the confident keep is left alone");
	assert.equal(out[1].kind, "truncated");
	assert.equal(out[1].escalated, true);
	assert.equal(out[1].text, truncateBlock(source[1].text), "the downgrade re-cuts the original block");
});

test("fitKept drops the weakest keep first and the oldest on a tie", () => {
	const input = [kept(0, 500, { keep: 0.6 }), kept(1, 500, { keep: 0.6 }), kept(2, 500, { keep: 0.9 })];
	const out = fitKept(input, blocks(3, () => block("user", "q".repeat(900))), 600);
	assert.deepEqual(
		out.map((k) => k.i),
		[2],
	);
});

test("fitKept never touches the pinned tail", () => {
	const input = [kept(0, 500, { keep: 0.9 }), kept(1, 900, { pinned: true, keep: undefined, full: undefined })];
	const out = fitKept(input, blocks(2, () => block("user", "q".repeat(900))), 600);
	assert.deepEqual(
		out.map((k) => k.i),
		[1],
		"the live context survives even when it is the bigger block",
	);
});

test("selectBlocks pins the newest tail and judges the rest", async () => {
	const { kept: out, stats } = await selectBlocks(blocks(10), {
		ask: answerWith({ 0: { constraint: 0.9 }, 1: { decision: 0.8 } }),
	});
	assert.equal(stats.judged, 10 - PIN_TAIL);
	assert.equal(stats.pinned, PIN_TAIL);
	const pinned = out.filter((k) => k.pinned);
	assert.deepEqual(
		pinned.map((k) => k.i),
		[6, 7, 8, 9],
	);
	assert.ok(
		out.some((k) => k.i === 0 && k.kind === "full"),
		"a constraint is kept whole",
	);
	assert.ok(
		out.some((k) => k.i === 1 && k.kind === "truncated"),
		"a decision with no verbatim reason is kept as a head",
	);
	assert.ok(
		!out.some((k) => k.i === 2),
		"a block every check scored zero is dropped",
	);
});

test("selectBlocks keeps an unscored block whole rather than guessing", async () => {
	const failing: AskFn = async () => {
		throw new JevError("every chunk failed");
	};
	await assert.rejects(() => selectBlocks(blocks(10), { ask: failing }), JevError);

	const partial: AskFn = async (_state, questions) => {
		const answers: Answers = {};
		for (const key of Object.keys(questions)) if (key.endsWith("_0")) answers[key] = { noul: 0 };
		return answers;
	};
	const { kept: out } = await selectBlocks(blocks(10), { ask: partial });
	assert.ok(
		out.some((k) => k.i === 1 && k.kind === "full"),
		"a block whose chunk never answered stays whole",
	);
});

test("selectBlocks pulls a dropped tool call back in behind its kept result", async () => {
	const input = [
		block("assistant", '[tool_use read] {"path":"src/a.ts"}'),
		block("tool", "[tool_result] export const a = 1"),
		block("assistant", "chatter only"),
		block("user", "now make b"),
		...blocks(4, (i) => block("user", `pinned tail ${i}`)),
	];
	const { kept: out } = await selectBlocks(input, {
		ask: answerWith({ 1: { error: 0.9 }, 3: { open: 0.9 } }),
	});
	const indices = out.map((k) => k.i);
	assert.ok(indices.includes(0), "the tool call comes back with its result");
	assert.ok(indices.includes(1));
	assert.ok(indices.indexOf(0) < indices.indexOf(1), "and stays in front of it");
	assert.ok(!indices.includes(2), "chatter the checks all scored zero is dropped");
	assert.equal(out.find((k) => k.i === 3)?.kind, "truncated", "an open thread with nothing verbatim keeps a head");
});

test("selectBlocks pulls in the block a kept result answers, by link", async () => {
	const input: Block[] = [
		block("assistant", 'let me look first\n[tool_use read] {"path":"src/a.ts"}'),
		{ ...block("tool", "[tool_result] export const a = 1"), needs: 0 },
		block("assistant", "chatter only"),
		block("user", "now make b"),
		...blocks(4, (i) => block("user", `pinned tail ${i}`)),
	];
	const { kept: out } = await selectBlocks(input, {
		ask: answerWith({ 1: { error: 0.9 }, 3: { open: 0.9 } }),
	});
	const indices = out.map((k) => k.i);
	assert.ok(
		indices.includes(0),
		"the call comes back even though its block starts with prose, not the marker",
	);
	assert.ok(indices.indexOf(0) < indices.indexOf(1), "and stays in front of the result");
	assert.ok(!indices.includes(2), "chatter every check scored zero is dropped");
});

test("selectBlocks cuts a block that only just misses the verbatim bar", async () => {
	const long = "reason ".repeat(200);
	const { kept: out } = await selectBlocks([block("assistant", long), ...blocks(PIN_TAIL)], {
		ask: answerWith({ 0: { decision: 0.9, rerunnable: 0.9 } }),
	});
	assert.equal(out[0].kind, "truncated");
	assert.equal(out[0].text, truncateBlock(long));
});

test("selectBlocks rescues an early constraint the window would otherwise drop", async () => {
	const total = MAX_BLOCKS + 20;
	const early = block("user", "never touch the generated fixtures");
	const input = [early, ...blocks(total - 1, (i) => block("assistant", `step ${i + 1}`))];
	const asked: string[] = [];
	const ask: AskFn = async (_state, questions) => {
		asked.push(...Object.keys(questions));
		const answers: Answers = {};
		for (const key of Object.keys(questions)) answers[key] = { noul: key === "constraint_0" ? 0.95 : 0 };
		return answers;
	};
	const { kept: out, stats } = await selectBlocks(input, { ask });
	assert.ok(asked.includes("constraint_0"), "the rescue pass asked about the oldest block");
	assert.equal(stats.rescued, 1);
	assert.equal(out[0].i, 0);
	assert.equal(out[0].rescued, true);
});

test("selectBlocks only asks the constraint check inside the rescue window", async () => {
	const total = MAX_BLOCKS + RESCUE_BLOCKS + 20;
	const seen = new Map<number, Set<string>>();
	const ask: AskFn = async (_state, questions) => {
		const answers: Answers = {};
		for (const key of Object.keys(questions)) {
			const [name, index] = key.split("_");
			const names = seen.get(Number(index)) ?? new Set();
			names.add(name);
			seen.set(Number(index), names);
			answers[key] = { noul: 0 };
		}
		return answers;
	};
	await selectBlocks(blocks(total), { ask });
	const windowStart = total - MAX_BLOCKS;
	const rescueLo = windowStart - RESCUE_BLOCKS;
	assert.equal(seen.get(rescueLo - 1), undefined, "anything older than both windows is not asked at all");
	assert.deepEqual([...seen.get(rescueLo)!], ["constraint"], "the rescue window gets one check");
	assert.deepEqual([...seen.get(windowStart - 1)!], ["constraint"], "right up to the judged window");
	assert.equal(seen.get(windowStart)!.size, ASK_CHECKS.length, "and the judged window gets all five");
	assert.equal(seen.get(total - PIN_TAIL - 1)!.size, ASK_CHECKS.length, "so does the newest judged block");
	assert.equal(seen.get(total - 1), undefined, "the pinned tail is never asked");
	assert.equal(seen.size, MAX_BLOCKS + RESCUE_BLOCKS - PIN_TAIL, "the pin comes off the judged window, not the rescue");
});

test("selectBlocks answers an empty selection for an empty transcript", async () => {
	const { kept: out, stats } = await selectBlocks([], { ask: answerWith({}) });
	assert.deepEqual(out, []);
	assert.equal(stats.judged, 0);
});

test("selectBlocks caps a kept block at KEEP_CHARS", async () => {
	const long = "s".repeat(KEEP_CHARS * 3);
	const { kept: out } = await selectBlocks([block("user", long), ...blocks(PIN_TAIL)], {
		ask: answerWith({ 0: { constraint: 0.9 } }),
	});
	assert.equal(out[0].text, cutMarked(long, KEEP_CHARS));
	assert.ok(out[0].text.includes("chars elided"));
});
