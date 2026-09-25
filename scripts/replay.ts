import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildSessionContext, estimateTokens, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SessionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderDigest, splitSummary } from "../src/pi/digest.ts";
import { selectBlocks, TARGET_CHARS, type AskFn } from "../src/compaction/select.ts";
import { ask as liveAsk, resolve, type Answers } from "../src/jev/client.ts";
import { callLogPath, dotEnvPath, sessionsDir } from "../src/pi/paths.ts";
import { blocksFrom } from "../src/pi/blocks.ts";

type AgentMessage = SessionContext["messages"][number];

interface Options {
	limit: number;
	keepRecentTokens: number;
	show: number;
	paths: string[];
}

function parseOptions(argv: readonly string[]): Options {
	const options: Options = { limit: 5, keepRecentTokens: 20_000, show: 0, paths: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--limit") options.limit = Number(argv[++i]);
		else if (arg === "--keep-recent") options.keepRecentTokens = Number(argv[++i]);
		else if (arg === "--show") options.show = Number(argv[++i]);
		else if (arg !== undefined && !arg.startsWith("--")) options.paths.push(arg);
	}
	return options;
}

function sessionFiles(): string[] {
	const root = sessionsDir();
	const out: string[] = [];
	for (const dir of readdirSync(root)) {
		const full = join(root, dir);
		if (!statSync(full).isDirectory()) continue;
		for (const file of readdirSync(full)) {
			if (file.endsWith(".jsonl")) out.push(join(full, file));
		}
	}
	return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function cutIndex(messages: readonly AgentMessage[], keepRecentTokens: number): number {
	let total = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		total += estimateTokens(messages[i]);
		if (total >= keepRecentTokens) return i + 1;
	}
	return 0;
}

function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 4294967295;
}

const stubAsk: AskFn = async (_state, questions) => {
	const answers: Answers = {};
	for (const [key, question] of Object.entries(questions)) {
		answers[key] = { noul: Math.round(hash(`${key}:${question.instructions}`) * 100) / 100 };
	}
	return answers;
};

interface Row {
	session: string;
	messages: number;
	summarized: number;
	blocks: number;
	kept: number;
	truncated: number;
	pinned: number;
	rescued: number;
	charsBefore: number;
	charsAfter: number;
	digestChars: number;
	reduction: number;
	ms: number;
	failedChunks: number;
	roundTrip: boolean;
	capBound: boolean;
	escalated: number;
	droppedByCap: number;
	pinnedChars: number;
	pinShare: number;
	linked: number;
	adjacencyMissed: number;
	orphans: number;
	digest?: string;
}

async function replay(path: string, options: Options, askFn: AskFn): Promise<Row | undefined> {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const parsed = parseSessionEntries(content);
	const header = parsed.find((entry) => entry.type === "session") as { cwd?: string } | undefined;
	const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
	if (entries.length === 0) return undefined;

	const messages = buildSessionContext(entries).messages;
	const cut = cutIndex(messages, options.keepRecentTokens);
	if (cut < 8) return undefined;

	const blocks = blocksFrom(messages.slice(0, cut));
	if (blocks.length === 0) return undefined;

	const selection = await selectBlocks(blocks, { ask: askFn, cwd: header?.cwd });
	const digest = renderDigest(blocks, selection.kept);
	const stats = selection.stats;
	const split = splitSummary(digest);
	const roundTrip =
		split.length === selection.kept.length &&
		split.every(
			(block, index) =>
				block.text === selection.kept[index]?.text && block.role === blocks[selection.kept[index].i].role,
		);

	const keptSet = new Set(selection.kept.map((k) => k.i));
	let linked = 0;
	let adjacencyMissed = 0;
	let orphans = 0;
	blocks.forEach((block, i) => {
		if (block.needs === undefined) return;
		linked++;
		const byText = i > 0 && blocks[i - 1].text.startsWith("[tool_use") ? i - 1 : undefined;
		if (block.needs !== byText) adjacencyMissed++;
		if (keptSet.has(i) && !keptSet.has(block.needs)) orphans++;
	});

	const pinnedChars = stats.pinnedChars ?? 0;
	const charsAfter = stats.charsAfter ?? 0;
	return {
		session: path.split("/").slice(-2).join("/"),
		messages: messages.length,
		summarized: cut,
		blocks: blocks.length,
		kept: stats.kept ?? 0,
		truncated: stats.truncated ?? 0,
		pinned: stats.pinned ?? 0,
		rescued: stats.rescued ?? 0,
		charsBefore: stats.charsBefore ?? 0,
		charsAfter,
		digestChars: digest.length,
		reduction: stats.reduction ?? 0,
		ms: stats.ms ?? 0,
		failedChunks: (stats.rows ?? []).filter(
			(row) => row.verdict !== "pinned" && Object.keys(row.checks).length === 0,
		).length,
		roundTrip,
		capBound: (stats.charsBeforeFit ?? 0) > TARGET_CHARS,
		escalated: stats.escalated ?? 0,
		droppedByCap: (stats.keptBeforeFit ?? 0) - (stats.kept ?? 0),
		pinnedChars,
		pinShare: charsAfter === 0 ? 0 : pinnedChars / charsAfter,
		linked,
		adjacencyMissed,
		orphans,
		digest,
	};
}

function print(rows: readonly Row[], label: string): void {
	const head = [
		"session",
		"msgs",
		"summarized",
		"blocks",
		"kept",
		"trunc",
		"pin",
		"resc",
		"chars_in",
		"chars_out",
		"digest",
		"reduction",
		"ms",
		"unjudged",
		"roundtrip",
		"linked",
		"adj_missed",
		"orphans",
	];
	const table = rows.map((row) => [
		row.session.slice(-46),
		row.messages,
		row.summarized,
		row.blocks,
		row.kept,
		row.truncated,
		row.pinned,
		row.rescued,
		row.charsBefore,
		row.charsAfter,
		row.digestChars,
		`${Math.round(row.reduction * 100)}%`,
		row.ms,
		row.failedChunks,
		row.roundTrip ? "ok" : "SPLIT",
		row.linked,
		row.adjacencyMissed,
		row.orphans,
	]);
	const widths = head.map((name, i) => Math.max(name.length, ...table.map((cells) => String(cells[i]).length)));
	const line = (cells: readonly unknown[]) =>
		cells.map((cell, i) => String(cell).padStart(i === 0 ? 0 : widths[i])).join("  ");
	console.log(`\n${label}`);
	console.log(line(head));
	for (const cells of table) console.log(line(cells));
	const broken = rows.filter((row) => !row.roundTrip);
	if (broken.length > 0) {
		console.log(`\nround-trip FAILED on ${broken.length} session(s): a kept block contains a delimiter line`);
	}
}

function quantile(values: readonly number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function budget(rows: readonly Row[]): void {
	const pct = (x: number) => `${Math.round(x * 100)}%`;
	const shares = rows.map((row) => row.pinShare);
	const pinned = rows.map((row) => row.pinnedChars);
	const digests = rows.map((row) => row.digestChars);
	console.log(`\nbudget — TARGET_CHARS ${TARGET_CHARS}, PIN_TAIL 4:`);
	console.log(`  cap bound on ${rows.filter((row) => row.capBound).length}/${rows.length} sessions`);
	console.log(`  blocks the cap downgraded to heads: ${rows.reduce((n, row) => n + row.escalated, 0)}`);
	console.log(`  blocks the cap dropped: ${rows.reduce((n, row) => n + row.droppedByCap, 0)}`);
	console.log(
		`  pinned share of digest: median ${pct(quantile(shares, 0.5))} · p90 ${pct(quantile(shares, 0.9))} · max ${pct(Math.max(...shares))}`,
	);
	console.log(`  pinned chars: median ${quantile(pinned, 0.5)} · max ${Math.max(...pinned)} of ${TARGET_CHARS}`);
	console.log(`  digest chars: median ${quantile(digests, 0.5)} · max ${Math.max(...digests)}`);
	const bound = rows.filter((row) => row.capBound);
	if (bound.length > 0) {
		const boundShares = bound.map((row) => row.pinShare);
		const boundDigests = bound.map((row) => row.digestChars);
		console.log(
			`  on the ${bound.length} cap-bound sessions: pinned share median ${pct(quantile(boundShares, 0.5))} · max ${pct(Math.max(...boundShares))} · digest median ${quantile(boundDigests, 0.5)}`,
		);
	}
	const slack = rows.filter((row) => !row.capBound);
	if (slack.length > 0) {
		console.log(
			`  on the ${slack.length} sessions with slack: pinned share median ${pct(quantile(slack.map((row) => row.pinShare), 0.5))} · digest median ${quantile(slack.map((row) => row.digestChars), 0.5)} of ${TARGET_CHARS}`,
		);
	}
}

async function main(): Promise<number> {
	const options = parseOptions(process.argv.slice(2));
	const paths = options.paths.length > 0 ? options.paths : sessionFiles().slice(0, options.limit);
	const files = { dotEnv: dotEnvPath(), callLog: callLogPath() };
	const resolved = resolve(files);
	const live = resolved.source !== "missing";
	const askFn: AskFn = live
		? (state, questions, timeoutMs) => liveAsk(state, questions, { ...files, timeoutMs, caller: "replay" })
		: stubAsk;
	console.log(
		`pi-jev replay · ${paths.length} session(s) · keepRecentTokens ${options.keepRecentTokens} · ` +
			`judgments ${live ? `live via ${resolved.provider?.name}` : "STUBBED (no API key resolved)"}`,
	);

	const rows: Row[] = [];
	for (const path of paths) {
		const row = await replay(path, options, askFn);
		if (row === undefined) {
			console.log(`skipped (too short or unreadable): ${path.split("/").slice(-2).join("/")}`);
			continue;
		}
		rows.push(row);
		if (!live) console.log(`  stub answers, not judgments: ${row.session.slice(-46)}`);
	}
	if (rows.length === 0) {
		console.log("nothing to replay");
		return 1;
	}
	print(rows, `${rows.length} session(s) replayed`);

	const totals = rows.reduce(
		(acc, row) => ({
			blocks: acc.blocks + row.blocks,
			kept: acc.kept + row.kept,
			charsBefore: acc.charsBefore + row.charsBefore,
			charsAfter: acc.charsAfter + row.charsAfter,
			digest: Math.max(acc.digest, row.digestChars),
			linked: acc.linked + row.linked,
			adjacencyMissed: acc.adjacencyMissed + row.adjacencyMissed,
			orphans: acc.orphans + row.orphans,
		}),
		{ blocks: 0, kept: 0, charsBefore: 0, charsAfter: 0, digest: 0, linked: 0, adjacencyMissed: 0, orphans: 0 },
	);
	console.log(
		`\ntotals: ${totals.blocks} blocks -> ${totals.kept} kept · ` +
			`${totals.charsBefore} -> ${totals.charsAfter} chars ` +
			`(${Math.round((1 - totals.charsAfter / Math.max(totals.charsBefore, 1)) * 100)}% smaller) · ` +
			`largest digest ${totals.digest} chars (~${Math.round(totals.digest / 4)} tok) · ` +
			`${totals.linked} linked tool results, ${totals.adjacencyMissed} of them missed by text adjacency, ` +
			`${totals.orphans} left without their call`,
	);
	budget(rows);

	if (options.show > 0) {
		const last = rows[rows.length - 1];
		console.log(`\n--- digest of ${last.session.slice(-60)} (first ${options.show} lines) ---`);
		console.log((last.digest ?? "").split("\n").slice(0, options.show).join("\n"));
	}
	return 0;
}

process.exitCode = await main();
