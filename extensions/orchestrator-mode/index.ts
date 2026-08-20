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

type OrchestratorState = {
	enabled: boolean;
};

type OrchestratorConfig = {
	defaultEnabled?: boolean;
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

function loadConfig(): { defaultEnabled: boolean; error?: string } {
	try {
		const config = JSON.parse(
			readFileSync(CONFIG_PATH, "utf8"),
		) as OrchestratorConfig | null;
		if (!config || typeof config !== "object" || Array.isArray(config)) {
			return {
				defaultEnabled: false,
				error: `Expected a JSON object in ${CONFIG_PATH}`,
			};
		}
		if (
			config.defaultEnabled !== undefined &&
			typeof config.defaultEnabled !== "boolean"
		) {
			return {
				defaultEnabled: false,
				error: `defaultEnabled must be a boolean in ${CONFIG_PATH}`,
			};
		}
		return { defaultEnabled: config.defaultEnabled ?? false };
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return { defaultEnabled: false };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			defaultEnabled: false,
			error: `Unable to read orchestrator config at ${CONFIG_PATH}: ${message}`,
		};
	}
}

export default function orchestratorModeExtension(pi: ExtensionAPI) {
	const loaded = loadPolicy(POLICY_PATH, "Orchestrator policy");
	const loadedGoalPolicy = loadPolicy(GOAL_POLICY_PATH, "Orchestrator Goal policy");
	const config = loadConfig();
	let enabled = config.defaultEnabled;

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

	const restoreState = (ctx: ExtensionContext) => {
		enabled = config.defaultEnabled;

		if (config.error)
			notify(
				ctx,
				`${config.error}; using false as the global default.`,
				"warning",
			);

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const data = entry.data as Partial<OrchestratorState> | undefined;
			if (typeof data?.enabled === "boolean") enabled = data.enabled;
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
				default:
					notify(ctx, "Usage: /orchestrator [on|off|status]", "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
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
