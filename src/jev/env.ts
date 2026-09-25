import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function fromDotEnv(name: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(join(configDir(), ".env"), "utf8");
	} catch {
		return undefined;
	}
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const match = ASSIGNMENT.exec(trimmed);
		if (match?.[1] !== name) continue;
		const value = match[2].trim();
		const quoted =
			(value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
		return (quoted ? value.slice(1, -1) : value) || undefined;
	}
	return undefined;
}

export type EnvSource = "env" | "dotenv";

export function readEnv(name: string): { value: string; source: EnvSource } | undefined {
	const direct = process.env[name]?.trim();
	if (direct) return { value: direct, source: "env" };
	const saved = fromDotEnv(name);
	return saved ? { value: saved, source: "dotenv" } : undefined;
}

export function envValue(name: string): string | undefined {
	return readEnv(name)?.value;
}
