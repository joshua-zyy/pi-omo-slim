import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createBoard,
	registerBoard,
} from "../extensions/orchestrator-mode/board.ts";

// The board reads the pi-subagents manager registry from globalThis; keep the
// test process's slot empty so lookups exercise the absent-registry paths.
const MANAGER_KEY = Symbol.for("pi-subagents:manager");
delete globalThis[MANAGER_KEY];

function createBus() {
	const handlers = new Map();
	return {
		on(channel, handler) {
			let list = handlers.get(channel);
			if (!list) handlers.set(channel, (list = []));
			list.push(handler);
			return () => {
				const current = handlers.get(channel);
				const index = current ? current.indexOf(handler) : -1;
				if (index !== -1) current.splice(index, 1);
			};
		},
		emit(channel, data) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		subscriberCount: (channel) => (handlers.get(channel) ?? []).length,
	};
}

function createHarness(options = {}) {
	const bus = createBus();
	const piHandlers = new Map();
	const commands = new Map();
	const notifications = [];
	const pi = {
		on(event, handler) {
			piHandlers.set(event, handler);
		},
		events: bus,
		registerCommand(name, config) {
			commands.set(name, config);
		},
		getAllTools() {
			return (options.tools ?? ["read", "Agent"]).map((name) => ({ name }));
		},
	};
	const context = {
		hasUI: true,
		ui: {
			notify: (message, level = "info") => notifications.push({ message, level }),
		},
	};
	const board = registerBoard(pi);
	return {
		board,
		bus,
		notifications,
		command: (args = "") => commands.get("lanes").handler(args, context),
		shutdown: () => piHandlers.get("session_shutdown")({}, context),
	};
}

const feed = (board, channel, data) => board.handleEvent(channel, data);

test("empty board renders the idle message and summary", () => {
	const board = createBoard();
	assert.equal(
		board.render(0),
		"No subagent activity tracked yet in this session.",
	);
	assert.equal(board.size(), 0);
	assert.equal(board.summarize(), "lane board: no activity tracked yet");
});

test("created → started → completed lifecycle with payload stats", () => {
	const board = createBoard();

	feed(board, "subagents:created", {
		id: "a1",
		type: "fixer",
		description: "fix rollback race",
		isBackground: true,
	});
	feed(board, "subagents:started", {
		id: "a1",
		type: "fixer",
		description: "fix rollback race",
	});

	let text = board.render(Date.now() + 1000);
	assert.match(text, /lane board: 1 tracked — 1 active, 0 finished/);
	assert.match(text, /fixer\s+● running/);
	assert.match(text, /fix rollback race/);

	feed(board, "subagents:completed", {
		id: "a1",
		type: "fixer",
		description: "fix rollback race",
		status: "completed",
		durationMs: 31000,
		tokens: { input: 100, output: 50, total: 150 },
		toolUses: 3,
		result: "Fixed in scripts/install.mjs\nAll tests pass",
	});

	text = board.render(Date.now() + 2000);
	assert.match(text, /1 tracked — 0 active, 1 finished/);
	assert.match(text, /✓ completed/);
	assert.match(text, /31s/);
	assert.match(text, /150 tok/);
	assert.match(text, /→ Fixed in scripts\/install\.mjs/);
	assert.match(board.summarize(), /1 lane\(s\) tracked — 0 active, 1 finished/);
});

test("failed with status stopped renders the stopped lane and error", () => {
	const board = createBoard();
	feed(board, "subagents:started", {
		id: "a1",
		type: "oracle",
		description: "review plan data structure",
	});
	feed(board, "subagents:failed", {
		id: "a1",
		type: "oracle",
		description: "review plan data structure",
		status: "stopped",
		error: "generation stopped by user",
		durationMs: 1000,
	});
	const text = board.render(Date.now());
	assert.match(text, /■ stopped/);
	assert.match(text, /error: generation stopped by user/);
});

test("failed without a terminal status falls back to error", () => {
	const board = createBoard();
	feed(board, "subagents:failed", { id: "a1", type: "fixer", description: "d", error: "boom" });
	assert.match(board.render(Date.now()), /✗ error/);
});

test("completed with an unknown status string falls back to completed", () => {
	const board = createBoard();
	feed(board, "subagents:completed", { id: "a1", type: "fixer", description: "d", status: "???future???" });
	assert.match(board.render(Date.now()), /✓ completed/);
});

test("a late started for a terminal lane does not revive it", () => {
	const board = createBoard();
	feed(board, "subagents:started", { id: "a1", type: "fixer", description: "d" });
	feed(board, "subagents:completed", { id: "a1", status: "completed", durationMs: 100 });
	feed(board, "subagents:started", { id: "a1", type: "fixer", description: "d" });
	const text = board.render(Date.now());
	assert.match(text, /0 active, 1 finished/);
	assert.match(text, /✓ completed/);
});

test("steers are counted, including for agents the board never saw", () => {
	const board = createBoard();
	feed(board, "subagents:started", { id: "a1", type: "fixer", description: "known lane" });
	feed(board, "subagents:steered", { id: "a1", message: "focus on the parser" });
	feed(board, "subagents:steered", { id: "ghost", message: "queued steer before start" });

	const text = board.render(Date.now());
	assert.match(text, /2 tracked — 2 active/);
	// Each lane shows its own count; the unseen agent becomes a lane rather than
	// dropping the steer silently. The default registry lookup finds no
	// registry in this process, so a liveness warning may sit between the
	// description and the steer count — `.` stays within the line.
	assert.match(text, /known lane.*· steered ×1/);
	assert.match(text, /\(unknown\).*steered ×1/);
});

test("malformed or unidentified payloads are ignored", () => {
	const board = createBoard();
	feed(board, "subagents:started", null);
	feed(board, "subagents:started", "a string");
	feed(board, "subagents:started", { type: "fixer", description: "no id" });
	feed(board, "subagents:created", { id: "", type: "fixer", description: "empty id" });
	feed(board, "subagents:steered", { message: "no id either" });
	feed(board, "some:other:channel", { id: "a1", type: "fixer", description: "d" });
	assert.equal(board.size(), 0);
});

test("elapsed falls back to local clock difference when durationMs is absent", () => {
	const realNow = Date.now;
	let clock = 1_000_000;
	Date.now = () => clock;
	try {
		const board = createBoard();
		feed(board, "subagents:started", { id: "a1", type: "fixer", description: "d" });
		clock += 5000;
		feed(board, "subagents:completed", { id: "a1", status: "completed" });
		// No durationMs in the payload: endedAt - startedSeenAt decides.
		assert.match(board.render(clock), /5s/);
	} finally {
		Date.now = realNow;
	}
});

test("liveness cross-check against the registry", () => {
	const records = new Map();
	const board = createBoard({ registryLookup: (id) => records.get(id) });
	feed(board, "subagents:started", { id: "r1", type: "oracle", description: "review plan" });

	// Board running, registry agrees: no warning.
	records.set("r1", { status: "running" });
	let text = board.render(Date.now());
	assert.doesNotMatch(text, /⚠/);

	// Board running, registry already terminal: the terminal event was missed.
	records.set("r1", { status: "stopped" });
	text = board.render(Date.now());
	assert.match(text, /⚠ registry says stopped; terminal event not seen/);

	// Board running, no record at all: evicted or gone without a terminal event.
	records.delete("r1");
	text = board.render(Date.now());
	assert.match(text, /⚠ no live record/);

	// Board terminal, registry running again: a resumed run the events did not
	// re-introduce (a resume starts a new record).
	feed(board, "subagents:completed", { id: "r1", status: "completed", durationMs: 1000 });
	records.set("r1", { status: "running" });
	text = board.render(Date.now());
	assert.match(text, /⚠ registry says running — resumed\?/);

	// Board terminal, registry terminal, result fetched by the parent tool:
	// surfaced so a missing completion notification is explainable.
	records.set("r1", { status: "completed", resultConsumed: true });
	text = board.render(Date.now());
	assert.doesNotMatch(text, /⚠/);
	assert.match(text, /result fetched via get_subagent_result/);
});

test("liveness annotations need no registry at all", () => {
	const board = createBoard({ registryLookup: () => undefined });
	feed(board, "subagents:started", { id: "a1", type: "fixer", description: "d" });
	assert.match(board.render(Date.now()), /⚠ no live record/);
});

test("registerBoard wires the /lanes command to the bus", async () => {
	const harness = createHarness();
	assert.equal(harness.bus.subscriberCount("subagents:started"), 1);
	assert.equal(harness.bus.subscriberCount("subagents:steered"), 1);

	await harness.command();
	assert.match(harness.notifications[0].message, /No subagent activity tracked yet/);

	harness.bus.emit("subagents:started", { id: "w1", type: "fixer", description: "wire check" });
	await harness.command();
	assert.match(harness.notifications[1].message, /1 tracked — 1 active/);
	assert.match(harness.notifications[1].message, /fixer/);
});

test("registerBoard warns on arguments and reports summary", async () => {
	const harness = createHarness();
	await harness.command("clear");
	assert.equal(harness.notifications[0].level, "warning");
	assert.match(harness.notifications[0].message, /Usage: \/lanes/);
	assert.match(harness.board.summarize(), /no activity tracked yet/);
});

test("empty board with no Agent tool and no registry explains the absence", async () => {
	assert.equal(globalThis[MANAGER_KEY], undefined, "registry must stay unset in this process");
	const harness = createHarness({ tools: ["read"] });
	await harness.command();
	assert.match(
		harness.notifications[0].message,
		/pi-subagents does not appear to be active/,
	);
});

test("session_shutdown unsubscribes the board from the bus", async () => {
	const harness = createHarness();
	assert.equal(harness.bus.subscriberCount("subagents:completed"), 1);
	await harness.shutdown();
	assert.equal(harness.bus.subscriberCount("subagents:completed"), 0);
	assert.equal(harness.bus.subscriberCount("subagents:started"), 0);
});
