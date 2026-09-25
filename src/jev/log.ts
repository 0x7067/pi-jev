import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./env.ts";

export const CALL_LOG = "jev-calls.jsonl";
export const COMPACT_LOG = "jev-compact-log.jsonl";

const TAIL_BYTES = 4096;

export function logPath(file: string): string {
	return join(configDir(), file);
}

export function appendRecord(file: string, record: Record<string, unknown>): void {
	try {
		const path = logPath(file);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch {}
}

export function lastRecord(file: string): Record<string, unknown> | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(logPath(file), "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		const lines = buffer
			.toString("utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim() !== "");
		if (lines.length === 0) return undefined;
		return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
