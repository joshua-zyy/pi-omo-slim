import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATE_ENTRY = "orchestrator-mode";
const GOAL_STATE_ENTRY = "goal-state";
const STATUS_KEY = "orchestrator-mode";
const POLICY_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"orchestrator-policy.md",
);
const GOAL_POLICY_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"orchestrator-goal-policy.md",
);
const CONFIG_PATH = join(getAgentDir(), "orchestrator-mode.json");
const AGENTS_DIR = join(getAgentDir(), "agents");
const ROLE_FILES = [
	"Explore",
	"librarian",
	"oracle",
	"designer",
	"fixer",
	"verifier",
];

type OrchestratorState = {
	enabled: boolean;
};

type OrchestratorConfig = {
	defaultEnabled?: boolean;
};

type ToolAudit = {
	references: number;
	unique: number;
	/** Referenced tool name -> roles that declare it. */
	missing: Map<string, string[]>;
	/** Roles whose file or frontmatter could not be read. */
	unchecked: string[];
	compared: boolean;
};

function loadPolicy(path: string, label: string): { policy?: string; error?: string } {
	try {
		const policy = readFileSync(path, "utf8").trim();
		if (!policy) {
			return { error: `${label} is empty: ${path}` };
		}
		return { policy };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			error: `Unable to read ${label} at ${path}: ${message}`,
		};
	}
}

/** Return the frontmatter body of an agent file, or undefined when absent. */
function frontmatterBlock(source: string): string | undefined {
	if (!source.startsWith("---")) return undefined;
	const end = source.indexOf("\n---", 3);
	return end === -1 ? undefined : source.slice(3, end);
}

/**
 * Extract the bare tool names from an agent's `ext:<extension>/<tool>` selectors.
 *
 * Only the tool half is returned. The extension half is deliberately ignored:
 * the failure this guards against is a tool that no longer exists under the
 * declared name, and matching extension identity would mean reimplementing
 * pi-subagents' canonical-name resolution.
 */
function extToolNames(block: string): string[] {
	for (const line of block.split("\n")) {
		if (!line.startsWith("tools:")) continue;
		return line
			.slice("tools:".length)
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.startsWith("ext:"))
			.map((entry) => entry.slice("ext:".length))
			.filter((entry) => entry.includes("/"))
			.map((entry) => entry.slice(entry.indexOf("/") + 1).trim())
			.filter(Boolean);
	}
	return [];
}

/**
 * Compare every installed agent's `ext:` tool selectors against the tools this
 * session actually has.
 *
 * pi-subagents narrows a subagent's tools by intersecting the declared
 * selectors with the registered tool names, so a renamed or removed upstream
 * tool silently contributes nothing instead of failing. An empty `known` set is
 * treated as "cannot compare" rather than "everything is missing", so a
 * surprising tool registry can never produce a wall of false alarms.
 */
function auditAgentTools(known: Set<string>): ToolAudit {
	const missing = new Map<string, string[]>();
	const unchecked: string[] = [];
	const seen = new Set<string>();
	const compared = known.size > 0;
	let references = 0;

	for (const role of ROLE_FILES) {
		let block: string | undefined;
		try {
			block = frontmatterBlock(readFileSync(join(AGENTS_DIR, `${role}.md`), "utf8"));
		} catch {
			block = undefined;
		}
		if (!block) {
			unchecked.push(role);
			continue;
		}
		for (const tool of extToolNames(block)) {
			references += 1;
			seen.add(tool);
			if (!compared || known.has(tool)) continue;
			const roles = missing.get(tool);
			if (roles) roles.push(role);
			else missing.set(tool, [role]);
		}
	}

	return { references, unique: seen.size, missing, unchecked, compared };
}

function describeMissing(audit: ToolAudit): string {
	return [...audit.missing]
		.map(([tool, roles]) => `${tool} (${roles.join(", ")})`)
		.join("; ");
}

function hasActiveGoal(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY) continue;
		const data = entry.data as { goal?: { status?: unknown } | null } | undefined;
		return data?.goal?.status === "active";
	}
	return false;
}

function loadConfig(): {
	defaultEnabled: boolean;
	source: "file" | "absent" | "invalid";
	error?: string;
} {
	try {
		const config = JSON.parse(
			readFileSync(CONFIG_PATH, "utf8"),
		) as OrchestratorConfig | null;
		if (!config || typeof config !== "object" || Array.isArray(config)) {
			return {
				defaultEnabled: false,
				source: "invalid",
				error: `Expected a JSON object in ${CONFIG_PATH}`,
			};
		}
		if (
			config.defaultEnabled !== undefined &&
			typeof config.defaultEnabled !== "boolean"
		) {
			return {
				defaultEnabled: false,
				source: "invalid",
				error: `defaultEnabled must be a boolean in ${CONFIG_PATH}`,
			};
		}
		return { defaultEnabled: config.defaultEnabled ?? false, source: "file" };
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return { defaultEnabled: false, source: "absent" };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			defaultEnabled: false,
			source: "invalid",
			error: `Unable to read orchestrator config at ${CONFIG_PATH}: ${message}`,
		};
	}
}

export default function orchestratorModeExtension(pi: ExtensionAPI) {
	const loaded = loadPolicy(POLICY_PATH, "Orchestrator policy");
	const loadedGoalPolicy = loadPolicy(GOAL_POLICY_PATH, "Orchestrator Goal policy");
	const config = loadConfig();
	let enabled = config.defaultEnabled;
	let explicitState = false;

	const audit = () => auditAgentTools(new Set(pi.getAllTools().map((t) => t.name)));

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, enabled ? "orchestrator: ON" : undefined);
	};

	const notify = (
		ctx: ExtensionContext,
		message: string,
		level: "info" | "warning" | "error" = "info",
	) => {
		if (!ctx.hasUI) return;
		ctx.ui.notify(message, level);
	};

	const modeSource = (): string => {
		// Not "from defaultEnabled" when the policy failed to load: the mode is off
		// because it was forced off, and a diagnostic must not misattribute that.
		//
		// This branch is deliberately uncovered by tests. POLICY_PATH resolves next
		// to this file, so forcing a load failure would mean mutating a repository
		// file from a test run. Covering it properly means making the policy path
		// injectable, which is only worth doing alongside tests for the fail-closed
		// guards below that share the same blind spot.
		if (!loaded.policy) return "forced off, core policy unavailable";
		return explicitState ? "explicit in this session branch" : "from defaultEnabled";
	};

	const report = (): string[] => {
		const lines = [
			`mode: ${enabled ? "on" : "off"} (${modeSource()})`,
			`core policy: ${
				loaded.policy
					? `loaded, ${loaded.policy.length} chars`
					: `unavailable — ${loaded.error}`
			}`,
			`goal policy: ${
				loadedGoalPolicy.policy
					? `loaded, ${loadedGoalPolicy.policy.length} chars`
					: `unavailable — ${loadedGoalPolicy.error}`
			}`,
			`defaultEnabled: ${config.defaultEnabled} (${
				config.error ?? `orchestrator-mode.json ${config.source}`
			})`,
		];

		const result = audit();
		lines.push(
			`agent files: ${ROLE_FILES.length - result.unchecked.length}/${
				ROLE_FILES.length
			} readable in ${AGENTS_DIR}${
				result.unchecked.length ? ` — unchecked: ${result.unchecked.join(", ")}` : ""
			}`,
		);

		if (!result.compared) {
			lines.push("ext tool references: not compared, this session reports no tools");
		} else {
			lines.push(
				`ext tool references: ${result.references} across ${result.unique} unique names — ${
					result.missing.size ? `MISSING ${describeMissing(result)}` : "all present"
				}`,
			);
		}

		return lines;
	};

	const restoreState = (ctx: ExtensionContext) => {
		enabled = config.defaultEnabled;
		explicitState = false;

		if (config.error)
			notify(
				ctx,
				`${config.error}; using false as the global default.`,
				"warning",
			);

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const data = entry.data as Partial<OrchestratorState> | undefined;
			if (typeof data?.enabled !== "boolean") continue;
			enabled = data.enabled;
			explicitState = true;
		}

		if (enabled && !loaded.policy) {
			enabled = false;
			notify(
				ctx,
				loaded.error ?? "Orchestrator policy is unavailable; mode remains off.",
				"error",
			);
		}

		updateStatus(ctx);
	};

	const setEnabled = (next: boolean, ctx: ExtensionContext) => {
		if (next && !loaded.policy) {
			enabled = false;
			updateStatus(ctx);
			notify(
				ctx,
				loaded.error ?? "Orchestrator policy is unavailable; mode remains off.",
				"error",
			);
			return;
		}

		if (enabled === next) {
			updateStatus(ctx);
			notify(ctx, `Orchestrator mode is already ${enabled ? "on" : "off"}.`);
			return;
		}

		enabled = next;
		explicitState = true;
		pi.appendEntry(STATE_ENTRY, { enabled } satisfies OrchestratorState);
		updateStatus(ctx);
		notify(ctx, `Orchestrator mode ${enabled ? "enabled" : "disabled"}.`);
	};

	pi.registerCommand("orchestrator", {
		description: "Toggle or inspect OMO-slim-style orchestrator mode",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			switch (action) {
				case "":
					setEnabled(!enabled, ctx);
					return;
				case "on":
					setEnabled(true, ctx);
					return;
				case "off":
					setEnabled(false, ctx);
					return;
				case "status":
					updateStatus(ctx);
					notify(ctx, `Orchestrator mode is ${enabled ? "on" : "off"}.`);
					return;
				case "doctor":
					notify(ctx, report().join("\n"));
					return;
				default:
					notify(ctx, "Usage: /orchestrator [on|off|status|doctor]", "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);

		// Only confirmed problems are surfaced here. Missing agent files are normal
		// outside an installed configuration, so they stay silent until /orchestrator
		// doctor asks for them.
		const result = audit();
		if (result.missing.size)
			notify(
				ctx,
				`Agent tool selectors reference tools this session does not provide: ${describeMissing(
					result,
				)}. Those roles run without them. Run /orchestrator doctor for details.`,
				"warning",
			);
	});
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || !loaded.policy) return;
		const goalPolicy = hasActiveGoal(ctx) ? loadedGoalPolicy.policy : undefined;
		return {
			systemPrompt: [event.systemPrompt, loaded.policy, goalPolicy]
				.filter((part): part is string => Boolean(part))
				.join("\n\n"),
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
