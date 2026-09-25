import { isAbsolute, resolve } from "node:path";
import type { Block, Kept } from "../compaction/select.ts";

export const DIGEST_HEADER =
	"This is not a written summary. Jev selected the blocks below out of the " +
	"session transcript, and each one is verbatim text — kept whole, or cut to a " +
	"head that ends with an elision note. Everything else was dropped. Blocks are " +
	"oldest first, each introduced by a ---[jev:<n>:<role>]--- line. Continue the " +
	"last task without asking the user to repeat anything.";

export const MAX_POINTER_LINES = 40;
export const POINTER_CHARS = 2_000;

const DELIMITER = /^---\[jev:(\d+):([a-z_]+)\]---$/;
const READ_FILES = /\n?<read-files>\n[\s\S]*?\n<\/read-files>\n?/g;

export function delimiter(i: number, role: string): string {
	return `---[jev:${i}:${role}]---`;
}

export function renderDigest(blocks: readonly Block[], kept: readonly Kept[], pointers = ""): string {
	const parts = [DIGEST_HEADER];
	for (const k of kept) parts.push(`${delimiter(k.i, blocks[k.i].role)}\n${k.text}`);
	return parts.join("\n\n") + pointers;
}

/** Where each dropped or truncated call got its bytes, so the route back
 * survives even though the bytes did not. Paths, not results: a path is short
 * and never goes stale, while the bytes behind it may have changed.
 *
 * Truncated blocks count as missing. A 400-char head of `[tool_use edit]
 * {"edits":[…]}` cuts the `path` field away, which is the one part needed to
 * re-read the file, so `Block.refs` carries it from the untruncated arguments.
 * Bounded by line count and by chars, because it is appended after `fitKept`
 * has already spent the block budget. */
export function pointerIndex(
	blocks: readonly Block[],
	kept: readonly Kept[],
	cwd: string,
	maxLines = MAX_POINTER_LINES,
	budget = POINTER_CHARS,
): string {
	if (maxLines <= 0 || budget <= 0) return "";
	const state = new Map(kept.map((k) => [k.i, k.kind]));
	const lines: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < blocks.length && lines.length < maxLines; i++) {
		const kind = state.get(i);
		if (kind !== undefined && kind !== "truncated") continue;
		for (const ref of blocks[i].refs ?? []) {
			const path = isAbsolute(ref) ? resolve(ref) : resolve(cwd, ref);
			if (seen.has(path)) continue;
			seen.add(path);
			lines.push(path);
			if (lines.join("\n").length > budget) {
				lines.pop();
				break;
			}
		}
	}
	if (lines.length === 0) return "";
	return `\n\n<read-files>\n${lines.join("\n")}\n</read-files>`;
}

function splitJevDigest(summary: string): Block[] {
	const blocks: Block[] = [];
	for (const line of summary.split("\n")) {
		const match = DELIMITER.exec(line);
		if (match) blocks.push({ role: match[2], text: "" });
		else if (blocks.length > 0) blocks[blocks.length - 1].text += `${line}\n`;
	}
	return blocks
		.map((block) => ({ role: block.role, text: block.text.replace(/\n+$/, "") }))
		.filter((block) => block.text.trim() !== "");
}

/** Blocks of an earlier summary, so its content competes in the next selection
 * instead of being cut to one head.
 *
 * A jev digest splits on its own delimiters and keeps each block's original
 * role. pi's own structured summary splits on its `## ` sections. Anything else
 * is one block. Non-jev blocks get the role `summary`, not `user`, so a summary
 * pi already wrote cannot crowd real requests out of the goal header.
 *
 * The pointer index is stripped: it is derived from the selection that produced
 * it, and the next compaction rebuilds its own. Re-judging it as content would
 * spend questions on paths and keep them twice. */
export function splitSummary(summary: string): Block[] {
	const body = summary.replace(READ_FILES, "\n");
	const fromJev = splitJevDigest(body);
	if (fromJev.length > 0) return fromJev;
	const sections = body
		.split(/\n(?=## )/)
		.map((section) => section.trim())
		.filter((section) => section !== "");
	if (sections.length > 1) return sections.map((section) => ({ role: "summary", text: section }));
	const text = body.trim();
	return text === "" ? [] : [{ role: "summary", text }];
}
