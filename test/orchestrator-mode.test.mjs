import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-omo-dynamic-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

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

function createHarness(initialBranch = []) {
  const branch = [...initialBranch];
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, config) {
      commands.set(name, config);
    },
    appendEntry(customType, data) {
      branch.push({ type: "custom", customType, data });
    },
  };
  const context = {
    hasUI: false,
    sessionManager: { getBranch: () => branch },
  };

  orchestratorModeExtension(pi);

  return {
    branch,
    context,
    command: (args) => commands.get("orchestrator").handler(args, context),
    beforeAgentStart: (systemPrompt = "BASE") =>
      handlers.get("before_agent_start")({ systemPrompt }, context),
    start: () => handlers.get("session_start")({}, context),
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
