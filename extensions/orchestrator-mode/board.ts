import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The lane board: a read-only view of top-level pi-subagents activity.
 *
 * It subscribes to the lifecycle events pi-subagents emits on the shared
 * `pi.events` bus (`subagents:created` / `:started` / `:completed` / `:failed`
 * / `:steered`) and renders them as `/lanes`. The board never spawns, steers,
 * or consumes anything — it is an observer, so upstream changes to dispatch
 * cannot conflict with it.
 *
 * Two sources with distinct authorities:
 *
 * - The event bus builds the board's history. Events carry no session id, so
 *   the board is a per-activation, process-local view: each session activation
 *   (including every child subagent session, which also loads extensions)
 *   gets its own board instance. Duplicate child boards are accepted — they
 *   are never rendered — and every board unsubscribes on session_shutdown.
 * - The `Symbol.for("pi-subagents:manager")` in-process registry is the
 *   liveness authority at render time. A lane the board still shows as active
 *   but the registry cannot produce (evicted, or already terminal) is exactly
 *   the "execution ended without a terminal event" case worth surfacing.
 *
 * Known limits, accepted for this slice: nested subagents emit no events and
 * stay invisible (they report through their owner); records are evicted
 * roughly ten minutes after completion, so `resultConsumed` is only readable
 * while the record lives; the board starts empty and does not rehydrate from
 * the `subagents:record` session entries pi-subagents persists.
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
	status?: unknown;
	resultConsumed?: unknown;
};

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
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
	/**
	 * Overrides the default registry lookup. The default reads
	 * `Symbol.for("pi-subagents:manager")` from globalThis and returns
	 * undefined for anything absent or throwing — the board must survive a
	 * foreign in-process interface changing shape underneath it.
	 */
	registryLookup?: (id: string) => RegistryRecord | undefined;
};

function lookupRegistryRecord(id: string): RegistryRecord | undefined {
	const registry = managerRegistry();
	if (typeof registry?.getRecord !== "function") return undefined;
	try {
		return asRecord(registry.getRecord(id));
	} catch {
		return undefined;
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
		// `created` fires for a fresh background spawn and for a detached
		// resume. For an already-tracked lane it only fills gaps: the status
		// is owned by started/completed/failed and must never regress here.
		ensureLane(id, type, description);
	}

	function onStarted(id: string, type?: string, description?: string): void {
		const lane = ensureLane(id, type, description);
		// Terminal is final: a started for an already-terminal lane is a late
		// event for a finished run, not a revival (a resume introduces a new
		// record, which starts over at created).
		if (TERMINAL_STATUSES.has(lane.status)) return;
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
		const duration = asNumber(payload.durationMs);
		if (duration !== undefined) lane.durationMs = duration;
		const tokens = asRecord(payload.tokens);
		const total = asNumber(tokens?.total);
		if (total !== undefined) lane.tokensTotal = total;
		const result = firstLine(asString(payload.result), 40);
		if (result) lane.resultPreview = result;
		const error = firstLine(asString(payload.error), 40);
		if (error) lane.error = error;
	}

	function onSteered(id: string): void {
		// A steer can reference an agent the board never saw (RPC, scheduler,
		// or @handle spawns are first visible at `started`, and a queued steer
		// fires before the agent runs). The lane is created so the steering is
		// not silently dropped; the render-time registry cross-check corrects
		// an inaccurate status. The steer text itself stays in the parent
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

	/**
	 * Cross-check one lane against the registry. Only disagrees with the
	 * board's own status when the disagreement is informative: an active lane
	 * the registry cannot confirm, either direction of a terminal/active
	 * mismatch, or a terminal record whose result nobody fetched.
	 */
	function laneAnnotations(lane: Lane): string[] {
		const notes: string[] = [];
		const boardTerminal = TERMINAL_STATUSES.has(lane.status);
		const record = lookup(lane.id);

		if (record === undefined) {
			if (!boardTerminal) {
				notes.push("⚠ no live record — finished or evicted without a terminal event");
			}
		} else {
			const registryStatus = asString(record.status);
			if (registryStatus && !boardTerminal && TERMINAL_STATUSES.has(registryStatus)) {
				notes.push(`⚠ registry says ${registryStatus}; terminal event not seen`);
			} else if (
				registryStatus &&
				boardTerminal &&
				!TERMINAL_STATUSES.has(registryStatus)
			) {
				notes.push(`⚠ registry says ${registryStatus} — resumed?`);
			}
			if (boardTerminal && record.resultConsumed === true) {
				notes.push("result fetched via get_subagent_result");
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
			`lane board: ${list.length} tracked — ${active.length} active, ${finished.length} finished`,
			"",
		];

		for (const lane of [...active, ...finished]) {
			const icon = STATUS_ICONS[lane.status];
			const elapsed = laneElapsed(lane, now);
			const elapsedText = elapsed === undefined ? "  ?  " : formatDuration(elapsed).padStart(5);
			const head = `  ${truncate(lane.type, 12).padEnd(12)} ${icon} ${lane.status.padEnd(9)} ${elapsedText}  ${truncate(lane.description, 44)}`;
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
		return `lane board: ${lanes.size} lane(s) tracked — ${active} active, ${lanes.size - active} finished`;
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

	const unsubscribers = BOARD_CHANNELS.map((channel) =>
		pi.events.on(channel, (data) => board.handleEvent(channel, data)),
	);
	// Child sessions load extensions too, so each spawned subagent creates a
	// board instance; session_shutdown is where those duplicates let go of the
	// process-wide bus.
	pi.on("session_shutdown", async () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
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
