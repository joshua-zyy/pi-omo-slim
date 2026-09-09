import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-omo-council-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "agents"), { recursive: true });

const { registerCouncil } = await import(
	"../extensions/orchestrator-mode/council.ts"
);

const policyText = (
	await readFile(
		new URL("../extensions/orchestrator-mode/council-policy.md", import.meta.url),
		"utf8",
	)
).trim();

const configPath = join(agentDir, "council.json");
const templatePath = join(agentDir, "agents", "councillor.md");

function writeConfig(value) {
	writeFileSync(configPath, JSON.stringify(value));
}

function writeRawConfig(text) {
	writeFileSync(configPath, text);
}

function removeConfig() {
	rmSync(configPath, { force: true });
}

/** Install a global councillor.md fixture. `source === null` removes it. */
function writeTemplate(source) {
	if (source === null) {
		rmSync(templatePath, { force: true });
		return;
	}
	writeFileSync(templatePath, source);
}

const cleanTemplate = `---\ndescription: "fixture"\ntools: read\nrun_in_background: false\n---\n\nBody.\n`;

function createHarness(options = {}) {
	const sent = [];
	const notifications = [];
	const commands = new Map();
	const tools = options.tools ?? [{ name: "read" }, { name: "Agent" }];
	const pi = {
		registerCommand(name, config) {
			commands.set(name, config);
		},
		sendUserMessage(content, sendOptions) {
			sent.push({ content, sendOptions });
		},
		getAllTools() {
			return tools;
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message, level = "info") =>
				notifications.push({ message, level }),
			setStatus: () => {},
		},
		modelRegistry:
			options.modelRegistry ?? {
				getAvailable: () => [
					{ id: "m1", provider: "p1" },
					{ id: "m2", provider: "p2" },
				],
				find: (provider, id) =>
					provider === "p1" && id === "m1"
						? { id: "m1", provider: "p1" }
						: undefined,
			},
	};

	registerCouncil(pi, { policyPath: options.policyPath });

	return {
		sent,
		notifications,
		command: (args) => commands.get("council").handler(args, ctx),
	};
}

const VALID_ROSTER = {
	councillors: [
		{ name: "skeptic" },
		{ name: "architect" },
		{ name: "minimalist" },
	],
};

const errors = (harness) =>
	harness.notifications.filter((entry) => entry.level === "error");

// --- Configuration validation -----------------------------------------------

test("an absent council.json fails closed without injecting", async () => {
	removeConfig();
	writeTemplate(cleanTemplate);
	const harness = createHarness();

	await harness.command("Queue or outbox for this migration?");

	assert.equal(harness.sent.length, 0);
	const found = errors(harness);
	assert.equal(found.length, 1);
	assert.match(found[0].message, /council\.json/);
	assert.match(found[0].message, /not found/i);
});

test("invalid JSON is reported precisely and nothing is injected", async () => {
	writeRawConfig("{ not json");
	const harness = createHarness();

	await harness.command("Any question?");

	assert.equal(harness.sent.length, 0);
	const found = errors(harness);
	assert.equal(found.length, 1);
	assert.match(found[0].message, /Invalid JSON/);
	assert.ok(found[0].message.includes(configPath));
});

test("a non-object council.json is rejected", async () => {
	writeRawConfig('["not", "an", "object"]');
	const harness = createHarness();

	await harness.command("Any question?");

	assert.equal(harness.sent.length, 0);
	assert.match(errors(harness)[0].message, /must contain a JSON object/);
});

test("a missing or empty councillors array is rejected", async () => {
	writeConfig({});
	const harness = createHarness();
	await harness.command("Any question?");
	assert.match(
		errors(harness)[0].message,
		/"councillors" must be a non-empty array/,
	);

	writeConfig({ councillors: [] });
	const harness2 = createHarness();
	await harness2.command("Any question?");
	assert.match(
		errors(harness2)[0].message,
		/"councillors" must be a non-empty array/,
	);
	assert.equal(harness2.sent.length, 0);
});

test("duplicate councillor names are rejected", async () => {
	writeConfig({
		councillors: [
			{ name: "dup", model: "p1/m1" },
			{ name: "dup", model: "p2/m2" },
		],
	});
	const harness = createHarness();

	await harness.command("Any question?");

	assert.equal(harness.sent.length, 0);
	assert.match(errors(harness)[0].message, /duplicate councillor name: dup/);
});

test("names outside the Agent tool charset are rejected", async () => {
	writeConfig({ councillors: [{ name: "bad name!" }] });
	const harness = createHarness();
	await harness.command("Any question?");
	assert.match(errors(harness)[0].message, /"bad name!"/);

	writeConfig({ councillors: [{ name: "议員" }] });
	const harness2 = createHarness();
	await harness2.command("Any question?");
	assert.match(errors(harness2)[0].message, /议員/);
	assert.equal(harness2.sent.length, 0);
});

test("a missing name is rejected", async () => {
	writeConfig({ councillors: [{ model: "p1/m1" }] });
	const harness = createHarness();

	await harness.command("Any question?");

	assert.equal(harness.sent.length, 0);
	assert.match(errors(harness)[0].message, /requires a non-empty "name"/);
});

test("unknown fields are rejected at both levels", async () => {
	writeConfig({
		councillors: [{ name: "alpha", extra: 1 }],
	});
	const harness = createHarness();
	await harness.command("Any question?");
	assert.match(errors(harness)[0].message, /unknown field\(s\): extra/);

	writeConfig({ councillors: [{ name: "alpha" }], preset: "x" });
	const harness2 = createHarness();
	await harness2.command("Any question?");
	assert.match(errors(harness2)[0].message, /unknown field\(s\): preset/);
	assert.equal(harness2.sent.length, 0);
});

test("an invalid thinking level is rejected with the allowed set", async () => {
	writeConfig({ councillors: [{ name: "alpha", thinking: "ultra" }] });
	const harness = createHarness();

	await harness.command("Any question?");

	assert.equal(harness.sent.length, 0);
	const message = errors(harness)[0].message;
	assert.match(message, /invalid thinking "ultra"/);
	assert.match(message, /off, minimal, low, medium, high, xhigh, max/);
});

// --- Convening ----------------------------------------------------------------

test("a valid convening injects policy, roster, and question with followUp", async () => {
	writeConfig(VALID_ROSTER);
	writeTemplate(cleanTemplate);
	const harness = createHarness();
	const question = "Should we use a job queue or an outbox pattern here?";

	await harness.command(question);

	assert.equal(harness.sent.length, 1);
	const { content, sendOptions } = harness.sent[0];
	assert.deepEqual(sendOptions, { deliverAs: "followUp" });
	assert.ok(content.startsWith("<CouncilInstruction>"));
	assert.ok(content.includes("</CouncilInstruction>"));
	assert.ok(content.includes(policyText));
	assert.ok(content.includes("- skeptic — model: inherit (parent session)"));
	assert.ok(content.includes("- architect — model: inherit (parent session)"));
	assert.ok(content.includes(question));

	const confirmation = harness.notifications.find(
		(entry) => entry.level === "info",
	);
	assert.ok(confirmation);
	assert.match(confirmation.message, /skeptic, architect, minimalist/);
});

test("roster lines include model, thinking, and perspective", async () => {
	writeConfig({
		councillors: [
			{
				name: "alpha",
				model: "p1/m1",
				thinking: "high",
				prompt: "Focus on risks",
			},
		],
	});
	const harness = createHarness();

	await harness.command("Any question?");

	assert.ok(
		harness.sent[0].content.includes(
			"- alpha — model: p1/m1 — thinking: high — perspective: Focus on risks",
		),
	);
});

test("empty-string model and thinking normalize to inherit", async () => {
	writeConfig({
		councillors: [{ name: "alpha", model: "", thinking: "", prompt: "" }],
	});
	const harness = createHarness();

	await harness.command("Any question?");

	const line = harness.sent[0].content
		.split("\n")
		.find((entry) => entry.startsWith("- alpha"));
	assert.equal(
		line,
		"- alpha — model: inherit (parent session)",
	);
});

test("whitespace-only prompt is unset; formatted prompt is preserved", async () => {
	writeConfig({
		councillors: [
			{ name: "blank", prompt: "  \n\t " },
			{ name: "kept", prompt: "Line one\nLine two" },
		],
	});
	const harness = createHarness();

	await harness.command("Any question?");

	const content = harness.sent[0].content;
	const blankLine = content
		.split("\n")
		.find((entry) => entry.startsWith("- blank"));
	assert.equal(blankLine, "- blank — model: inherit (parent session)");
	assert.ok(content.includes("perspective: Line one\nLine two"));
});

test("council.json is re-read on every invocation", async () => {
	writeConfig({ councillors: [{ name: "alpha" }] });
	const harness = createHarness();

	await harness.command("First question?");
	assert.ok(harness.sent[0].content.includes("- alpha"));

	writeConfig({ councillors: [{ name: "beta" }, { name: "gamma" }] });
	await harness.command("Second question?");

	assert.equal(harness.sent.length, 2);
	const second = harness.sent[1].content;
	assert.ok(second.includes("- beta"));
	assert.ok(second.includes("- gamma"));
	assert.ok(!second.includes("- alpha"));
});

test("empty arguments show usage without injecting", async () => {
	writeConfig(VALID_ROSTER);
	const harness = createHarness();

	await harness.command("   ");

	assert.equal(harness.sent.length, 0);
	assert.deepEqual(harness.notifications, [
		{ message: "Usage: /council <question> | /council doctor", level: "warning" },
	]);
});

test("only an exact doctor match enters diagnostics", async () => {
	writeConfig(VALID_ROSTER);
	const harness = createHarness();

	await harness.command("doctor 这个方案是否可行");

	assert.equal(harness.sent.length, 1);
	assert.ok(harness.sent[0].content.includes("这个方案是否可行"));
});

test("a missing policy fails closed for convening and reports in doctor", async () => {
	writeConfig(VALID_ROSTER);
	const harness = createHarness({
		policyPath: join(agentDir, "nonexistent-policy.md"),
	});

	await harness.command("Any question?");
	assert.equal(harness.sent.length, 0);
	assert.equal(errors(harness).length, 1);

	harness.notifications.length = 0;
	await harness.command("doctor");
	assert.equal(harness.sent.length, 0);
	assert.match(harness.notifications[0].message, /unavailable/);
});

// --- Doctor -------------------------------------------------------------------

function doctorReport(harness) {
	const calls = harness.notifications.filter(
		(entry) => entry.level === "info",
	);
	assert.equal(calls.length, 1);
	return calls[0].message;
}

test("doctor reports roster, model hints, template, tool, and scope", async () => {
	writeConfig({
		councillors: [
			{ name: "pair", model: "p1/m1" },
			{ name: "missing-pair", model: "p9/zz" },
			{ name: "bare", model: "m2" },
			{ name: "missing-bare", model: "nope" },
			{ name: "inherits" },
		],
	});
	writeTemplate(cleanTemplate);
	const harness = createHarness();

	await harness.command("doctor");

	const report = doctorReport(harness);
	assert.match(report, /^council policy: loaded, \d+ chars$/m);
	assert.match(report, new RegExp(`^council\\.json: ${configPath.replace(/\\/g, "\\\\").replace(/\./g, "\\.")} — 5 councillor\\(s\\)$`, "m"));
	assert.match(report, /- pair — model: p1\/m1 \(available\)/);
	assert.match(report, /- missing-pair — model: p9\/zz \(unconfirmed — resolved at dispatch\)/);
	assert.match(report, /- bare — model: m2 \(available\)/);
	assert.match(report, /- missing-bare — model: nope \(unconfirmed — resolved at dispatch\)/);
	assert.match(report, /- inherits — model: inherit \(parent session\)/);
	assert.match(report, /^councillor template: .+ — ok$/m);
	assert.match(report, /^Agent tool: registered$/m);
	assert.match(report, /^scope: /m);
	assert.match(report, /project \.pi\/agents\/councillor\.md override is not covered/);
	assert.match(report, /registry presence does not guarantee dispatch success/);
});

test("doctor reports a missing Agent tool without ever claiming verification", async () => {
	writeConfig(VALID_ROSTER);
	writeTemplate(cleanTemplate);
	const harness = createHarness({ tools: [{ name: "read" }] });

	await harness.command("doctor");

	const report = doctorReport(harness);
	assert.match(report, /^Agent tool: not registered/m);
	assert.ok(!/verif/i.test(report));
});

test("doctor warns when the global template pins model, thinking, or background", async () => {
	writeConfig(VALID_ROSTER);
	writeTemplate(
		[
			"---",
			'description: "fixture"',
			"tools: read",
			"model: some/model",
			"thinking: high",
			"run_in_background: true",
			"---",
			"",
			"Body.",
			"",
		].join("\n"),
	);
	const harness = createHarness();

	await harness.command("doctor");

	const report = doctorReport(harness);
	assert.match(report, /councillor template: .+ — overrides detected/);
	assert.match(report, /pins "model: some\/model"/);
	assert.match(report, /pins "thinking: high"/);
	assert.match(
		report,
		/sets "run_in_background: true" — council expects foreground/,
	);
});

test("doctor reports a missing global template", async () => {
	writeConfig(VALID_ROSTER);
	writeTemplate(null);
	const harness = createHarness();

	await harness.command("doctor");

	const report = doctorReport(harness);
	assert.match(report, /^councillor template: not found at /m);
});

test("doctor surfaces a roster error inline", async () => {
	writeConfig({ councillors: [] });
	writeTemplate(cleanTemplate);
	const harness = createHarness();

	await harness.command("doctor");

	const report = doctorReport(harness);
	assert.match(report, /^council\.json: "councillors" must be a non-empty array/m);
});

test("doctor notes high-cost rosters above five councillors", async () => {
	writeConfig({
		councillors: [1, 2, 3, 4, 5, 6].map((index) => ({ name: `c${index}` })),
	});
	writeTemplate(cleanTemplate);
	const harness = createHarness();

	await harness.command("doctor");

	const report = doctorReport(harness);
	assert.match(report, /6 councillors is a high-cost council/);
});
