import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SessionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderDigest } from "../src/pi/digest.ts";
import { blocksFrom } from "../src/pi/blocks.ts";
import { locations, locationTerms, type LocationKind } from "../src/pi/refs.ts";
import { selectBlocks, TARGET_CHARS, type AskFn } from "../src/compaction/select.ts";
import { ask as liveAsk, resolve as resolveKey } from "../src/jev/client.ts";
import { callLogPath, dotEnvPath, sessionsDir } from "../src/pi/paths.ts";

type AgentMessage = SessionContext["messages"][number];

const FLOOR_REFETCH_FULL = 0.7;
const REFETCH_KINDS = new Set(["file", "url", "pattern"]);
const ELISION_MARK = "elided by jev-compact";

interface Call {
	key: string;
}

interface Options {
	limit: number;
	pinTail?: number;
	pointerLines: number;
	paths: string[];
}

function parseOptions(argv: readonly string[]): Options {
	const options: Options = { limit: 0, pointerLines: 0, paths: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--limit") options.limit = Number(argv[++i]);
		else if (arg === "--pin-tail") options.pinTail = Number(argv[++i]);
		else if (arg === "--pointer-lines") options.pointerLines = Number(argv[++i]);
		else if (arg !== undefined && !arg.startsWith("--")) options.paths.push(arg);
	}
	return options;
}

/** The experiment from claude-jev's compaction-design.md item 2: a bounded index
 * of where each dropped or truncated call got its bytes, appended to the digest.
 * Paths, not results, so it stays cheap and never goes stale. Truncated blocks
 * count as missing, because a 400-char head of an `edit` call cuts the `path`
 * field away. The paths come from `Block.refs`, lifted from the full arguments
 * before truncation. */
function pointerIndex(
	blocks: readonly { refs?: string[] }[],
	kept: readonly { i: number; kind: string }[],
	cwd: string,
	maxLines: number,
): string {
	if (maxLines <= 0) return "";
	const state = new Map(kept.map((k) => [k.i, k.kind]));
	const paths: string[] = [];
	const seen = new Set<string>();
	blocks.forEach((block, i) => {
		const kind = state.get(i);
		if (kind !== undefined && kind !== "truncated") return;
		for (const ref of block.refs ?? []) {
			const path = absolute(ref, cwd);
			if (seen.has(path)) continue;
			seen.add(path);
			paths.push(path);
		}
	});
	if (paths.length === 0) return "";
	return `\n<read-files>\n${paths.slice(0, maxLines).join("\n")}\n</read-files>`;
}

function absolute(path: string, cwd: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** A re-fetchable identity for a tool call, derived from the shape of its
 * arguments. Same key later in the session means the agent went back for
 * something it already had. No tool is named here, so a third-party tool is
 * covered as soon as it passes a path, a URL, or a pattern. */
function toolKeys(args: unknown, cwd: string): string[] {
	return locations(args).map((location) =>
		location.kind === "file"
			? `file:${absolute(location.value, cwd)}`
			: `${location.kind}:${location.value}`,
	);
}

function callsIn(messages: readonly AgentMessage[], cwd: string): Call[] {
	const out: Call[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			for (const key of toolKeys(block.arguments, cwd)) out.push({ key });
		}
	}
	return out;
}

/** Post-boundary retrieval of artifacts fetched before it, restricted to kinds
 * whose bytes can actually be read or re-run from a named location. */
function refetches(pre: readonly Call[], post: readonly Call[]): string[] {
	const fetched = new Set(pre.map((call) => call.key));
	return post
		.map((call) => call.key)
		.filter((key) => REFETCH_KINDS.has(key.split(":")[0]) && fetched.has(key));
}

function keyTerms(key: string): string[] {
	const at = key.indexOf(":");
	return locationTerms({ kind: key.slice(0, at) as LocationKind, value: key.slice(at + 1) });
}

function covered(key: string, context: string): boolean {
	return keyTerms(key).some((term) => context.includes(term));
}

function messagesOf(entries: readonly SessionEntry[]): AgentMessage[] {
	return buildSessionContext(entries as SessionEntry[]).messages;
}

function tailText(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") parts.push(block.text);
				else if (block.type === "toolCall") {
					parts.push(`[tool_use ${block.name}] ${JSON.stringify(block.arguments ?? {}).slice(0, 400)}`);
				}
			}
		} else if (message.role === "toolResult") {
			const text = message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			parts.push(`[tool_result] ${text.slice(0, 800)}`);
		} else if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : "";
			if (text !== "") parts.push(text);
		}
	}
	return parts.join("\n");
}

interface Row {
	session: string;
	boundary: number;
	reads: number;
	defaultCovered: number;
	jevCovered: number;
	jevFull: number;
	defaultAlone: number;
	jevAlone: number;
	jevFullAlone: number;
	summaryChars: number;
	digestChars: number;
	tailChars: number;
	pointerChars: number;
	ms: number;
}

function sessionFiles(): string[] {
	const out: string[] = [];
	for (const dir of readdirSync(sessionsDir())) {
		const full = join(sessionsDir(), dir);
		if (!statSync(full).isDirectory()) continue;
		for (const file of readdirSync(full)) {
			if (file.endsWith(".jsonl")) out.push(join(full, file));
		}
	}
	return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

async function evaluate(
	path: string,
	options: Options,
	askFn: AskFn,
): Promise<Row[]> {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const parsed = parseSessionEntries(content);
	const header = parsed.find((entry) => entry.type === "session") as
		| { cwd?: string; id?: string }
		| undefined;
	const cwd = header?.cwd ?? "";
	const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
	const rows: Row[] = [];

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type !== "compaction") continue;
		const keptFrom = entries.findIndex((e) => e.id === entry.firstKeptEntryId);
		if (keptFrom < 0) continue;
		const preEntries = entries.slice(0, keptFrom);
		const keptEntries = entries.slice(keptFrom, index);
		const postEntries = entries.slice(index + 1);
		if (preEntries.length === 0 || postEntries.length === 0) continue;

		const preMessages = messagesOf(preEntries);
		const reads = refetches(callsIn(preMessages, cwd), callsIn(messagesOf(postEntries), cwd));
		if (reads.length === 0) continue;

		const blocks = blocksFrom(preMessages);
		if (blocks.length === 0) continue;

		let selection: Awaited<ReturnType<typeof selectBlocks>>;
		try {
			selection = await selectBlocks(blocks, { ask: askFn, cwd, pinTail: options.pinTail });
		} catch {
			continue;
		}

		const pointers = pointerIndex(blocks, selection.kept, cwd, options.pointerLines);
		const digest = renderDigest(blocks, selection.kept) + pointers;
		const digestFull =
			selection.kept
				.filter((k) => !k.text.includes(ELISION_MARK))
				.map((k) => k.text)
				.join("\n") + pointers;
		const summary = entry.summary ?? "";
		const tail = tailText(messagesOf(keptEntries));
		const defaultCtx = `${summary}\n${tail}`;
		const jevCtx = `${digest}\n${tail}`;

		rows.push({
			session: path.split("/").slice(-2).join("/"),
			boundary: index,
			reads: reads.length,
			defaultCovered: reads.filter((key) => covered(key, defaultCtx)).length,
			jevCovered: reads.filter((key) => covered(key, jevCtx)).length,
			jevFull: reads.filter((key) => covered(key, digestFull)).length,
			defaultAlone: reads.filter((key) => covered(key, summary)).length,
			jevAlone: reads.filter((key) => covered(key, digest)).length,
			jevFullAlone: reads.filter((key) => covered(key, digestFull)).length,
			summaryChars: summary.length,
			digestChars: digest.length,
			tailChars: tail.length,
			pointerChars: pointers.length,
			ms: selection.stats.ms ?? 0,
		});
	}
	return rows;
}

function pct(n: number, total: number): string {
	return total === 0 ? "n/a" : `${Math.round((100 * n) / total)}%`;
}

async function main(): Promise<number> {
	const options = parseOptions(process.argv.slice(2));
	const files = options.paths.length > 0 ? options.paths : sessionFiles();
	const resolved = resolveKey({ dotEnv: dotEnvPath(), callLog: callLogPath() });
	if (resolved.source === "missing") {
		console.log("no API key resolved; this eval needs live Jev judgments");
		return 1;
	}
	const askFn: AskFn = (state, questions, timeoutMs) =>
		liveAsk(state, questions, {
			dotEnv: dotEnvPath(),
			callLog: callLogPath(),
			timeoutMs,
			caller: "coverage",
		});

	console.log(
		`pi-jev re-fetch coverage · ${files.length} session files scanned · pointer lines ${options.pointerLines} · live Jev via ${resolved.provider?.name}`,
	);

	const rows: Row[] = [];
	for (const path of files) {
		if (options.limit > 0 && rows.length >= options.limit) break;
		let found: Row[] = [];
		try {
			found = await evaluate(path, options, askFn);
		} catch (error) {
			console.log(`failed: ${path.split("/").slice(-2).join("/")} — ${String(error).slice(0, 120)}`);
			continue;
		}
		rows.push(...found);
		for (const row of found) {
			console.log(
				`  ${row.session.slice(-44)} @${row.boundary}: ${row.reads} re-fetches, ` +
					`jev verbatim ${row.jevFull}/${row.reads}, default ${row.defaultCovered}/${row.reads}`,
			);
		}
	}

	if (rows.length === 0) {
		console.log("no compaction boundary in these sessions had a re-fetchable artifact");
		return 1;
	}
	const sum = (pick: (row: Row) => number) => rows.reduce((total, row) => total + pick(row), 0);
	const reads = sum((row) => row.reads);
	const median = (values: number[]) => {
		const sorted = [...values].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)];
	};

	console.log(`\n${rows.length} real compaction boundaries with signal, ${reads} re-fetch events\n`);
	console.log("                          what the model sees        the differing part alone");
	console.log(`  default (pi summary)    ${pct(sum((r) => r.defaultCovered), reads).padStart(6)}            ${pct(sum((r) => r.defaultAlone), reads).padStart(6)}`);
	console.log(`  jev digest              ${pct(sum((r) => r.jevCovered), reads).padStart(6)}            ${pct(sum((r) => r.jevAlone), reads).padStart(6)}`);
	console.log(`  jev verbatim only       ${pct(sum((r) => r.jevFull), reads).padStart(6)}            ${pct(sum((r) => r.jevFullAlone), reads).padStart(6)}`);
	console.log(
		`\n  re-fetchable events      ${reads}` +
			`\n  summary chars median     ${median(rows.map((row) => row.summaryChars))}` +
			`\n  digest chars median      ${median(rows.map((row) => row.digestChars))}` +
			`\n  shared tail chars median ${median(rows.map((row) => row.tailChars))}` +
			`\n  pointer index chars      ${median(rows.map((row) => row.pointerChars))} median, ${Math.max(...rows.map((row) => row.pointerChars))} max` +
			`\n  selection ms median      ${median(rows.map((row) => row.ms))}`,
	);

	const full = reads === 0 ? Number.NaN : sum((row) => row.jevFull) / reads;
	const verdict = Number.isNaN(full) ? "n/a" : full >= FLOOR_REFETCH_FULL ? "PASS" : "FAIL";
	console.log(
		`\nfloor: verbatim re-fetch coverage ${Number.isNaN(full) ? "n/a" : `${Math.round(full * 100)}%`} ` +
			`vs ${FLOOR_REFETCH_FULL * 100}% required — ${verdict}`,
	);
	console.log(`(TARGET_CHARS ${TARGET_CHARS}, PIN_TAIL ${options.pinTail ?? 4})`);
	return verdict === "FAIL" ? 1 : 0;
}

process.exitCode = await main();
