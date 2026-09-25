import { JevError, type Answers, type Question } from "../jev/client.ts";

export const KEEP_THRESHOLD = 0.5;
export const MAX_BLOCKS = 150;
export const RESCUE_BLOCKS = 150;
export const ASK_TIMEOUT_MS = 4_000;

export const PIN_TAIL = 4;
export const BLOCKS_PER_CHUNK = 10;
export const DIRECTIVE_CHARS = 500;
export const HEADER_CHARS = 1_500;
export const MAX_WORKERS = 16;
export const BLOCK_CHARS = 1_200;
export const KEEP_CHARS = 1_500;
export const HEAD_CHARS = 400;
export const HEAD_SLACK = 200;
export const TARGET_CHARS = 16_000;
export const REF_CHARS = 160;

export const BLOCK_BUDGET = MAX_BLOCKS + RESCUE_BLOCKS;

export interface Block {
	role: string;
	text: string;
	needs?: number;
}

const META_PREFIXES = [
	"<command-",
	"<local-command",
	"<system-reminder",
	"<caveat",
	"<bash-",
	"<task-notification",
];

const ACK = /^(ok|yes|no|thanks|continue)\.?$/i;

export function judgeable(role: string, text: string): string | undefined {
	if (text === "" || META_PREFIXES.some((prefix) => text.startsWith(prefix))) return undefined;
	if (role === "user" && ACK.test(text)) return undefined;
	return text;
}

export function elision(chars: number): string {
	return `[… ${chars} chars elided by jev-compact — re-read the file or re-run the command if needed]`;
}

function lastIndexOfInRange(text: string, needle: string, start: number, end: number): number {
	const at = text.slice(start, end).lastIndexOf(needle);
	return at === -1 ? -1 : start + at;
}

export function cutMarked(text: string, chars: number): string {
	if (text.length <= chars) return text;
	const cut = lastIndexOfInRange(text, "\n\n", Math.floor(chars / 2), chars);
	const head = cut > 0 ? text.slice(0, cut) : text.slice(0, chars);
	return `${head}\n${elision(text.length - head.length)}`;
}

export function truncateBlock(text: string): string {
	return text.length <= HEAD_CHARS + HEAD_SLACK ? text : cutMarked(text, HEAD_CHARS);
}

export function sessionContext(
	blocks: readonly Block[],
	cwd: string | undefined,
	directive: string | undefined,
): string {
	const lines: string[] = [];
	if (cwd) lines.push(`Working directory: ${cwd}`);
	if (directive) {
		lines.push(`The user asked this compaction to: ${directive}`);
		lines.push("A block that request covers counts as yes on every check below.");
	}
	const goal = blocks
		.filter((block) => block.role === "user")
		.map((block) => block.text.slice(0, 300))
		.join("\n")
		.slice(-HEADER_CHARS);
	if (goal.trim() !== "") lines.push(`Most recent user requests:\n${goal}`);
	return lines.join("\n");
}

export function compactState(blocks: readonly Block[], lo: number, hi: number, context: string): string {
	const header = [
		"Transcript of an AI coding-assistant session being compacted.",
		`Blocks are numbered by position in the session, oldest first. This request shows blocks [${lo}]..[${hi - 1}].`,
	];
	if (context !== "") header.push(context);
	const body: string[] = [];
	for (let i = lo; i < hi; i++) body.push(`[${i}] [${blocks[i].role}] ${blocks[i].text.slice(0, BLOCK_CHARS)}`);
	return `${header.join("\n")}\n\n${body.join("\n\n")}`;
}

export const CHECKS = {
	constraint:
		"Does block [{i}] state a requirement, restriction, or preference " +
		"from the user about how the work must be done: something not " +
		"to touch, a tool or approach to use, a deadline, a scope limit?",
	decision:
		"Does block [{i}] record a decision about the work together with " +
		"its reason: an approach chosen, an alternative rejected, a root " +
		"cause identified?",
	error:
		"Does block [{i}] contain an exact error message, failing test " +
		"output, or unexpected result that the agent would have to " +
		"reproduce to see again?",
	open:
		"Does block [{i}] name work still to be done: a next step, a pending " +
		"task, or a question waiting for the user's answer?",
	rerunnable:
		"Does block [{i}] hold output that would come back the same " +
		"on a rerun: a listing, a passing check's log, build or install " +
		"output, or warnings a rebuild would print again?",
} as const;

export type CheckName = keyof typeof CHECKS;

export const KEEP_CHECKS: readonly CheckName[] = ["constraint", "decision", "error", "open"];
export const ASK_CHECKS: readonly CheckName[] = Object.keys(CHECKS) as CheckName[];

export function keepQuestions(n: number, names: readonly CheckName[] = ASK_CHECKS): Record<string, Question> {
	const questions: Record<string, Question> = {};
	for (let i = 0; i < n; i++) {
		for (const name of names) {
			questions[`${name}_${i}`] = { type: "noul", instructions: CHECKS[name].replaceAll("{i}", String(i)) };
		}
	}
	return questions;
}

export interface Verdict {
	keep: number | null;
	full: number | null;
	checks: Partial<Record<CheckName, number>>;
}

export function verdicts(answers: Answers, i: number): Verdict {
	const checks: Partial<Record<CheckName, number>> = {};
	for (const name of ASK_CHECKS) {
		const score = answers[`${name}_${i}`]?.noul;
		if (typeof score === "number") checks[name] = score;
	}
	if (Object.keys(checks).length === 0) return { keep: null, full: null, checks };
	const keep = Math.max(...KEEP_CHECKS.map((name) => checks[name] ?? 0));
	const rerunnable = checks.rerunnable ?? 0;
	const error = rerunnable >= KEEP_THRESHOLD ? 0 : (checks.error ?? 0);
	return { keep, full: Math.max(checks.constraint ?? 0, error), checks };
}

export type AskFn = (state: string, questions: Record<string, Question>, timeoutMs: number) => Promise<Answers>;

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			out[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return out;
}

export async function askChunked(
	blocks: readonly Block[],
	cwd: string | undefined,
	lo: number,
	hi: number,
	ask: AskFn,
	directive?: string,
	names: readonly CheckName[] = ASK_CHECKS,
): Promise<Answers> {
	const ranges: [number, number][] = [];
	for (let i = lo; i < hi; i += BLOCKS_PER_CHUNK) ranges.push([i, Math.min(i + BLOCKS_PER_CHUNK, hi)]);
	if (ranges.length === 0) return {};

	const questions = keepQuestions(hi, names);
	const context = sessionContext(blocks, cwd, directive);
	const one = async ([start, end]: [number, number]): Promise<Answers> => {
		const subset: Record<string, Question> = {};
		for (let i = start; i < end; i++) {
			for (const name of names) subset[`${name}_${i}`] = questions[`${name}_${i}`];
		}
		try {
			return await ask(compactState(blocks, start, end, context), subset, ASK_TIMEOUT_MS);
		} catch (error) {
			if (error instanceof JevError) return {};
			throw error;
		}
	};

	const parts = ranges.length === 1 ? [await one(ranges[0])] : await mapPool(ranges, MAX_WORKERS, one);
	const answers: Answers = {};
	for (const part of parts) Object.assign(answers, part);
	if (Object.keys(answers).length === 0) throw new JevError("every chunk failed");
	return answers;
}

export type KeptKind = "full" | "truncated" | "dropped";

export interface Kept {
	i: number;
	text: string;
	kind: KeptKind;
	keep?: number;
	full?: number;
	pinned?: boolean;
	rescued?: boolean;
	escalated?: boolean;
}

export function fitKept(kept: Kept[], blocks: readonly Block[], targetChars = TARGET_CHARS): Kept[] {
	let total = kept.reduce((sum, k) => sum + k.text.length, 0);
	if (total <= targetChars) return kept;
	const movable = kept.filter((k) => !k.pinned);
	const whole = movable
		.filter((k) => k.kind === "full")
		.sort((a, b) => (a.full ?? 0) - (b.full ?? 0));
	for (const k of whole) {
		if (total <= targetChars) break;
		const shorter = truncateBlock(blocks[k.i].text);
		if (shorter.length >= k.text.length) continue;
		total -= k.text.length - shorter.length;
		k.text = shorter;
		k.kind = "truncated";
		k.escalated = true;
	}
	movable.sort((a, b) => (a.keep ?? 0) - (b.keep ?? 0) || a.i - b.i);
	for (const k of movable) {
		if (total <= targetChars) break;
		total -= k.text.length;
		k.kind = "dropped";
	}
	return kept.filter((k) => k.kind !== "dropped");
}

function adjacentCall(blocks: readonly Block[], i: number): number | undefined {
	if (i < 1 || !blocks[i].text.startsWith("[tool_result]")) return undefined;
	return blocks[i - 1].text.startsWith("[tool_use") ? i - 1 : undefined;
}

export function blockKind(text: string): string {
	if (text.startsWith("[tool_use")) {
		const end = text.indexOf("]");
		const name = end > 0 ? text.slice("[tool_use".length, end).trim() : "";
		return `tool_use:${name || "?"}`;
	}
	return text.startsWith("[tool_result]") ? "tool_result" : "text";
}

export interface BlockRow {
	checks: Partial<Record<CheckName, number>>;
	i: number;
	role: string;
	kind: string;
	chars: number;
	keep: number | null;
	full: number | null;
	verdict: string;
	ref: string;
}

export function blockRows(blocks: readonly Block[], kept: readonly Kept[], answers: Answers): BlockRow[] {
	const final = new Map(kept.map((k) => [k.i, k]));
	return blocks.map((block, i) => {
		const k = final.get(i);
		const verdict = k === undefined ? "dropped" : k.pinned ? "pinned" : k.kind;
		const { keep, full, checks } = verdicts(answers, i);
		return {
			checks,
			i,
			role: block.role,
			kind: blockKind(block.text),
			chars: block.text.length,
			keep,
			full,
			verdict,
			ref: block.text.split(/\s+/).join(" ").slice(0, REF_CHARS),
		};
	});
}

export interface Stats {
	judged: number;
	rescued?: number;
	pinned?: number;
	kept?: number;
	keptBeforeFit?: number;
	truncated?: number;
	escalated?: number;
	pinnedChars?: number;
	charsBefore?: number;
	charsBeforeFit?: number;
	charsAfter?: number;
	estTokensAfter?: number;
	reduction?: number;
	ms?: number;
	rows?: BlockRow[];
}

export interface SelectOptions {
	ask: AskFn;
	cwd?: string;
	directive?: string;
	targetChars?: number;
	pinTail?: number;
}

export interface Selection {
	kept: Kept[];
	stats: Stats;
}

export async function selectBlocks(blocks: readonly Block[], options: SelectOptions): Promise<Selection> {
	if (blocks.length === 0) return { kept: [], stats: { judged: 0 } };
	const { ask, cwd, directive } = options;
	const pinTail = options.pinTail ?? PIN_TAIL;
	const windowStart = Math.max(0, blocks.length - MAX_BLOCKS);
	const rescueLo = Math.max(0, windowStart - RESCUE_BLOCKS);
	const judged = Math.max(0, blocks.length - pinTail);

	const started = performance.now();
	const answers: Answers =
		judged > windowStart ? await askChunked(blocks, cwd, windowStart, judged, ask, directive) : {};
	let rescueAnswers: Answers = {};
	if (windowStart > rescueLo) {
		try {
			rescueAnswers = await askChunked(blocks, cwd, rescueLo, windowStart, ask, directive, ["constraint"]);
		} catch (error) {
			if (!(error instanceof JevError)) throw error;
		}
	}
	Object.assign(answers, rescueAnswers);
	const ms = Math.round(performance.now() - started);

	const rescued: Kept[] = [];
	for (let i = rescueLo; i < windowStart; i++) {
		const score = rescueAnswers[`constraint_${i}`]?.noul;
		if (typeof score === "number" && score >= KEEP_THRESHOLD) {
			rescued.push({
				i,
				text: cutMarked(blocks[i].text, KEEP_CHARS),
				kind: "full",
				keep: score,
				full: score,
				rescued: true,
			});
		}
	}

	const kept: Kept[] = [];
	for (let i = windowStart; i < blocks.length; i++) {
		const block = blocks[i];
		if (i >= judged) {
			kept.push({ i, text: cutMarked(block.text, KEEP_CHARS), kind: "full", pinned: true });
			continue;
		}
		const { keep, full } = verdicts(answers, i);
		if (keep !== null && keep < KEEP_THRESHOLD) continue;
		const truncated = keep !== null && full !== null && full < KEEP_THRESHOLD;
		kept.push({
			i,
			text: truncated ? truncateBlock(block.text) : cutMarked(block.text, KEEP_CHARS),
			kind: truncated ? "truncated" : "full",
			keep: keep ?? 1,
			full: full ?? 1,
		});
	}

	const keptIndex = new Set(kept.map((k) => k.i));
	const paired: Kept[] = [];
	for (const k of kept) {
		const needs = blocks[k.i].needs ?? adjacentCall(blocks, k.i);
		if (needs !== undefined && !keptIndex.has(needs)) {
			paired.push({
				i: needs,
				text: cutMarked(blocks[needs].text, KEEP_CHARS),
				kind: "full",
				keep: k.keep ?? 1,
				full: k.full ?? 1,
			});
			keptIndex.add(needs);
		}
		paired.push(k);
	}

	const preFit = [...rescued, ...paired];
	const charsBeforeFit = preFit.reduce((sum, k) => sum + k.text.length, 0);
	const final = fitKept(preFit, blocks, options.targetChars);
	const charsBefore = blocks.reduce((sum, block) => sum + block.text.length, 0);
	const charsAfter = final.reduce((sum, k) => sum + k.text.length, 0);
	return {
		kept: final,
		stats: {
			judged: judged - windowStart,
			rescued: rescued.length,
			pinned: blocks.length - judged,
			kept: final.length,
			keptBeforeFit: preFit.length,
			truncated: final.filter((k) => k.kind === "truncated").length,
			escalated: final.filter((k) => k.escalated).length,
			pinnedChars: final.filter((k) => k.pinned).reduce((sum, k) => sum + k.text.length, 0),
			charsBefore,
			charsBeforeFit,
			charsAfter,
			estTokensAfter: Math.floor(charsAfter / 4),
			reduction: Math.round((1 - charsAfter / Math.max(charsBefore, 1)) * 1000) / 1000,
			ms,
			rows: blockRows(blocks, final, answers),
		},
	};
}
