import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCK_BUDGET } from "../src/compaction/select.ts";
import { blockFrom, blocksFrom, type LlmMessage } from "../src/pi/blocks.ts";

const user = (text: string): LlmMessage =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as unknown as LlmMessage;

const assistant = (content: unknown[]): LlmMessage =>
	({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 0,
	}) as unknown as LlmMessage;

const toolResult = (text: string, toolCallId = "c1"): LlmMessage =>
	({
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	}) as unknown as LlmMessage;

const bashExecution = (command: string, output: string): unknown => ({
	role: "bashExecution",
	command,
	output,
	exitCode: 0,
	cancelled: false,
	timestamp: 0,
});

test("blockFrom carries pi's text through with its role", () => {
	assert.deepEqual(blockFrom(user("keep the fixtures generated")), {
		role: "user",
		text: "keep the fixtures generated",
	});
});

test("blockFrom writes the tool markers the checks are keyed on", () => {
	const block = blockFrom(
		assistant([
			{ type: "thinking", thinking: "let me look at the file first" },
			{ type: "text", text: "reading it now" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
		]),
	);
	assert.deepEqual(block, {
		role: "assistant",
		text: 'reading it now\n[tool_use read] {"path":"src/a.ts"}',
		refs: ["src/a.ts"],
	});
	assert.ok(
		!block!.text.includes("let me look"),
		"thinking is skipped, as the Claude transcript path skips it",
	);
});

test("blockFrom gives a tool result the role tool, not user", () => {
	assert.deepEqual(blockFrom(toolResult("export const a = 1")), {
		role: "tool",
		text: "[tool_result] export const a = 1",
	});
});

test("blockFrom keeps a command the user ran out of the user role", () => {
	const ran = bashExecution("npm test", "2 failing");
	assert.equal(blockFrom(user("run the tests"))?.role, "user");
	const out = blocksFrom([ran] as never);
	assert.equal(out.length, 1);
	assert.equal(out[0].role, "bash");
	assert.ok(out[0].text.startsWith("Ran `npm test`"));
});

test("blocksFrom keeps a summary pi wrote out of the user role too", () => {
	const out = blocksFrom([
		{ role: "branchSummary", summary: "## Goal\nShip it", timestamp: 0 },
		user("and now push it"),
	] as never);
	assert.deepEqual(
		out.map((block) => block.role),
		["summary", "user"],
		"pi folds a branch summary into a user message; the role is read before that",
	);
	const folded = blocksFrom([user("and now push it")] as never, "## Goal\nShip it");
	assert.equal(folded[0].role, "summary", "handed over separately, it keeps the summary role");
});

test("blocksFrom links a tool result to its call by id, not by adjacency", () => {
	const out = blocksFrom([
		assistant([
			{ type: "text", text: "let me look at the file first" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
		]),
		toolResult("export const a = 1"),
	] as never);
	assert.equal(out.length, 2);
	assert.ok(
		out[0].text.startsWith("let me look"),
		"the call block does not start with the marker, so text adjacency would miss it",
	);
	assert.equal(out[1].needs, 0);
	assert.equal(out[0].needs, undefined);
});

test("blocksFrom leaves an unpaired result unlinked", () => {
	const out = blocksFrom([toolResult("orphan output")] as never);
	assert.equal(out[0].needs, undefined);
});

test("blockFrom truncates tool arguments and results where the port says to", () => {
	const call = blockFrom(assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "x".repeat(900) } }]));
	assert.equal(call!.text.length, "[tool_use bash] ".length + 400);

	const result = blockFrom(toolResult("y".repeat(2000)));
	assert.equal(result!.text, `[tool_result] ${"y".repeat(800)}`);
});

test("blockFrom drops what carries nothing worth a question", () => {
	assert.equal(blockFrom(user("ok")), undefined);
	assert.equal(blockFrom(user("")), undefined);
	assert.equal(blockFrom(user("<system-reminder>be careful</system-reminder>")), undefined);
	assert.equal(blockFrom(assistant([{ type: "thinking", thinking: "hmm" }])), undefined);
	assert.equal(blockFrom({ role: "system", content: "prompt" } as unknown as LlmMessage), undefined);
});

test("blocksFrom flattens a span into blocks in order", () => {
	const out = blocksFrom([
		user("add a replay harness"),
		assistant([{ type: "text", text: "on it" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }]),
		toolResult("contents"),
	] as never);
	assert.deepEqual(
		out.map((block) => block.role),
		["user", "assistant", "tool"],
	);
	assert.equal(out[2].text, "[tool_result] contents");
});

test("blocksFrom splits a previous summary back into competing blocks", () => {
	const out = blocksFrom([user("and now push it")] as never, "## Goal\nShip the port\n\n## Next Steps\n1. push");
	assert.deepEqual(
		out.map((block) => block.role),
		["summary", "summary", "user"],
	);
	assert.equal(out[2].text, "and now push it");
});

test("blocksFrom keeps the previous summary inside the block budget", () => {
	const prior = Array.from({ length: 40 }, (_, i) => `---[jev:${i}:user]---\nrequirement ${i}`).join("\n\n");
	const messages = Array.from({ length: BLOCK_BUDGET + 100 }, (_, i) => user(`message ${i}`));
	const out = blocksFrom(messages as never, prior);
	assert.equal(out.length, BLOCK_BUDGET);
	assert.equal(out[0].text, "requirement 0", "the oldest record of discarded work is not pushed off the front");
	assert.equal(out[out.length - 1].text, `message ${BLOCK_BUDGET + 99}`, "and the newest message is still there");
});
