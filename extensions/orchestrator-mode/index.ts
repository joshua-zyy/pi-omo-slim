import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY = "orchestrator-mode";
const STATUS_KEY = "orchestrator-mode";
const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "orchestrator-policy.md");

type OrchestratorState = {
	enabled: boolean;
};

function loadPolicy(): { policy?: string; error?: string } {
	try {
		const policy = readFileSync(POLICY_PATH, "utf8").trim();
		if (!policy) {
			return { error: `Orchestrator policy is empty: ${POLICY_PATH}` };
		}
		return { policy };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `Unable to read orchestrator policy at ${POLICY_PATH}: ${message}` };
	}
}

export default function orchestratorModeExtension(pi: ExtensionAPI) {
	const loaded = loadPolicy();
	let enabled = false;

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, enabled ? "orchestrator: ON" : undefined);
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (!ctx.hasUI) return;
		ctx.ui.notify(message, level);
	};

	const restoreState = (ctx: ExtensionContext) => {
		enabled = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const data = entry.data as Partial<OrchestratorState> | undefined;
			if (typeof data?.enabled === "boolean") enabled = data.enabled;
		}

		if (enabled && !loaded.policy) {
			enabled = false;
			notify(ctx, loaded.error ?? "Orchestrator policy is unavailable; mode remains off.", "error");
		}

		updateStatus(ctx);
	};

	const setEnabled = (next: boolean, ctx: ExtensionContext) => {
		if (next && !loaded.policy) {
			enabled = false;
			updateStatus(ctx);
			notify(ctx, loaded.error ?? "Orchestrator policy is unavailable; mode remains off.", "error");
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

	pi.on("before_agent_start", async (event) => {
		if (!enabled || !loaded.policy) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${loaded.policy}`,
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
