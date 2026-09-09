import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_POLICY_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"council-policy.md",
);
// The Agent tool's `name` parameter only accepts these characters; a roster
// name is passed straight through as the dispatch name, so validation must
// reject anything the dispatch would.
const COUNCILLOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
const THINKING_SET = new Set<string>(THINKING_LEVELS);
const COUNCILLOR_FIELDS = new Set(["name", "model", "prompt", "thinking"]);

export type CouncilOptions = { policyPath?: string };

type CouncillorChoice = {
	name: string;
	model?: string;
	prompt?: string;
	thinking?: string;
};

type RosterResult = { councillors: CouncillorChoice[] } | { error: string };

function loadPolicy(
	path: string,
	label: string,
): { policy?: string; error?: string } {
	try {
		const policy = readFileSync(path, "utf8").trim();
		if (!policy) return { error: `${label} is empty: ${path}` };
		return { policy };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `Unable to read ${label} at ${path}: ${message}` };
	}
}

/** Return the frontmatter body of an agent file, or undefined when absent. */
function frontmatterBlock(source: string): string | undefined {
	if (!source.startsWith("---")) return undefined;
	const end = source.indexOf("\n---", 3);
	return end === -1 ? undefined : source.slice(3, end);
}

/**
 * Read and validate the global council.json. Called on every /council
 * invocation so roster edits take effect without a reload. Empty strings are
 * normalized to "unset" (trim for model/thinking; whitespace-only prompt),
 * while a formatted prompt keeps its original layout verbatim.
 */
function loadRoster(): RosterResult {
	const path = join(getAgentDir(), "council.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return {
				error: `council.json not found at ${path}; council is unavailable until it exists`,
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return { error: `Unable to read council.json at ${path}: ${message}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `Invalid JSON in council.json at ${path}: ${message}` };
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed)
	) {
		return { error: `council.json must contain a JSON object at ${path}` };
	}

	const record = parsed as Record<string, unknown>;
	const unknownTop = Object.keys(record).filter(
		(key) => key !== "councillors",
	);
	if (unknownTop.length) {
		return {
			error: `council.json has unknown field(s): ${unknownTop.join(", ")} (allowed: councillors) at ${path}`,
		};
	}

	const rawList = record.councillors;
	if (!Array.isArray(rawList) || rawList.length === 0) {
		return { error: `"councillors" must be a non-empty array at ${path}` };
	}

	const choices: CouncillorChoice[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < rawList.length; index += 1) {
		const entry: unknown = rawList[index];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return { error: `councillors[${index}] must be an object` };
		}
		const fields = entry as Record<string, unknown>;
		const unknownFields = Object.keys(fields).filter(
			(key) => !COUNCILLOR_FIELDS.has(key),
		);
		if (unknownFields.length) {
			return {
				error: `councillors[${index}] has unknown field(s): ${unknownFields.join(", ")} (allowed: name, model, prompt, thinking)`,
			};
		}

		const name = typeof fields.name === "string" ? fields.name.trim() : "";
		if (!name) {
			return { error: `councillors[${index}] requires a non-empty "name"` };
		}
		if (!COUNCILLOR_NAME_RE.test(name)) {
			return {
				error: `councillors[${index}] name "${name}" is invalid: use letters, digits, "_" or "-", starting with a letter or digit (Agent tool "name" constraint)`,
			};
		}
		if (seen.has(name)) {
			return { error: `duplicate councillor name: ${name}` };
		}
		seen.add(name);

		const choice: CouncillorChoice = { name };
		if (fields.model !== undefined) {
			if (typeof fields.model !== "string") {
				return {
					error: `councillors[${index}] (${name}) "model" must be a string`,
				};
			}
			const model = fields.model.trim();
			if (model) choice.model = model;
		}
		if (fields.thinking !== undefined) {
			if (typeof fields.thinking !== "string") {
				return {
					error: `councillors[${index}] (${name}) "thinking" must be a string`,
				};
			}
			const thinking = fields.thinking.trim();
			if (thinking) {
				if (!THINKING_SET.has(thinking)) {
					return {
						error: `councillors[${index}] (${name}) has invalid thinking "${thinking}" (allowed: ${THINKING_LEVELS.join(", ")})`,
					};
				}
				choice.thinking = thinking;
			}
		}
		if (fields.prompt !== undefined) {
			if (typeof fields.prompt !== "string") {
				return {
					error: `councillors[${index}] (${name}) "prompt" must be a string`,
				};
			}
			// Whitespace-only means unset; otherwise keep the prompt verbatim,
			// layout included.
			if (fields.prompt.trim()) choice.prompt = fields.prompt;
		}
		choices.push(choice);
	}
	return { councillors: choices };
}

function rosterLine(choice: CouncillorChoice): string {
	const parts = [`- ${choice.name}`];
	parts.push(`model: ${choice.model ?? "inherit (parent session)"}`);
	if (choice.thinking) parts.push(`thinking: ${choice.thinking}`);
	if (choice.prompt) parts.push(`perspective: ${choice.prompt}`);
	return parts.join(" — ");
}

/**
 * Existence hint from the model registry. This does not reimplement
 * pi-subagents' fuzzy resolution and never claims absence: an unmatched name
 * is "unconfirmed" because models are resolved at dispatch.
 */
function modelHint(model: string | undefined, ctx: ExtensionContext): string {
	if (!model) return "inherit (parent session)";
	let available: boolean | undefined;
	try {
		const registry = ctx.modelRegistry;
		if (model.includes("/")) {
			const slash = model.indexOf("/");
			available = Boolean(
				registry.find(model.slice(0, slash), model.slice(slash + 1)),
			);
		} else {
			available = registry
				.getAvailable()
				.some((entry) => entry.id === model);
		}
	} catch {
		return model;
	}
	return available
		? `${model} (available)`
		: `${model} (unconfirmed — resolved at dispatch)`;
}

/**
 * Audit the installed global councillor.md template. Frontmatter model or
 * thinking would silently override every per-councillor choice in
 * council.json (pi-subagents resolves agent config before dispatch params),
 * and run_in_background other than false would break the single-turn design.
 */
function templateAudit(): string[] {
	const path = join(getAgentDir(), "agents", "councillor.md");
	let source: string;
	try {
		source = readFileSync(path, "utf8");
	} catch {
		return [
			`councillor template: not found at ${path} — council dispatch fails until the agent is installed`,
		];
	}
	const block = frontmatterBlock(source);
	if (!block) {
		return [
			`councillor template: ${path} — no frontmatter found; cannot audit overrides`,
		];
	}
	const warnings: string[] = [];
	for (const line of block.split("\n")) {
		if (/^model:\s*\S/.test(line)) {
			warnings.push(
				`pins "${line.trim()}" — frontmatter model overrides council.json per-councillor models`,
			);
		}
		if (/^thinking:\s*\S/.test(line)) {
			warnings.push(
				`pins "${line.trim()}" — frontmatter thinking overrides council.json per-councillor thinking`,
			);
		}
		const background = line.match(/^run_in_background:\s*(\S+)/);
		if (background && background[1] !== "false") {
			warnings.push(
				`sets "${line.trim()}" — council expects foreground dispatch`,
			);
		}
	}
	if (!warnings.length) return [`councillor template: ${path} — ok`];
	return [
		`councillor template: ${path} — overrides detected`,
		...warnings.map((warning) => `  - ${warning}`),
	];
}

export function registerCouncil(
	pi: ExtensionAPI,
	options: CouncilOptions = {},
): void {
	const loaded = loadPolicy(
		options.policyPath ?? DEFAULT_POLICY_PATH,
		"Council policy",
	);

	const notify = (
		ctx: ExtensionContext,
		message: string,
		level: "info" | "warning" | "error" = "info",
	) => {
		if (!ctx.hasUI) return;
		ctx.ui.notify(message, level);
	};

	const convene = (question: string, ctx: ExtensionContext) => {
		if (!loaded.policy) {
			notify(
				ctx,
				loaded.error ?? "Council policy is unavailable; council cannot convene.",
				"error",
			);
			return;
		}
		const roster = loadRoster();
		if ("error" in roster) {
			notify(ctx, roster.error, "error");
			return;
		}
		const message = [
			"<CouncilInstruction>",
			loaded.policy,
			"",
			"## Roster",
			"",
			...roster.councillors.map(rosterLine),
			"",
			"## Question",
			"",
			question,
			"</CouncilInstruction>",
		].join("\n");
		pi.sendUserMessage(message, { deliverAs: "followUp" });
		notify(
			ctx,
			`Council convened: ${roster.councillors.map((choice) => choice.name).join(", ")} (${roster.councillors.length}).`,
		);
	};

	const doctor = (ctx: ExtensionContext) => {
		const lines: string[] = [
			`council policy: ${
				loaded.policy
					? `loaded, ${loaded.policy.length} chars`
					: `unavailable — ${loaded.error}`
			}`,
		];
		const roster = loadRoster();
		if ("error" in roster) {
			lines.push(`council.json: ${roster.error}`);
		} else {
			lines.push(
				`council.json: ${join(getAgentDir(), "council.json")} — ${roster.councillors.length} councillor(s)`,
			);
			for (const choice of roster.councillors) {
				const parts = [
					`- ${choice.name}`,
					`model: ${modelHint(choice.model, ctx)}`,
				];
				if (choice.thinking) parts.push(`thinking: ${choice.thinking}`);
				if (choice.prompt) parts.push(`perspective: ${choice.prompt}`);
				lines.push(parts.join(" — "));
			}
			if (roster.councillors.length > 5) {
				lines.push(
					`note: ${roster.councillors.length} councillors is a high-cost council; consider a smaller roster`,
				);
			}
		}
		lines.push(...templateAudit());
		const agentRegistered = pi
			.getAllTools()
			.some((tool) => tool.name === "Agent");
		lines.push(
			`Agent tool: ${agentRegistered ? "registered" : "not registered — council cannot dispatch"}`,
		);
		lines.push(
			"scope: checks the global councillor template and global council.json only; a project .pi/agents/councillor.md override is not covered",
		);
		lines.push(
			"note: model registry presence does not guarantee dispatch success; models are resolved at dispatch",
		);
		notify(ctx, lines.join("\n"));
	};

	pi.registerCommand("council", {
		description:
			"Convene a multi-councillor review: /council <question> | /council doctor",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "") {
				if (!ctx.hasUI) {
					throw new Error(
						"Council question input requires an interactive session; use /council <question> in print or JSON mode.",
					);
				}
				const question = (await ctx.ui.editor("Council question", ""))?.trim();
				if (!question) return;
				convene(question, ctx);
				return;
			}
			if (action === "doctor") {
				doctor(ctx);
				return;
			}
			convene(action, ctx);
		},
	});
}
