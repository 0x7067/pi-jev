import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envValue, readEnv, type EnvSource } from "./env.ts";
import { appendRecord, lastRecord } from "./log.ts";

export interface Provider {
	readonly name: string;
	readonly url: string;
	readonly keyPrefix: string;
	readonly keyVar: string;
}

export const PROVIDERS: readonly Provider[] = [
	{ name: "typesafe", url: "https://api.typesafe.ai/v1/systemone", keyPrefix: "", keyVar: "TYPESAFE_API_KEY" },
	{
		name: "openrouter",
		url: "https://openrouter.ai/api/v1/systemone",
		keyPrefix: "sk-or-",
		keyVar: "OPENROUTER_API_KEY",
	},
];

export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_TIMEOUT_MS = 8_000;
export const FAST_FAIL_MS = 1_000;

export type Question =
	| { type: "noul"; instructions: string }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] };

export interface Answer {
	noul?: number | null;
	choice?: string;
	confidence?: number | null;
	probabilities?: Record<string, number>;
}

export type Answers = Record<string, Answer>;

export class JevError extends Error {}

/** Where the caller keeps its dotenv fallback and its call log. Both optional:
 * with neither, the client reads the process environment and logs nowhere. */
export interface JevFiles {
	dotEnv?: string;
	callLog?: string;
}

let cachedVersion: string | undefined;

export function version(): string {
	if (cachedVersion === undefined) {
		try {
			const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
			const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
			cachedVersion = String(manifest.version ?? "unknown");
		} catch {
			cachedVersion = "unknown";
		}
	}
	return cachedVersion;
}

export function providerFor(key: string): Provider {
	return PROVIDERS.filter((p) => key.startsWith(p.keyPrefix)).reduce((a, b) =>
		b.keyPrefix.length > a.keyPrefix.length ? b : a,
	);
}

export function pinnedProvider(dotEnvPath?: string): Provider | undefined {
	const name = envValue("JEV_PROVIDER", dotEnvPath);
	return PROVIDERS.find((p) => p.name === name);
}

export interface Resolved {
	source: EnvSource | "missing";
	key: string;
	provider: Provider | undefined;
}

export function resolve(files: JevFiles = {}): Resolved {
	const pinned = pinnedProvider(files.dotEnv);
	const candidates = pinned ? [pinned] : PROVIDERS;
	const readers = [
		(name: string) => {
			const value = process.env[name]?.trim();
			return value ? { value, source: "env" as const } : undefined;
		},
		(name: string) => {
			const found = readEnv(name, files.dotEnv);
			return found?.source === "dotenv" ? found : undefined;
		},
	];
	for (const read of readers) {
		for (const provider of candidates) {
			const found = read(provider.keyVar);
			if (found) return { source: found.source, key: found.value, provider: pinned ?? providerFor(found.value) };
		}
	}
	return { source: "missing", key: "", provider: pinned };
}

export function missingKeyMessage(provider: Provider | undefined): string {
	const names = provider ? [provider.keyVar] : PROVIDERS.map((p) => p.keyVar);
	return `set ${names.join(" or ")}`;
}

export interface AskOptions extends JevFiles {
	model?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	caller?: string;
}

function logCall(
	callLog: string | undefined,
	provider: Provider,
	model: string,
	questions: number,
	started: number,
	error: string | undefined,
	caller: string,
): void {
	if (callLog === undefined) return;
	const record: Record<string, unknown> = {
		ts: new Date().toISOString(),
		caller,
		n_questions: questions,
		provider: provider.name,
		model,
		ms: Math.round(performance.now() - started),
		ok: error === undefined,
		v: version(),
	};
	if (error !== undefined) record.error = error.slice(0, 300);
	appendRecord(callLog, record);
}

export async function ask(
	state: unknown,
	questions: Record<string, Question>,
	options: AskOptions = {},
): Promise<Answers> {
	const { key, provider, source } = resolve(options);
	if (source === "missing" || provider === undefined) throw new JevError(missingKeyMessage(provider));
	const model = options.model ?? envValue("JEV_MODEL", options.dotEnv) ?? DEFAULT_MODEL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const caller = options.caller ?? "compaction";
	const body = JSON.stringify({ state, model, questions });
	const count = Object.keys(questions).length;
	const log = (started: number, error: string | undefined) =>
		logCall(options.callLog, provider, model, count, started, error, caller);

	for (let attempt = 1; ; attempt++) {
		const started = performance.now();
		let response: Response;
		try {
			response = await fetch(provider.url, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body,
				signal: options.signal
					? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
					: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			log(started, text);
			if (attempt === 1 && !options.signal?.aborted && performance.now() - started < FAST_FAIL_MS) continue;
			throw new JevError(text);
		}
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 500);
			log(started, `HTTP ${response.status}: ${detail}`);
			throw new JevError(`HTTP ${response.status}: ${detail}`);
		}
		const payload = (await response.json().catch(() => ({}))) as { answers?: Answers };
		log(started, undefined);
		return payload.answers ?? {};
	}
}

export interface Status {
	version: string;
	key: EnvSource | "missing";
	provider: string | undefined;
	pinned: string;
	lastCall: Record<string, unknown> | undefined;
}

export function status(files: JevFiles = {}): Status {
	const { source, provider } = resolve(files);
	return {
		version: version(),
		key: source,
		provider: provider?.name,
		pinned: envValue("JEV_PROVIDER", files.dotEnv) ?? "auto",
		lastCall: files.callLog === undefined ? undefined : lastRecord(files.callLog),
	};
}
