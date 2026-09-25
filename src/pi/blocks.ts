import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { splitSummary } from "../compaction/digest.ts";
import { BLOCK_BUDGET, judgeable, type Block } from "../compaction/select.ts";

type AgentMessage = Parameters<typeof convertToLlm>[0][number];
export type LlmMessage = ReturnType<typeof convertToLlm>[number];

const TOOL_INPUT_CHARS = 400;
const TOOL_RESULT_CHARS = 800;

const NOT_A_REQUEST: Record<string, string> = {
	bashExecution: "bash",
	branchSummary: "summary",
	compactionSummary: "summary",
};

function isText(block: unknown): block is { type: "text"; text: string } {
	return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isText)
		.map((block) => block.text)
		.join("\n");
}

export function blockFrom(message: LlmMessage): Block | undefined {
	if (message.role === "user") {
		const text = judgeable("user", contentText(message.content).trim());
		return text === undefined ? undefined : { role: "user", text };
	}
	if (message.role === "assistant") {
		const parts: string[] = [];
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
			else if (block.type === "toolCall") {
				parts.push(`[tool_use ${block.name}] ${JSON.stringify(block.arguments ?? {}).slice(0, TOOL_INPUT_CHARS)}`);
			}
		}
		const text = judgeable("assistant", parts.join("\n").trim());
		return text === undefined ? undefined : { role: "assistant", text };
	}
	if (message.role === "toolResult") {
		const text = judgeable("tool", `[tool_result] ${contentText(message.content).slice(0, TOOL_RESULT_CHARS)}`.trim());
		return text === undefined ? undefined : { role: "tool", text };
	}
	return undefined;
}

interface Pending {
	block: Block;
	provides: string[];
	answers?: string;
}

function toolLinks(message: LlmMessage): { provides: string[]; answers?: string } {
	if (message.role === "assistant") {
		const provides: string[] = [];
		for (const block of message.content) if (block.type === "toolCall") provides.push(block.id);
		return { provides };
	}
	if (message.role === "toolResult") return { provides: [], answers: message.toolCallId };
	return { provides: [] };
}

export function blocksFrom(messages: readonly AgentMessage[], previousSummary?: string): Block[] {
	const prior = previousSummary ? splitSummary(previousSummary) : [];
	const entries: Pending[] = prior.map((block) => ({ block, provides: [] }));
	const fresh: Pending[] = [];
	for (const message of messages) {
		const role = NOT_A_REQUEST[message.role];
		for (const llm of convertToLlm([message])) {
			const block = blockFrom(llm);
			if (block === undefined) continue;
			fresh.push({ block: role === undefined ? block : { ...block, role }, ...toolLinks(llm) });
		}
	}
	const room = Math.max(0, BLOCK_BUDGET - prior.length);
	entries.push(...fresh.slice(Math.max(0, fresh.length - room)));

	const providedBy = new Map<string, number>();
	entries.forEach((entry, index) => {
		for (const id of entry.provides) providedBy.set(id, index);
	});
	for (let index = 0; index < entries.length; index++) {
		const answers = entries[index].answers;
		const call = answers === undefined ? undefined : providedBy.get(answers);
		if (call !== undefined && call !== index) entries[index].block.needs = call;
	}
	return entries.map((entry) => entry.block);
}
