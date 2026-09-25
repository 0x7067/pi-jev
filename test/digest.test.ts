import assert from "node:assert/strict";
import { test } from "node:test";
import { DIGEST_HEADER, delimiter, renderDigest, splitSummary } from "../src/pi/digest.ts";
import type { Block, Kept } from "../src/compaction/select.ts";

const blocks: Block[] = [
	{ role: "user", text: "keep the fixtures generated" },
	{ role: "assistant", text: '[tool_use read] {"path":"src/a.ts"}' },
	{ role: "tool", text: "[tool_result] export const a = 1" },
	{ role: "assistant", text: "a longer reply\n\nwith two paragraphs" },
];

const kept: Kept[] = [
	{ i: 0, text: blocks[0].text, kind: "full", keep: 0.9, full: 0.9 },
	{ i: 1, text: blocks[1].text, kind: "full", keep: 0.7, full: 0.2 },
	{ i: 3, text: "a longer reply\n[… 24 chars elided by jev-compact — re-read the file or re-run the command if needed]", kind: "truncated", keep: 0.8, full: 0.3 },
];

test("renderDigest states what the bytes are, then the kept blocks oldest first", () => {
	const digest = renderDigest(blocks, kept);
	assert.ok(digest.startsWith(DIGEST_HEADER));
	assert.ok(DIGEST_HEADER.includes("not a written summary"));
	const rendered = digest.split("\n\n").slice(1);
	assert.deepEqual(rendered, [
		`${delimiter(0, "user")}\n${blocks[0].text}`,
		`${delimiter(1, "assistant")}\n${blocks[1].text}`,
		`${delimiter(3, "assistant")}\n${kept[2].text}`,
	]);
});

test("splitSummary round-trips a jev digest, dropping its header", () => {
	const digest = renderDigest(blocks, kept);
	const back = splitSummary(digest);
	assert.deepEqual(back, [
		{ role: "user", text: blocks[0].text },
		{ role: "assistant", text: blocks[1].text },
		{ role: "assistant", text: kept[2].text },
	]);
	assert.ok(
		!back.some((block) => block.text.includes("not a written summary")),
		"the header is not content and must not accumulate across compactions",
	);
});

test("splitSummary keeps a multi-paragraph block in one piece", () => {
	const digest = renderDigest(blocks, [{ i: 3, text: blocks[3].text, kind: "full" }]);
	assert.deepEqual(splitSummary(digest), [{ role: "assistant", text: blocks[3].text }]);
});

const PI_SUMMARY = `## Goal
Ship the port

## Constraints & Preferences
- no generated prose

## Next Steps
1. push it`;

test("splitSummary splits pi's own structured summary on its sections", () => {
	const back = splitSummary(PI_SUMMARY);
	assert.equal(back.length, 3);
	assert.deepEqual(
		back.map((block) => block.role),
		["summary", "summary", "summary"],
		"a summary is not a user request and must not crowd the goal header",
	);
	assert.equal(back[1].text, "## Constraints & Preferences\n- no generated prose");
});

test("splitSummary falls back to one block, and to none", () => {
	assert.deepEqual(splitSummary("just a sentence"), [{ role: "summary", text: "just a sentence" }]);
	assert.deepEqual(splitSummary("   \n "), []);
});

test("splitSummary survives a digest that was itself re-digested", () => {
	const first = renderDigest(blocks, kept);
	const second = renderDigest(splitSummary(first), [
		{ i: 0, text: blocks[0].text, kind: "full" },
		{ i: 1, text: blocks[1].text, kind: "full" },
	]);
	assert.deepEqual(splitSummary(second), [
		{ role: "user", text: blocks[0].text },
		{ role: "assistant", text: blocks[1].text },
	]);
});
