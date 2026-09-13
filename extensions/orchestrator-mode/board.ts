import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Read-only, per-activation history of top-level pi-subagents lifecycle events.
 * `/lanes` displays event states alongside on-demand registry observations.
 * A missing/unavailable registry is uncertainty, not proof a run has stopped.
 * This module neither detects stalled work nor supplies state to the model.
 *
 * A resumed in-memory agent reuses its ID. We retain the latest observed run
 * for each ID, not a history of all its runs. Nested/workflow-owned agents emit
 * no lifecycle events. No history is rehydrated after reload or session change.
 */

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** Mirrors the status values of pi-subagents' AgentRecord. */
type LaneStatus =
	| "queued"
	| "running"
	| "completed"
	| "steered"
	| "aborted"
	| "stopped"
	| "error";

const TERMINAL_STATUSES = new Set<string>([
	"completed",
	"steered",
	"aborted",
	"stopped",
	"error",
]);

const STATUS_ICONS: Record<LaneStatus, string> = {
	queued: "○",
	running: "●",
	completed: "✓",
	steered: "↪",
	aborted: "■",
	stopped: "■",
	error: "✗",
};

type Lane = {
	id: string;
	type: string;
	description: string;
	status: LaneStatus;
	/** Local clock at the moment the introducing event arrived; the bus carries no timestamps. */
	createdSeenAt?: number;
	startedSeenAt?: number;
	/** Local clock at the terminal event; the payload's durationMs is preferred when present. */
	endedAt?: number;
	/** Authoritative run length from the terminal payload, when present. */
	durationMs?: number;
	tokensTotal?: number;
	steers: number;
	resultPreview?: string;
	error?: string;
};

/** The subset of the registry's AgentRecord the board reads. */
type RegistryRecord = {
	status: LaneStatus;
	resultConsumed?: unknown;
};

// Preserve why a lookup could not establish a current status.
type RegistryObservation =
	| { kind: "record"; record: RegistryRecord }
	| { kind: "unavailable" | "missing" | "error" | "invalid" };

type ManagerRegistry = {
	getRecord?: (id: string) => unknown;
};

function managerRegistry(): ManagerRegistry | undefined {
	try {
		const entry = (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
		return typeof entry === "object" && entry !== null
			? (entry as ManagerRegistry)
			: undefined;
	} catch {
		return undefined;
	}
}

// --- Payload narrowing -------------------------------------------------------
// The event bus delivers `unknown`. A payload that does not shape up is
// ignored rather than crashed on: a future upstream payload change must
// degrade the board's display, never break the session.

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/** First non-empty line, whitespace-collapsed, truncated with an ellipsis. */
function firstLine(text: string | undefined, max: number): string | undefined {
	if (!text) return undefined;
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\s+/g, " ").trim();
		if (!line) continue;
		return line.length > max ? `${line.slice(0, max - 1)}…` : line;
	}
	return undefined;
}

// --- Formatting --------------------------------------------------------------

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTokens(total: number): string {
	return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`;
}

function truncate(text: string, max: number): string {
	const wide = [...text];
	return wide.length > max ? `${wide.slice(0, max - 1).join("")}…` : text;
}

// --- Board core --------------------------------------------------------------

export type LaneBoard = {
	/** Feed one bus event into the board. Unknown channels are ignored. */
	handleEvent: (channel: string, data: unknown) => void;
	/** Number of lanes tracked. */
	size: () => number;
	/** Render the /lanes view as of `now`. */
	render: (now: number) => string;
	/** One-line state summary for /orchestrator doctor. */
	summarize: () => string;
};

export type BoardOptions = {
	/** Read-only observation source; tests can supply a registry without Pi. */
	registryLookup?: (id: string) => RegistryObservation;
};

function lookupRegistryRecord(id: string): RegistryObservation {
	try {
		const registry = managerRegistry();
		if (typeof registry?.getRecord !== "function") return { kind: "unavailable" };
		const raw = registry.getRecord(id);
		if (raw === undefined) return { kind: "missing" };
		const record = asRecord(raw);
		const status = asString(record?.status);
		if (!record || !status || !Object.hasOwn(STATUS_ICONS, status)) {
			return { kind: "invalid" };
		}
		return {
			kind: "record",
			record: { status: status as LaneStatus, resultConsumed: record.resultConsumed },
		};
	} catch {
		return { kind: "error" };
	}
}

export function createBoard(options: BoardOptions = {}): LaneBoard {
	const lanes = new Map<string, Lane>();
	const lookup = options.registryLookup ?? lookupRegistryRecord;

	function laneElapsed(lane: Lane, now: number): number | undefined {
		if (lane.durationMs !== undefined) return lane.durationMs;
		if (lane.endedAt !== undefined) {
			const from = lane.startedSeenAt ?? lane.createdSeenAt;
			if (from !== undefined) return lane.endedAt - from;
			return undefined;
		}
		const from = lane.startedSeenAt ?? lane.createdSeenAt;
		return from === undefined ? undefined : Math.max(0, now - from);
	}

	function ensureLane(id: string, type?: string, description?: string): Lane {
		let lane = lanes.get(id);
		if (lane) {
			if (type) lane.type = type;
			if (description) lane.description = description;
			return lane;
		}
		lane = {
			id,
			type: type ?? "(unknown)",
			description: description ?? "(unknown)",
			status: "queued",
			createdSeenAt: Date.now(),
			steers: 0,
		};
		lanes.set(id, lane);
		return lane;
	}

	function onCreated(id: string, type?: string, description?: string): void {
		const lane = ensureLane(id, type, description);
		if (!TERMINAL_STATUSES.has(lane.status)) return;
		// A queued resume emits created before started; an immediate resume
		// emits created after started (and can already have failed by then).
		// For an existing terminal lane, require a live record to disambiguate.
		const observation = lookup(id);
		if (observation.kind !== "record" || TERMINAL_STATUSES.has(observation.record.status)) return;
		lanes.delete(id);
		const resumed = ensureLane(id, lane.type, lane.description);
		resumed.status = observation.record.status;
		if (resumed.status === "running") resumed.startedSeenAt = Date.now();
	}

	function onStarted(id: string, type?: string, description?: string): void {
		let lane = ensureLane(id, type, description);
		if (TERMINAL_STATUSES.has(lane.status)) {
			lanes.delete(id);
			lane = ensureLane(id, lane.type, lane.description);
		}
		lane.status = "running";
		if (lane.startedSeenAt === undefined) lane.startedSeenAt = Date.now();
	}

	function onTerminal(
		id: string,
		payload: Record<string, unknown>,
		fallbackStatus: LaneStatus,
	): void {
		const lane = ensureLane(
			id,
			asString(payload.type),
			asString(payload.description),
		);
		const payloadStatus = asString(payload.status);
		lane.status =
			payloadStatus && TERMINAL_STATUSES.has(payloadStatus)
				? (payloadStatus as LaneStatus)
				: fallbackStatus;
		lane.endedAt = Date.now();
		lane.durationMs = asNumber(payload.durationMs);
		lane.tokensTotal = asNumber(asRecord(payload.tokens)?.total);
		lane.resultPreview = firstLine(asString(payload.result), 40);
		lane.error = firstLine(asString(payload.error), 40);
	}

	function onSteered(id: string): void {
		// A steer can reference an agent the board never saw (RPC, scheduler,
		// or @handle spawns are first visible at `started`, and a queued steer
		// fires before the agent runs). The lane is created so the steering is
		// not silently dropped; the render-time registry cross-check reports
		// any status disagreement. The steer text itself stays in the parent
		// conversation — the board records only that it happened.
		ensureLane(id).steers += 1;
	}

	function handleEvent(channel: string, data: unknown): void {
		const event = asRecord(data);
		const id = asString(event?.id);
		// steered carries no type/description; every other channel needs an id
		// to be about anything.
		if (channel === "subagents:steered") {
			if (id) onSteered(id);
			return;
		}
		if (!event || !id) return;
		switch (channel) {
			case "subagents:created":
				onCreated(id, asString(event.type), asString(event.description));
				return;
			case "subagents:started":
				onStarted(id, asString(event.type), asString(event.description));
				return;
			case "subagents:completed":
				onTerminal(id, event, "completed");
				return;
			case "subagents:failed":
				onTerminal(id, event, "error");
				return;
			default:
				return;
		}
	}

	/** Compare observations without treating notification consumption as acceptance. */
	function laneAnnotations(lane: Lane): string[] {
		const notes: string[] = [];
		const boardTerminal = TERMINAL_STATUSES.has(lane.status);
		const observation = lookup(lane.id);

		if (observation.kind !== "record") {
			if (!boardTerminal) {
				const reason = {
					unavailable: "registry unavailable",
					missing: "agent record not found",
					error: "registry lookup failed",
					invalid: "invalid registry record",
				}[observation.kind];
				notes.push(`⚠ status unknown: ${reason}`);
			}
		} else {
			const record = observation.record;
			if (record.status !== lane.status) {
				notes.push(`⚠ registry says ${record.status}; event state is ${lane.status}`);
			}
			if (boardTerminal && TERMINAL_STATUSES.has(record.status) && record.resultConsumed === true) {
				notes.push("notification consumption recorded (not acceptance)");
			}
		}

		if (lane.steers > 0) notes.push(`steered ×${lane.steers}`);
		if (lane.tokensTotal !== undefined && boardTerminal) {
			notes.push(formatTokens(lane.tokensTotal));
		}
		if (lane.error) notes.push(`error: ${lane.error}`);
		else if (lane.resultPreview) notes.push(`→ ${lane.resultPreview}`);
		return notes;
	}

	function render(now: number): string {
		if (lanes.size === 0) return "No subagent activity tracked yet in this session.";

		const list = [...lanes.values()];
		const active = list.filter((lane) => !TERMINAL_STATUSES.has(lane.status));
		const finished = list.filter((lane) => TERMINAL_STATUSES.has(lane.status));

		const lines = [
			`lane board: ${list.length} tracked — ${active.length} active, ${finished.length} finished (event states)`,
			"",
		];

		for (const lane of [...active, ...finished]) {
			const icon = STATUS_ICONS[lane.status];
			const elapsed = laneElapsed(lane, now);
			const elapsedText = elapsed === undefined ? "  ?  " : formatDuration(elapsed).padStart(5);
			const head = `  [${lane.id}] ${truncate(lane.type, 12).padEnd(12)} ${icon} ${lane.status.padEnd(9)} ${elapsedText}  ${truncate(lane.description, 44)}`;
			const notes = laneAnnotations(lane);
			lines.push(notes.length ? `${head}  · ${notes.join(" · ")}` : head);
		}

		return lines.join("\n");
	}

	function summarize(): string {
		if (lanes.size === 0) return "lane board: no activity tracked yet";
		const active = [...lanes.values()].filter(
			(lane) => !TERMINAL_STATUSES.has(lane.status),
		).length;
		return `lane board: ${lanes.size} lane(s) tracked — ${active} active, ${lanes.size - active} finished (event states)`;
	}

	return { handleEvent, size: () => lanes.size, render, summarize };
}

// --- Extension wiring --------------------------------------------------------

const BOARD_CHANNELS = [
	"subagents:created",
	"subagents:started",
	"subagents:completed",
	"subagents:failed",
	"subagents:steered",
] as const;

/**
 * Register the lane board on a session: bus subscriptions, the /lanes command,
 * and shutdown cleanup. Returns the doctor-facing summary handle.
 */
export function registerBoard(pi: ExtensionAPI): { summarize: () => string } {
	const board = createBoard();

	let unsubscribers: Array<() => void> = [];
	// Factories may run for extensions that are later filtered out. Only a
	// bound session should own bus subscriptions, and rebinding is idempotent.
	pi.on("session_start", async () => {
		if (unsubscribers.length) return;
		unsubscribers = BOARD_CHANNELS.map((channel) =>
			pi.events.on(channel, (data) => board.handleEvent(channel, data)),
		);
	});
	pi.on("session_shutdown", async () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
		unsubscribers = [];
	});

	pi.registerCommand("lanes", {
		description: "Show tracked specialist lanes (pi-subagents activity board)",
		handler: async (args, ctx) => {
			if (args.trim()) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /lanes", "warning");
				return;
			}
			if (!ctx.hasUI) return;
			if (board.size() === 0 && !subagentsPresent(pi)) {
				ctx.ui.notify(
					"No subagent activity tracked. pi-subagents does not appear to be active in this session, so there are no agents to track.",
				);
				return;
			}
			ctx.ui.notify(board.render(Date.now()));
		},
	});

	return { summarize: board.summarize };
}

function subagentsPresent(pi: ExtensionAPI): boolean {
	if (managerRegistry() !== undefined) return true;
	return pi.getAllTools().some((tool) => tool.name === "Agent");
}
