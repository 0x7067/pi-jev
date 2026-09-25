import type { Block, Kept } from "./select.ts";

export const DIGEST_HEADER =
	"This is not a written summary. Jev selected the blocks below out of the " +
	"session transcript, and each one is verbatim text — kept whole, or cut to a " +
	"head that ends with an elision note. Everything else was dropped. Blocks are " +
	"oldest first, each introduced by a ---[jev:<n>:<role>]--- line. Continue the " +
	"last task without asking the user to repeat anything.";

const DELIMITER = /^---\[jev:(\d+):([a-z_]+)\]---$/;

export function delimiter(i: number, role: string): string {
	return `---[jev:${i}:${role}]---`;
}

export function renderDigest(blocks: readonly Block[], kept: readonly Kept[]): string {
	const parts = [DIGEST_HEADER];
	for (const k of kept) parts.push(`${delimiter(k.i, blocks[k.i].role)}\n${k.text}`);
	return parts.join("\n\n");
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

export function splitSummary(summary: string): Block[] {
	const fromJev = splitJevDigest(summary);
	if (fromJev.length > 0) return fromJev;
	const sections = summary
		.split(/\n(?=## )/)
		.map((section) => section.trim())
		.filter((section) => section !== "");
	if (sections.length > 1) return sections.map((section) => ({ role: "summary", text: section }));
	const text = summary.trim();
	return text === "" ? [] : [{ role: "summary", text }];
}
