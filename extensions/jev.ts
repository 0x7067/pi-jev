import type { ExtensionAPI, FileOperations } from "@earendil-works/pi-coding-agent";
import { pointerIndex, POINTER_CHARS, renderDigest } from "../src/pi/digest.ts";
import {
	DIRECTIVE_CHARS,
	selectBlocks,
	TARGET_CHARS,
	type AskFn,
	type Selection,
} from "../src/compaction/select.ts";
import { ask, resolve, status } from "../src/jev/client.ts";
import { appendRecord, lastRecord } from "../src/jev/log.ts";
import { blocksFrom } from "../src/pi/blocks.ts";
import { callLogPath, compactLogPath, dotEnvPath } from "../src/pi/paths.ts";

const FILES = { dotEnv: dotEnvPath(), callLog: callLogPath() };
const COMPACT_LOG_PATH = compactLogPath();

function directiveOf(instructions: string | undefined): string | undefined {
	const trimmed = (instructions ?? "").trim().slice(0, DIRECTIVE_CHARS);
	return trimmed === "" ? undefined : trimmed;
}

function fileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	return {
		readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function describeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function describeDigest(reason: string, selection: Selection): string {
	const { kept, truncated, reduction, ms } = selection.stats;
	const percent = `${Math.round((reduction ?? 0) * 100)}%`;
	return `jev-compact: ${reason} compaction replaced by ${kept} blocks (${truncated} truncated, ${percent} smaller, ${ms} ms)`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		if (resolve(FILES).source === "missing") return;
		const { preparation, customInstructions, reason, signal } = event;
		const blocks = blocksFrom(
			[...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
			preparation.previousSummary,
		);
		if (blocks.length === 0) return;

		const askFn: AskFn = (state, questions, timeoutMs) =>
			ask(state, questions, { ...FILES, timeoutMs, signal, caller: "compaction" });

		const cwd = ctx.sessionManager.getCwd();
		let selection: Selection;
		try {
			selection = await selectBlocks(blocks, {
				ask: askFn,
				cwd,
				directive: directiveOf(customInstructions),
				targetChars: TARGET_CHARS - POINTER_CHARS,
			});
		} catch (error) {
			ctx.ui.notify(`jev-compact: ${describeError(error)}; pi's own summary runs`, "warning");
			return;
		}

		const { rows, ...counters } = selection.stats;
		const pointers = pointerIndex(blocks, selection.kept, cwd);
		const summary = renderDigest(blocks, selection.kept, pointers);
		appendRecord(COMPACT_LOG_PATH, {
			ts: new Date().toISOString(),
			session_id: ctx.sessionManager.getSessionId(),
			source: "session_before_compact",
			trigger: reason,
			blocks_in: blocks.length,
			pointer_chars: pointers.length,
			...counters,
			rows,
		});
		ctx.ui.notify(describeDigest(reason, selection), "info");

		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				estimatedTokensAfter: Math.ceil(summary.length / 4),
				details: { ...fileLists(preparation.fileOps), jev: counters },
			},
		};
	});

	pi.registerCommand("jev", {
		description: "Show the Jev key source, provider, version, and the last compaction",
		handler: async (_args, ctx) => {
			const info = status(FILES);
			const call = info.lastCall;
			const lastCall =
				call === undefined
					? "no Jev call logged yet"
					: `last call ${call.ok ? "ok" : "failed"} in ${call.ms} ms at ${call.ts}` +
						`${call.ok ? "" : `: ${String(call.error ?? "").slice(0, 160)}`}`;
			const compacted = lastRecord(COMPACT_LOG_PATH);
			const lastCompaction =
				compacted === undefined
					? "no compaction logged yet"
					: `last compaction ${compacted.trigger} kept ${compacted.kept} of ${compacted.blocks_in} blocks at ${compacted.ts}`;
			ctx.ui.notify(
				[
					`pi-jev ${info.version} · key ${info.key}${info.provider ? ` · ${info.provider}` : ""} · provider ${info.pinned}`,
					lastCall,
					lastCompaction,
				].join("\n"),
				info.key === "missing" ? "warning" : "info",
			);
		},
	});
}
