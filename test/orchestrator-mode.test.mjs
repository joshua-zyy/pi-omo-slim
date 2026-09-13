import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(join(tmpdir(), "pi-omo-dynamic-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// Agent fixtures for the tool-selector audit. `verifier` deliberately has no
// frontmatter so the "unchecked role" path is asserted without mutating files
// between tests. `alpha` is declared by four roles and `beta` by two, so role
// attribution in a missing-tool report is observable.
const agentsDir = join(agentDir, "agents");
mkdirSync(agentsDir, { recursive: true });
const AGENT_TOOLS = {
  Explore: "read, ext:pi-fff/beta",
  librarian: "ext:pi-web-access/alpha",
  oracle: "read, bash, ext:pi-lens/alpha, ext:pi-fff/beta",
  designer: "ext:pi-lens/alpha",
  fixer: "ext:pi-lens/alpha",
  councillor: "read",
};
for (const [role, tools] of Object.entries(AGENT_TOOLS)) {
  writeFileSync(
    join(agentsDir, `${role}.md`),
    `---\ndescription: "${role} fixture"\ntools: ${tools}\n---\n\nBody.\n`,
  );
}
writeFileSync(join(agentsDir, "verifier.md"), "No frontmatter here.\n");

const { default: orchestratorModeExtension } = await import(
  "../extensions/orchestrator-mode/index.ts"
);

const corePolicy = (await import("node:fs/promises")).readFile(
  new URL("../extensions/orchestrator-mode/orchestrator-policy.md", import.meta.url),
  "utf8",
).then((value) => value.trim());
const goalPolicy = (await import("node:fs/promises")).readFile(
  new URL("../extensions/orchestrator-mode/orchestrator-goal-policy.md", import.meta.url),
  "utf8",
).then((value) => value.trim());

function goalState(status) {
  return {
    type: "custom",
    customType: "goal-state",
    data: status === "null" ? { goal: null } : { goal: { status } },
  };
}

function createHarness(initialBranch = [], tools = ["alpha", "beta"]) {
  const branch = [...initialBranch];
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const busHandlers = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: {
      on(channel, handler) {
        let list = busHandlers.get(channel);
        if (!list) busHandlers.set(channel, (list = []));
        list.push(handler);
        return () => {
          const current = busHandlers.get(channel);
          const index = current ? current.indexOf(handler) : -1;
          if (index !== -1) current.splice(index, 1);
        };
      },
      emit(channel, data) {
        for (const handler of [...(busHandlers.get(channel) ?? [])]) handler(data);
      },
    },
    registerCommand(name, config) {
      commands.set(name, config);
    },
    appendEntry(customType, data) {
      branch.push({ type: "custom", customType, data });
    },
    getAllTools() {
      return tools.map((name) => ({ name }));
    },
  };
  const context = {
    hasUI: true,
    ui: {
      notify: (message, level = "info") => notifications.push({ message, level }),
      setStatus: () => {},
    },
    sessionManager: { getBranch: () => branch },
  };

  orchestratorModeExtension(pi);

  async function emit(event, payload = {}) {
    let result;
    for (const handler of handlers.get(event) ?? []) {
      const next = await handler(payload, context);
      if (next !== undefined) result = next;
    }
    return result;
  }

  return {
    branch,
    context,
    notifications,
    command: (args) => commands.get("orchestrator").handler(args, context),
    lanes: () => commands.get("lanes").handler("", context),
    emitBus: (channel, data) => pi.events.emit(channel, data),
    hasCommand: (name) => commands.has(name),
    beforeAgentStart: (systemPrompt = "BASE") => emit("before_agent_start", { systemPrompt }),
    context: (messages = [{ role: "user", content: "hello", timestamp: 1 }]) =>
      emit("context", { type: "context", messages }),
    start: () => emit("session_start"),
    agentStart: () => emit("agent_start"),
    shutdown: () => emit("session_shutdown"),
  };
}

test("Orchestrator OFF does not inject either policy for an active Goal", async () => {
  const harness = createHarness([goalState("active")]);
  await harness.start();

  assert.equal(await harness.beforeAgentStart(), undefined);
});

test("Orchestrator ON injects core and Goal policies for an active Goal", async () => {
  const harness = createHarness([goalState("active")]);
  await harness.start();
  await harness.command("on");

  const result = await harness.beforeAgentStart();
  assert.equal(
    result.systemPrompt,
    `BASE\n\n${await corePolicy}\n\n${await goalPolicy}`,
  );
});

test("completed Goal keeps core policy but removes the Goal addendum", async () => {
  const harness = createHarness([goalState("active"), goalState("complete")]);
  await harness.start();
  await harness.command("on");

  const result = await harness.beforeAgentStart("BASE");
  assert.equal(result.systemPrompt, `BASE\n\n${await corePolicy}`);
  assert.ok(!result.systemPrompt.includes("<Goal Coordination>"));
});

test("goal: null keeps core policy but removes the Goal addendum", async () => {
  const harness = createHarness([goalState("active"), goalState("null")]);
  await harness.start();
  await harness.command("on");

  const result = await harness.beforeAgentStart("BASE");
  assert.equal(result.systemPrompt, `BASE\n\n${await corePolicy}`);
});

test("the latest Goal state wins over older states and unrelated entries", async () => {
  const harness = createHarness([
    goalState("active"),
    { type: "custom", customType: "subagents:record", data: { status: "completed" } },
    goalState("complete"),
    { type: "custom", customType: "todo", data: { status: "pending" } },
    goalState("active"),
  ]);
  await harness.start();
  await harness.command("on");

  const result = await harness.beforeAgentStart("BASE");
  assert.equal(result.systemPrompt, `BASE\n\n${await corePolicy}\n\n${await goalPolicy}`);
});

test("turning Orchestrator off removes injection immediately", async () => {
  const harness = createHarness([goalState("active")]);
  await harness.start();
  await harness.command("on");
  assert.ok((await harness.beforeAgentStart()).systemPrompt.includes("<Role>"));

  await harness.command("off");
  assert.equal(await harness.beforeAgentStart(), undefined);
});

function warnings(harness) {
  return harness.notifications.filter((entry) => entry.level === "warning");
}

test("every declared ext: tool present warns about nothing", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.agentStart();

  assert.deepEqual(warnings(harness), []);
});

test("a missing ext: tool warns once and names the affected roles", async () => {
  const harness = createHarness([], ["alpha"]);
  await harness.start();
  await harness.agentStart();

  const found = warnings(harness);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /beta \(Explore, oracle\)/);
  // `alpha` is provided, so it must not appear as missing.
  assert.ok(!found[0].message.includes("alpha"));
});

test("an empty tool registry is treated as unknown, not as everything missing", async () => {
  const harness = createHarness([], []);
  await harness.start();
  await harness.agentStart();

  assert.deepEqual(warnings(harness), []);
});

test("the startup audit defers to agent_start so late-registering tools are not false-flagged", async () => {
  const harness = createHarness([], ["alpha"]);
  // session_start fires before package extensions register their tools; an
  // immediate audit would false-positive on ffgrep/fffind-style races.
  await harness.start();
  assert.deepEqual(warnings(harness), []);

  await harness.agentStart();
  const found = warnings(harness);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /beta \(Explore, oracle\)/);

  // Runs once per session, not per turn.
  await harness.agentStart();
  assert.equal(warnings(harness).length, 1);
});

test("doctor reports policy state, defaultEnabled source, and the audit", async () => {
  const harness = createHarness([], ["alpha"]);
  await harness.start();
  harness.notifications.length = 0;
  await harness.command("doctor");

  assert.equal(harness.notifications.length, 1);
  const report = harness.notifications[0].message;
  assert.match(report, /^mode: off \(from defaultEnabled\)$/m);
  assert.match(report, /^core policy: loaded, \d+ chars$/m);
  assert.match(report, /^goal policy: loaded, \d+ chars$/m);
  assert.match(report, /^defaultEnabled: false \(orchestrator-mode\.json absent\)$/m);
  assert.match(report, /^agent files: 6\/7 readable in .+ — unchecked: verifier$/m);
  assert.match(
    report,
    /^ext tool references: 6 across 2 unique names — MISSING beta \(Explore, oracle\)$/m,
  );
});

test("doctor distinguishes an explicit mode from the configured default", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.command("on");
  harness.notifications.length = 0;
  await harness.command("doctor");

  const report = harness.notifications[0].message;
  assert.match(report, /^mode: on \(explicit in this session branch\)$/m);
  assert.match(report, /^ext tool references: 6 across 2 unique names — all present$/m);
});

test("an unknown subcommand lists doctor in its usage line", async () => {
  const harness = createHarness();
  await harness.start();
  harness.notifications.length = 0;
  await harness.command("bogus");

  assert.deepEqual(harness.notifications, [
    { message: "Usage: /orchestrator [on|off|status|doctor]", level: "warning" },
  ]);
});

test("the /council command is registered alongside /orchestrator", async () => {
  const harness = createHarness();

  assert.ok(harness.hasCommand("council"));
  assert.ok(harness.hasCommand("orchestrator"));
});

test("board lifecycle coexists with mode restoration, doctor and shutdown", async () => {
  const harness = createHarness();
  await harness.start();
  assert.ok(harness.hasCommand("lanes"));
  harness.emitBus("subagents:started", { id: "live-1", type: "fixer", description: "integration" });
  await harness.lanes();
  assert.match(harness.notifications.at(-1).message, /live-1/);
  await harness.command("doctor");
  assert.match(harness.notifications.at(-1).message, /lane board: 1 lane\(s\) tracked — 1 active/);
  await harness.shutdown();
  harness.emitBus("subagents:started", { id: "after-shutdown", type: "fixer", description: "not tracked" });
  await harness.lanes();
  assert.doesNotMatch(harness.notifications.at(-1).message, /after-shutdown/);
});

// --- Bounded context snapshot ------------------------------------------------

test("context injects nothing while the mode is off, even when the board has data", async () => {
  const harness = createHarness();
  await harness.start();
  harness.emitBus("subagents:started", { id: "a1", type: "fixer", description: "fix race" });

  assert.equal(await harness.context(), undefined);
});

test("context appends one non-displayed custom snapshot when the mode is on", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.command("on");
  harness.emitBus("subagents:started", { id: "a1", type: "fixer", description: "fix race" });

  const result = await harness.context();
  const injected = result.messages.at(-1);
  assert.equal(injected.role, "custom");
  assert.equal(injected.customType, "orchestrator-lane-snapshot");
  assert.equal(injected.display, false);
  assert.equal(typeof injected.timestamp, "number");
  assert.match(injected.content, /"id":"a1"/);
  assert.match(injected.content, /not acceptance/i);
  assert.match(injected.content, /untrusted/i);
});

test("context does not mutate its input, keeps other messages, and replaces stale snapshots", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.command("on");
  harness.emitBus("subagents:started", { id: "a1", type: "fixer", description: "fix race" });

  const user = { role: "user", content: "keep my text", timestamp: 1 };
  const other = { role: "custom", customType: "other-extension", content: "keep me too", display: true, timestamp: 2 };
  const stale = { role: "custom", customType: "orchestrator-lane-snapshot", content: "stale", display: false, timestamp: 3 };
  const tool = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false, timestamp: 4 };
  const input = [user, other, stale, tool];

  const result = await harness.context(input);
  assert.notEqual(result.messages, input);
  assert.equal(input.length, 4, "the input array must not gain or lose messages");
  assert.equal(input[2], stale);
  assert.equal(result.messages[0], user);
  assert.equal(result.messages[1], other);
  assert.equal(result.messages[2], tool);
  assert.equal(result.messages.length, 4);
  const own = result.messages.filter((message) => message.customType === "orchestrator-lane-snapshot");
  assert.equal(own.length, 1);
  assert.match(own[0].content, /"id":"a1"/);
  assert.ok(!result.messages.includes(stale));
});

test("turning the mode off removes a stale snapshot and injects nothing", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.command("on");
  harness.emitBus("subagents:started", { id: "a1", type: "fixer", description: "d" });
  await harness.context();

  await harness.command("off");
  const user = { role: "user", content: "still here", timestamp: 1 };
  const stale = { role: "custom", customType: "orchestrator-lane-snapshot", content: "stale", display: false, timestamp: 2 };
  const result = await harness.context([user, stale]);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0], user);

  assert.equal(await harness.context(), undefined);
});

test("an empty board adds no snapshot and still drops a stale one", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.command("on");

  assert.equal(await harness.context(), undefined);
  const stale = { role: "custom", customType: "orchestrator-lane-snapshot", content: "stale", display: false, timestamp: 2 };
  const result = await harness.context([stale]);
  assert.deepEqual(result.messages, []);
});

test("a compaction-summary-only history still gets the current in-memory snapshot", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.command("on");
  harness.emitBus("subagents:started", { id: "a1", type: "fixer", description: "fix race" });

  const summary = { role: "compactionSummary", summary: "everything before was compacted", tokensBefore: 1234, timestamp: 1 };
  const result = await harness.context([summary]);
  assert.equal(result.messages[0], summary);
  assert.equal(result.messages.at(-1).customType, "orchestrator-lane-snapshot");
  assert.match(result.messages.at(-1).content, /"id":"a1"/);
});

test("convertToLlm turns the injected snapshot into model-visible user text", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.command("on");
  harness.emitBus("subagents:started", { id: "a1", type: "fixer", description: "fix race" });

  const result = await harness.context();
  const llmMessages = convertToLlm(result.messages);
  const injected = llmMessages.at(-1);
  assert.equal(injected.role, "user");
  const text = injected.content.map((part) => part.text ?? "").join("");
  assert.match(text, /<orchestrator-lane-snapshot>/);
  assert.match(text, /"id":"a1"/);
});

test("two extension instances share no bus: only the instance that saw the event injects", async () => {
  const tracking = createHarness();
  const quiet = createHarness();
  await tracking.start();
  await quiet.start();
  await tracking.command("on");
  await quiet.command("on");

  tracking.emitBus("subagents:started", { id: "a1", type: "fixer", description: "fix race" });

  const fromTracking = await tracking.context();
  const fromQuiet = await quiet.context();
  assert.equal(fromQuiet, undefined, "an empty board must not inject");
  assert.equal(fromTracking.messages.at(-1).customType, "orchestrator-lane-snapshot");
  assert.match(fromTracking.messages.at(-1).content, /"id":"a1"/);
});

function snapshotPayload(content) {
  const line = content.split("\n").find((entry) => entry.startsWith('{"counts"'));
  assert.ok(line, "expected a JSON payload line");
  return JSON.parse(line);
}

test("context re-renders the latest state without accumulating stale rows", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.command("on");
  harness.emitBus("subagents:started", { id: "a1", type: "fixer", description: "fix race" });

  const running = await harness.context();
  assert.equal(snapshotPayload(running.messages.at(-1).content).lanes[0].eventStatus, "running");

  harness.emitBus("subagents:completed", {
    id: "a1",
    type: "fixer",
    description: "fix race",
    status: "completed",
    durationMs: 120_000,
    result: "SECRET RESULT BODY",
    error: "SECRET ERROR BODY",
  });
  const completed = await harness.context(running.messages);
  const completedContent = completed.messages.at(-1).content;
  const completedData = snapshotPayload(completedContent);
  assert.equal(completedData.lanes.length, 1);
  assert.equal(completedData.lanes[0].eventStatus, "completed");
  assert.equal(
    completed.messages.filter((message) => message.customType === "orchestrator-lane-snapshot").length,
    1,
  );
  assert.doesNotMatch(completedContent, /SECRET RESULT BODY|SECRET ERROR BODY/);

  harness.emitBus("subagents:started", { id: "a1", type: "fixer", description: "resumed run" });
  const resumed = await harness.context(completed.messages);
  const resumedData = snapshotPayload(resumed.messages.at(-1).content);
  assert.equal(resumedData.lanes.length, 1);
  assert.equal(resumedData.lanes[0].eventStatus, "running");
  assert.equal(resumedData.lanes[0].description, "resumed run");
});
