import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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

  return {
    branch,
    context,
    notifications,
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

function warnings(harness) {
  return harness.notifications.filter((entry) => entry.level === "warning");
}

test("every declared ext: tool present warns about nothing", async () => {
  const harness = createHarness();
  await harness.start();

  assert.deepEqual(warnings(harness), []);
});

test("a missing ext: tool warns once and names the affected roles", async () => {
  const harness = createHarness([], ["alpha"]);
  await harness.start();

  const found = warnings(harness);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /beta \(Explore, oracle\)/);
  // `alpha` is provided, so it must not appear as missing.
  assert.ok(!found[0].message.includes("alpha"));
});

test("an empty tool registry is treated as unknown, not as everything missing", async () => {
  const harness = createHarness([], []);
  await harness.start();

  assert.deepEqual(warnings(harness), []);
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
  assert.match(report, /^agent files: 5\/6 readable in .+ — unchecked: verifier$/m);
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
