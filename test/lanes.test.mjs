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
		start: () => piHandlers.get("session_start")({}, context),
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

test("same-ID immediate resume resets the run; created after started does not requeue it", (t) => {
	let clock = 1_000_000;
	t.mock.method(Date, "now", () => clock);
	const board = createBoard({ registryLookup: () => ({ kind: "record", record: { status: "running" } }) });
	const agent = { id: "a1", type: "fixer", description: "retry" };
	feed(board, "subagents:started", agent);
	feed(board, "subagents:steered", { id: "a1" });
	feed(board, "subagents:failed", { ...agent, status: "error", durationMs: 100, error: "old error", result: "old result", tokens: { total: 1234 } });
	clock += 60_000;
	// pi-subagents startResume emits started before resumeDetached emits created.
	feed(board, "subagents:started", agent);
	feed(board, "subagents:created", agent);
	clock += 5_000;
	const text = board.render(clock);
	assert.match(text, /1 active, 0 finished/);
	assert.match(text, /● running\s+5s/);
	assert.doesNotMatch(text, /old error|old result|1\.2k tok|steered ×1|⚠/);
	assert.match(board.summarize(), /1 active, 0 finished/);
	feed(board, "subagents:completed", { ...agent, status: "completed", result: "retry succeeded", durationMs: 5000 });
	assert.match(board.render(clock), /retry succeeded/);
	assert.doesNotMatch(board.render(clock), /old error|old result/);
});

test("same-ID queued resume clears old data and preserves steering received in the queue", (t) => {
	let clock = 1_000_000;
	t.mock.method(Date, "now", () => clock);
	let status = "queued";
	const board = createBoard({ registryLookup: () => ({ kind: "record", record: { status } }) });
	const agent = { id: "q1", type: "fixer", description: "queued retry" };
	feed(board, "subagents:completed", { ...agent, durationMs: 1000, result: "old result" });
	clock += 60_000;
	feed(board, "subagents:created", agent);
	assert.match(board.render(clock), /○ queued/);
	assert.doesNotMatch(board.render(clock), /old result/);
	feed(board, "subagents:steered", { id: agent.id });
	clock += 5_000;
	status = "running";
	feed(board, "subagents:started", agent);
	clock += 3_000;
	feed(board, "subagents:started", agent); // duplicate must not restart the clock
	assert.match(board.render(clock), /● running\s+3s/);
	assert.match(board.render(clock), /steered ×1/);
});

test("created arriving after a fast terminal result does not invent another run", () => {
	const board = createBoard({ registryLookup: () => ({ kind: "record", record: { status: "error" } }) });
	const agent = { id: "fast", type: "fixer", description: "startup error" };
	feed(board, "subagents:started", agent);
	feed(board, "subagents:failed", { ...agent, status: "error", error: "startup failed" });
	feed(board, "subagents:created", agent);
	assert.match(board.render(Date.now()), /0 active, 1 finished/);
	assert.match(board.render(Date.now()), /startup failed/);
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

test("registry observations distinguish mismatches, missing records and notification consumption", () => {
	const records = new Map();
	const board = createBoard({ registryLookup: (id) => records.has(id)
		? { kind: "record", record: records.get(id) }
		: { kind: "missing" } });
	feed(board, "subagents:started", { id: "r1", type: "oracle", description: "review plan" });
	records.set("r1", { status: "running" });
	assert.doesNotMatch(board.render(Date.now()), /⚠/);
	records.set("r1", { status: "stopped" });
	assert.match(board.render(Date.now()), /registry says stopped; event state is running/);
	records.delete("r1");
	assert.match(board.render(Date.now()), /status unknown: agent record not found/);
	assert.doesNotMatch(board.render(Date.now()), /finished or evicted/);
	feed(board, "subagents:completed", { id: "r1", status: "completed", durationMs: 1000 });
	records.set("r1", { status: "running" });
	assert.match(board.render(Date.now()), /registry says running; event state is completed/);
	// Foreground inline results and RPC consume also set this flag. It does
	// not establish a particular delivery path, notification history or acceptance.
	records.set("r1", { status: "completed", resultConsumed: true });
	const text = board.render(Date.now());
	assert.doesNotMatch(text, /⚠/);
	assert.match(text, /notification consumption recorded \(not acceptance\)/);
	assert.doesNotMatch(text, /get_subagent_result|result fetched|notification was suppressed/);
	assert.equal(records.get("r1").resultConsumed, true);
	records.set("r1", { status: "completed", resultConsumed: false });
	assert.doesNotMatch(board.render(Date.now()), /not read|unreviewed|unconsumed/);
});

test("default registry lookup distinguishes unavailable, missing, failed and invalid observations", (t) => {
	const saved = Object.getOwnPropertyDescriptor(globalThis, MANAGER_KEY);
	t.after(() => {
		if (saved) Object.defineProperty(globalThis, MANAGER_KEY, saved);
		else delete globalThis[MANAGER_KEY];
	});
	const cases = [
		[undefined, /registry unavailable/],
		[{}, /registry unavailable/],
		[{ getRecord: () => undefined }, /agent record not found/],
		[{ getRecord: () => { throw new Error("boom"); } }, /registry lookup failed/],
		[{ getRecord: () => [] }, /invalid registry record/],
		[{ getRecord: () => ({ status: "future-status" }) }, /invalid registry record/],
	];
	for (const [registry, expected] of cases) {
		globalThis[MANAGER_KEY] = registry;
		const board = createBoard();
		feed(board, "subagents:started", { id: "a1", type: "fixer", description: "d" });
		const text = board.render(Date.now());
		assert.match(text, /status unknown/);
		assert.match(text, expected);
		assert.doesNotMatch(text, /finished or evicted|registry says stopped/);
	}
});

test("each displayed lane includes its full ID even with duplicate role and objective", () => {
	const board = createBoard();
	for (const id of ["same-prefix-one", "same-prefix-two"]) {
		feed(board, "subagents:started", { id, type: "fixer", description: "same objective" });
	}
	const text = board.render(Date.now());
	assert.match(text, /same-prefix-one/);
	assert.match(text, /same-prefix-two/);
});

test("an old running registration is not diagnosed as a stuck or stopped agent", () => {
	const board = createBoard({ registryLookup: () => ({ kind: "record", record: { status: "running" } }) });
	feed(board, "subagents:started", { id: "long", type: "fixer", description: "long task" });
	const text = board.render(Date.now() + 86_400_000);
	assert.match(text, /1 active, 0 finished/);
	assert.doesNotMatch(text, /⚠|stuck|stopped/);
});

test("registerBoard wires the /lanes command to the bus", async () => {
	const harness = createHarness();
	assert.equal(harness.bus.subscriberCount("subagents:started"), 0);
	await harness.start();
	await harness.start(); // lifecycle rebind must not double-subscribe
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
	await harness.start();
	assert.equal(harness.bus.subscriberCount("subagents:completed"), 1);
	await harness.shutdown();
	await harness.shutdown();
	assert.equal(harness.bus.subscriberCount("subagents:completed"), 0);
	assert.equal(harness.bus.subscriberCount("subagents:started"), 0);
	await harness.start();
	assert.equal(harness.bus.subscriberCount("subagents:started"), 1);
	await harness.shutdown();
});
