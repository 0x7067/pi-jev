import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { missingKeyMessage, PROVIDERS, providerFor, resolve, status } from "../src/jev/client.ts";
import { configDir } from "../src/jev/env.ts";

const VARS = ["PI_CODING_AGENT_DIR", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "JEV_PROVIDER", "JEV_MODEL"];
const saved = new Map(VARS.map((name) => [name, process.env[name]]));
let dir = "";

before(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-jev-"));
	for (const name of VARS) delete process.env[name];
	process.env.PI_CODING_AGENT_DIR = dir;
});

after(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

function setEnv(vars: Record<string, string | undefined>): void {
	for (const name of VARS) if (name !== "PI_CODING_AGENT_DIR") delete process.env[name];
	for (const [name, value] of Object.entries(vars)) if (value !== undefined) process.env[name] = value;
}

function setDotEnv(text: string): void {
	writeFileSync(join(dir, ".env"), text);
}

test("configDir follows PI_CODING_AGENT_DIR", () => {
	assert.equal(configDir(), dir);
});

test("providerFor lets the key prefix pick, so an sk-or- key anywhere calls OpenRouter", () => {
	assert.equal(providerFor("sk-or-abc").name, "openrouter");
	assert.equal(providerFor("ts_abc").name, "typesafe");
	assert.equal(providerFor("").name, "typesafe", "the empty prefix is the fallback");
	assert.equal(PROVIDERS.length, 2);
});

test("resolve reports a missing key instead of raising", () => {
	setEnv({});
	rmSync(join(dir, ".env"), { force: true });
	assert.deepEqual(resolve(), { source: "missing", key: "", provider: undefined });
	assert.equal(missingKeyMessage(undefined), "set TYPESAFE_API_KEY or OPENROUTER_API_KEY");
});

test("resolve reads the launch environment", () => {
	setEnv({ TYPESAFE_API_KEY: "ts_key" });
	const found = resolve();
	assert.equal(found.source, "env");
	assert.equal(found.key, "ts_key");
	assert.equal(found.provider?.name, "typesafe");
});

test("resolve falls back to the agent .env, which pi does not load itself", () => {
	setEnv({});
	setDotEnv("OPENROUTER_API_KEY=sk-or-from-file\n");
	const found = resolve();
	assert.equal(found.source, "dotenv");
	assert.equal(found.key, "sk-or-from-file");
	assert.equal(found.provider?.name, "openrouter");
});

test("resolve reads quoted and exported .env assignments", () => {
	setEnv({});
	setDotEnv('# a comment\nexport TYPESAFE_API_KEY="ts quoted"\n');
	assert.equal(resolve().key, "ts quoted");
});

test("resolve prefers the launch environment over the saved file", () => {
	setEnv({ TYPESAFE_API_KEY: "ts_from_env" });
	setDotEnv("TYPESAFE_API_KEY=ts_from_file\n");
	const found = resolve();
	assert.equal(found.source, "env");
	assert.equal(found.key, "ts_from_env");
});

test("auto reads TYPESAFE_API_KEY first, whichever file it came from", () => {
	setEnv({});
	setDotEnv("OPENROUTER_API_KEY=sk-or-saved\nTYPESAFE_API_KEY=ts-saved\n");
	assert.equal(resolve().key, "ts-saved");
	setEnv({ TYPESAFE_API_KEY: "ts-env", OPENROUTER_API_KEY: "sk-or-env" });
	assert.equal(resolve().key, "ts-env");
});

test("a pinned provider reads only its own variable", () => {
	setEnv({ JEV_PROVIDER: "openrouter", TYPESAFE_API_KEY: "ts_key" });
	setDotEnv("");
	assert.equal(resolve().source, "missing", "the typesafe key is not openrouter's to spend");
	assert.equal(missingKeyMessage(resolve().provider), "set OPENROUTER_API_KEY");
	setEnv({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-pinned" });
	assert.equal(resolve().provider?.url, "https://openrouter.ai/api/v1/systemone");
});

test("a pinned provider still lets the key prefix decide nothing", () => {
	setEnv({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "sk-or-misfiled" });
	assert.equal(resolve().provider?.name, "typesafe", "the pin wins over the prefix");
});

test("status reports the key source but never the key", () => {
	setEnv({ TYPESAFE_API_KEY: "ts_secret_value" });
	setDotEnv("");
	const info = status();
	assert.equal(info.key, "env");
	assert.equal(info.provider, "typesafe");
	assert.equal(info.pinned, "auto");
	const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
		version: string;
	};
	assert.equal(info.version, manifest.version, "every log line is stamped with the version that wrote it");
	assert.ok(!JSON.stringify(info).includes("ts_secret_value"));
});
