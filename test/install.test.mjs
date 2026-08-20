import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Cross-platform local test for scripts/install.mjs's fixed dependency gate,
// the enforced Pi (>= 0.80.6) and pi-subagents (>= 0.15.0) version minimums,
// the plan schema_version 2 contract, the Task 3 documentation surface
// (INSTALL_AGENT.md, README.md, README.zh-CN.md), and the Task 4
// apply/rollback acceptance: the full install/backup/verification success
// path for an approved eight-dependency plan, plus a transaction rollback
// with an injected verification failure. Uses an isolated temporary fixture
// and a fake Pi executable, so it never touches a real Pi installation, its
// packages, or any repository file. No cleanup commands are issued against
// the repository; the fixture is retained and its path is printed at the end.

const projectRoot = resolve(import.meta.dirname, "..");
const script = join(projectRoot, "scripts", "install.mjs");
const fixtureRoot = resolve(
  tmpdir(),
  `pi-omo-install-test-${process.pid}-${Date.now()}`,
);
const binDir = join(fixtureRoot, "bin");
mkdirSync(binDir, { recursive: true });

if (process.platform === "win32" && /["&|<>^%!\r\n]/.test(fixtureRoot)) {
  throw new Error(
    `Fixture path contains characters the installer rejects in Windows Pi commands: ${fixtureRoot}`,
  );
}

// --- Fake Pi ---------------------------------------------------------------
// Answers the three invocations the installer makes (--version, list,
// --list-models) from environment variables; never a real Pi. FAKE_PI_VERSION
// is printed verbatim (default keeps the historical `pi 0.83.0` prefix form,
// and bare "0.84.2" is used to cover the real-world bare output form).
const fakePiImpl = join(binDir, "fake-pi.mjs");
writeFileSync(
  fakePiImpl,
  [
    "const args = process.argv.slice(2);",
    'if (args.includes("--version")) { process.stdout.write((process.env.FAKE_PI_VERSION || "pi 0.83.0") + "\\n"); process.exit(0); }',
    'if (args.includes("list")) { process.stdout.write(process.env.FAKE_PI_PACKAGES || ""); process.exit(0); }',
    'if (args.includes("--list-models")) { process.stdout.write(process.env.FAKE_PI_MODELS || "gpt-5\\n"); process.exit(0); }',
    'process.stderr.write("unexpected fake pi args: " + args.join(" ") + "\\n");',
    "process.exit(2);",
    "",
  ].join("\n"),
  "utf8",
);
const fakePi = join(binDir, process.platform === "win32" ? "pi.cmd" : "pi");
if (process.platform === "win32") {
  writeFileSync(
    fakePi,
    `@echo off\r\n"${process.execPath}" "%~dp0fake-pi.mjs" %*\r\n`,
    "utf8",
  );
} else {
  writeFileSync(
    fakePi,
    `#!/usr/bin/env sh\nexec "${process.execPath}" "$(dirname "$0")/fake-pi.mjs" "$@"\n`,
    "utf8",
  );
  chmodSync(fakePi, 0o755);
}

// --- Fixed-contract lists (mirrors scripts/install.mjs) --------------------
const ORIGINAL_DEPENDENCIES = [
  "npm:@tintinweb/pi-subagents",
  "npm:@ff-labs/pi-fff",
  "npm:pi-web-access",
  "npm:pi-lens",
  "npm:@firstpick/pi-extension-safety-guard",
  "npm:@narumitw/pi-chrome-devtools",
];
const FIXED_DEPENDENCIES = [
  ...ORIGINAL_DEPENDENCIES,
  "npm:@narumitw/pi-goal",
  "npm:@juicesharp/rpiv-todo",
];
const TARGET_IDS = [
  "agents/Explore.md",
  "agents/librarian.md",
  "agents/oracle.md",
  "agents/designer.md",
  "agents/fixer.md",
  "agents/verifier.md",
  "extensions/orchestrator-mode/index.ts",
  "extensions/orchestrator-mode/orchestrator-policy.md",
  "extensions/orchestrator-mode/orchestrator-goal-policy.md",
  "orchestrator-mode.json",
  "subagents.json",
  "settings.json",
];

const ROLES = [
  "Explore",
  "librarian",
  "oracle",
  "designer",
  "fixer",
  "verifier",
];
// --- Fixture packages ------------------------------------------------------
// Every listed package gets a real directory with a package.json carrying a
// `version`, so the installer's `<path>/package.json` version read is
// exercised exactly as in production.
const packageRoot = join(fixtureRoot, "packages");
const DEFAULT_PACKAGE_VERSIONS = {
  "npm:@tintinweb/pi-subagents": "0.15.0",
  "npm:@ff-labs/pi-fff": "0.10.3",
  "npm:pi-web-access": "0.21.0",
  "npm:pi-lens": "3.8.74",
  "npm:@firstpick/pi-extension-safety-guard": "0.2.7",
  "npm:@narumitw/pi-chrome-devtools": "0.52.0",
  "npm:@narumitw/pi-goal": "0.51.0",
  "npm:@juicesharp/rpiv-todo": "2.6.0",
};
function ensurePackage(identifier, version) {
  const pathname = join(packageRoot, identifier.slice(4).replaceAll("/", "__"));
  mkdirSync(pathname, { recursive: true });
  writeFileSync(
    join(pathname, "package.json"),
    `${JSON.stringify({ name: identifier, version }, null, 2)}\n`,
    "utf8",
  );
  return pathname;
}

const requestPath = join(fixtureRoot, "request.json");
writeFileSync(
  requestPath,
  `${JSON.stringify(
    {
      routing: "strict",
      orchestratorDefaultEnabled: false,
      agents: Object.fromEntries(
        ROLES.map((role) => [
          role,
          { action: "install", model: "inherit", thinking: "inherit" },
        ]),
      ),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

function runPlan(packages, configRoot, options = {}) {
  mkdirSync(configRoot, { recursive: true });
  const versions = { ...DEFAULT_PACKAGE_VERSIONS, ...(options.versions || {}) };
  // Real `pi list` shape: an identifier line, then a more-indented absolute
  // path line. A filtered git: entry is included in every run to prove the
  // inventory parser ignores it.
  const listLines = ["User packages:"];
  for (const identifier of packages) {
    const pathname = ensurePackage(identifier, versions[identifier] ?? "1.0.0");
    listLines.push(`  ${identifier}`, `    ${pathname}`);
  }
  listLines.push(
    "  git:github.com/example/demo (filtered)",
    `    ${join(packageRoot, "git-demo")}`,
  );
  const request = options.requestPath || requestPath;
  return spawnSync(
    process.execPath,
    [script, "plan", "--request", request, "--config-root", configRoot],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_EXECUTABLE: fakePi,
        FAKE_PI_PACKAGES: `${listLines.join("\n")}\n`,
        FAKE_PI_VERSION: options.piVersion || "pi 0.83.0",
        FAKE_PI_MODELS: options.models,
      },
    },
  );
}

const noAuditCreated = (configRoot) =>
  `a failed dependency check must not create plan.json or the audit directory under ${configRoot}`;

// (1) Only the original six dependencies installed: plan must fail and stably
// list BOTH new missing packages, without creating plan.json or the audit dir.
const case1Root = join(fixtureRoot, "case1-only-original-six");
let result = runPlan(ORIGINAL_DEPENDENCIES, case1Root);
assert.notEqual(
  result.status,
  0,
  "plan must fail when only the original six dependencies are installed",
);
assert.match(
  result.stderr,
  /Missing Pi dependencies:/,
  `stderr must report missing dependencies:\n${result.stderr}`,
);
const piGoalIndex = result.stderr.indexOf("npm:@narumitw/pi-goal");
const rpivTodoIndex = result.stderr.indexOf("npm:@juicesharp/rpiv-todo");
assert.ok(
  piGoalIndex >= 0,
  `stderr must list the missing pi-goal package:\n${result.stderr}`,
);
assert.ok(
  rpivTodoIndex > piGoalIndex,
  `missing packages must use the fixed dependency order:\n${result.stderr}`,
);
assert.equal(
  result.stderr.match(/npm:@narumitw\/pi-goal/g)?.length,
  1,
  "pi-goal must be reported exactly once",
);
assert.equal(
  result.stderr.match(/npm:@juicesharp\/rpiv-todo/g)?.length,
  1,
  "rpiv-todo must be reported exactly once",
);
assert.equal(
  existsSync(join(case1Root, "install-records")),
  false,
  noAuditCreated(case1Root),
);

// (2a) Only pi-goal missing: only the actually missing package is reported.
const case2aRoot = join(fixtureRoot, "case2a-missing-pi-goal");
result = runPlan(
  [...ORIGINAL_DEPENDENCIES, "npm:@juicesharp/rpiv-todo"],
  case2aRoot,
);
assert.notEqual(result.status, 0, "plan must fail when pi-goal is missing");
assert.ok(
  result.stderr.includes("npm:@narumitw/pi-goal"),
  `stderr must list the missing pi-goal package:\n${result.stderr}`,
);
assert.ok(
  !result.stderr.includes("npm:@juicesharp/rpiv-todo"),
  `only the actually missing package may be listed:\n${result.stderr}`,
);
assert.equal(
  existsSync(join(case2aRoot, "install-records")),
  false,
  noAuditCreated(case2aRoot),
);

// (2b) Only rpiv-todo missing: only the actually missing package is reported.
const case2bRoot = join(fixtureRoot, "case2b-missing-rpiv-todo");
result = runPlan(
  [...ORIGINAL_DEPENDENCIES, "npm:@narumitw/pi-goal"],
  case2bRoot,
);
assert.notEqual(result.status, 0, "plan must fail when rpiv-todo is missing");
assert.ok(
  result.stderr.includes("npm:@juicesharp/rpiv-todo"),
  `stderr must list the missing rpiv-todo package:\n${result.stderr}`,
);
assert.ok(
  !result.stderr.includes("npm:@narumitw/pi-goal"),
  `only the actually missing package may be listed:\n${result.stderr}`,
);
assert.equal(
  existsSync(join(case2bRoot, "install-records")),
  false,
  noAuditCreated(case2bRoot),
);

// (3) All eight dependencies installed: plan succeeds, plan.pi.dependencies is
// exactly the fixed eight packages, targets are exactly the current twelve,
// the plan carries schema_version 2, the parsed Pi version (bare output form)
// with the enforced minimum, and every dependency's installed version.
const case3Root = join(fixtureRoot, "case3-all-eight");
result = runPlan(FIXED_DEPENDENCIES, case3Root, { piVersion: "0.84.2" });
assert.equal(
  result.status,
  0,
  `plan must succeed when all eight dependencies are installed:\n${result.stderr}`,
);
const [planPath, shaLine] = result.stdout.trim().split(/\r?\n/);
assert.ok(
  planPath.endsWith("plan.json"),
  `first stdout line must be the plan path:\n${result.stdout}`,
);
assert.match(
  shaLine,
  /^[a-f0-9]{64}$/,
  "second stdout line must be the plan SHA-256",
);
assert.ok(existsSync(planPath), `plan.json must exist at ${planPath}`);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
assert.equal(plan.status, "planned");
assert.equal(plan.schema_version, 2, "plan schema_version must be 2");
assert.deepEqual(
  plan.pi.dependencies,
  FIXED_DEPENDENCIES,
  "plan.pi.dependencies must be exactly the fixed eight packages",
);
assert.equal(
  plan.pi.version,
  "0.84.2",
  "plan must record the parsed Pi version (bare output form)",
);
assert.equal(
  plan.pi.minimum_version,
  "0.80.6",
  "plan must record the enforced Pi minimum",
);
assert.deepEqual(
  plan.pi.dependency_versions,
  DEFAULT_PACKAGE_VERSIONS,
  "plan must record every dependency's installed version",
);
assert.equal(
  plan.targets.length,
  TARGET_IDS.length,
  "targets must be exactly the current twelve",
);
assert.deepEqual(
  plan.targets.map((target) => target.id),
  TARGET_IDS,
  "target IDs must be exactly the current twelve",
);

// Rebuilds the fake Pi environment from an approved plan so apply re-runs the
// same inventory the plan recorded: every dependency gets its planned version
// at the same fixture path, and the fake reports the planned Pi version.
function fakePiEnv(plan, extra = {}) {
  const versions = plan.pi.dependency_versions;
  const listLines = ["User packages:"];
  for (const identifier of plan.pi.dependencies) {
    const pathname = ensurePackage(identifier, versions[identifier] ?? "1.0.0");
    listLines.push(`  ${identifier}`, `    ${pathname}`);
  }
  return {
    PI_EXECUTABLE: fakePi,
    FAKE_PI_PACKAGES: `${listLines.join("\n")}\n`,
    FAKE_PI_VERSION: plan.pi.version,
    ...extra,
  };
}

function runApply(planPath, sha256Hex, extraEnv = {}) {
  const approvedPlan = JSON.parse(readFileSync(planPath, "utf8"));
  return spawnSync(
    process.execPath,
    [script, "apply", "--plan", planPath, "--sha256", sha256Hex],
    {
      encoding: "utf8",
      env: { ...process.env, ...fakePiEnv(approvedPlan, extraEnv) },
    },
  );
}

// (4) Apply the case-3 approved plan with the exact SHA from stdout: the
// install/backup/verification success path must exit 0, write a succeeded
// result, record a 12-target manifest, and leave exactly the eleven managed
// writes in place — while settings.json (observe-only) is never created.
const approvedPlan = JSON.parse(readFileSync(planPath, "utf8"));
const managedTargets = approvedPlan.targets.filter(
  (target) => target.may_modify,
);
assert.equal(
  managedTargets.length,
  11,
  "fresh-root plan must have exactly eleven managed targets",
);
assert.deepEqual(
  approvedPlan.targets
    .filter((target) => !target.may_modify)
    .map((target) => target.id),
  ["settings.json"],
  "only settings.json may be observe-only",
);
result = runApply(planPath, shaLine);
assert.equal(
  result.status,
  0,
  `apply must succeed for the approved plan:\n${result.stderr}`,
);
const applyResultPath = result.stdout.trim().split(/\r?\n/)[0];
assert.equal(
  applyResultPath,
  join(case3Root, "install-records", approvedPlan.plan_id, "result.json"),
  "apply stdout must be the result.json path",
);
const applyResult = JSON.parse(readFileSync(applyResultPath, "utf8"));
assert.equal(
  applyResult.status,
  "succeeded",
  "result.json must record a succeeded status (verification passed)",
);
assert.equal(
  applyResult.plan_id,
  approvedPlan.plan_id,
  "result.json must reference the approved plan",
);
assert.equal(
  applyResult.manifest,
  join(approvedPlan.backup_directory, "manifest.json"),
  "result.json must reference the backup manifest",
);
assert.equal(
  applyResult.operations.length,
  managedTargets.length,
  "result.json must record exactly the eleven managed operations",
);
assert.ok(
  applyResult.operations.every((operation) => operation.type === "create"),
  "a fresh-root apply must create every managed target",
);
const successManifest = JSON.parse(readFileSync(applyResult.manifest, "utf8"));
assert.equal(
  successManifest.targets.length,
  TARGET_IDS.length,
  "manifest must have exactly the current twelve targets",
);
assert.deepEqual(
  successManifest.targets.map((item) => item.id),
  TARGET_IDS,
  "manifest target IDs must match the plan",
);
for (const target of managedTargets) {
  assert.ok(
    existsSync(target.destination),
    `managed target must be installed: ${target.id}`,
  );
  const content = readFileSync(target.destination, "utf8");
  assert.ok(
    content.length > 0,
    `installed target must be non-empty: ${target.id}`,
  );
  if (target.id.startsWith("agents/")) {
    assert.equal(
      (content.match(/^---\r?$/gm) || []).length,
      2,
      `installed Agent must keep its frontmatter: ${target.id}`,
    );
  }
}
for (const id of [
  "extensions/orchestrator-mode/index.ts",
  "extensions/orchestrator-mode/orchestrator-policy.md",
  "extensions/orchestrator-mode/orchestrator-goal-policy.md",
]) {
  const target = managedTargets.find((item) => item.id === id);
  assert.equal(
    readFileSync(target.destination, "utf8"),
    readFileSync(join(projectRoot, target.source), "utf8"),
    `extension must be an exact copy of its plan source: ${id}`,
  );
}
const orchestratorInstalled = JSON.parse(
  readFileSync(join(case3Root, "orchestrator-mode.json"), "utf8"),
);
assert.equal(
  orchestratorInstalled.defaultEnabled,
  false,
  "orchestrator-mode.json must carry the approved defaultEnabled",
);
const subagentsInstalled = JSON.parse(
  readFileSync(join(case3Root, "subagents.json"), "utf8"),
);
assert.equal(
  subagentsInstalled.disableDefaultAgents,
  true,
  "strict routing must disable default agents",
);
assert.equal(
  subagentsInstalled.fallbackSubagent,
  "none",
  "strict routing must set fallbackSubagent to none",
);
assert.equal(
  existsSync(join(case3Root, "settings.json")),
  false,
  "settings.json must never be created",
);

// (5) Injected verification failure: a fresh config root and a fresh
// one-time plan, applied with PI_OMO_INSTALL_TEST_MODE=1 and
// PI_OMO_INSTALL_TEST_FAILURE=during_verification. All eleven managed writes
// and the directories created for them must be rolled back exactly as the
// plan's rollback contract describes, with no unresolved paths, while the
// audit and backup records are retained and settings.json still never
// appears. rollback_incomplete is deliberately not simulated.
const case5Root = join(fixtureRoot, "case5-failure-during-verification");
result = runPlan(FIXED_DEPENDENCIES, case5Root);
assert.equal(
  result.status,
  0,
  `plan for the failure case must succeed:\n${result.stderr}`,
);
const [failurePlanPath, failureSha] = result.stdout.trim().split(/\r?\n/);
const failurePlan = JSON.parse(readFileSync(failurePlanPath, "utf8"));
assert.equal(
  failurePlan.status,
  "planned",
  "failure-case plan must start as planned",
);
const failureAuditDir = join(case5Root, "install-records", failurePlan.plan_id);
const failureManaged = failurePlan.targets.filter(
  (target) => target.may_modify,
);
assert.equal(
  failureManaged.length,
  11,
  "fresh-root plan must have exactly eleven managed targets",
);
assert.equal(
  failurePlan.rollback.delete_files.length,
  failureManaged.length,
  "rollback delete list must cover every managed target",
);
assert.ok(
  failurePlan.rollback.remove_empty_directories.length > 0,
  "rollback must include the created directories",
);
result = runApply(failurePlanPath, failureSha, {
  PI_OMO_INSTALL_TEST_MODE: "1",
  PI_OMO_INSTALL_TEST_FAILURE: "during_verification",
});
assert.notEqual(
  result.status,
  0,
  "apply with an injected verification failure must exit non-zero",
);
assert.match(
  result.stderr,
  /Injected failure at during_verification/,
  `stderr must report the injected failure:\n${result.stderr}`,
);
assert.match(
  result.stderr,
  /was rolled back/,
  `stderr must report a completed rollback:\n${result.stderr}`,
);
const failureResult = JSON.parse(
  readFileSync(join(failureAuditDir, "result.json"), "utf8"),
);
assert.equal(
  failureResult.status,
  "rolled_back",
  "result.json must record rolled_back",
);
assert.deepEqual(
  failureResult.unresolved_paths,
  [],
  "a full rollback must leave no unresolved paths",
);
assert.ok(
  failureResult.error.includes("Injected failure at during_verification"),
  "result.json must record the failure cause",
);
const rollbackRecord = JSON.parse(
  readFileSync(join(failureAuditDir, "rollback.json"), "utf8"),
);
assert.equal(
  rollbackRecord.status,
  "rolled_back",
  "rollback.json must record rolled_back",
);
assert.deepEqual(
  rollbackRecord.unresolved_paths,
  [],
  "rollback.json must leave no unresolved paths",
);
assert.ok(
  rollbackRecord.cause.includes("Injected failure at during_verification"),
  "rollback.json must record the failure cause",
);
assert.ok(
  rollbackRecord.compensations.every((entry) => entry.status === "succeeded"),
  "every compensation must succeed",
);
assert.equal(
  rollbackRecord.compensations.filter((entry) => entry.type === "delete")
    .length,
  failurePlan.rollback.delete_files.length,
  "every created file must be compensated with a delete",
);
assert.equal(
  rollbackRecord.compensations.filter(
    (entry) => entry.type === "remove_empty_directory",
  ).length,
  failurePlan.rollback.remove_empty_directories.length,
  "every created directory must be compensated with a removal",
);
for (const pathname of failurePlan.rollback.delete_files) {
  assert.equal(
    existsSync(pathname),
    false,
    `rolled-back file must be gone: ${pathname}`,
  );
}
for (const pathname of failurePlan.rollback.remove_empty_directories) {
  assert.equal(
    existsSync(pathname),
    false,
    `rolled-back directory must be gone: ${pathname}`,
  );
}
assert.equal(
  existsSync(join(case5Root, "settings.json")),
  false,
  "settings.json must still not exist after rollback",
);
for (const record of [
  "plan.json",
  "apply-started.json",
  "result.json",
  "rollback.json",
]) {
  assert.ok(
    existsSync(join(failureAuditDir, record)),
    `audit record must be retained: ${record}`,
  );
}
assert.equal(
  createHash("sha256").update(readFileSync(failurePlanPath)).digest("hex"),
  failureSha,
  "the approved plan bytes must be untouched",
);
const failureManifest = JSON.parse(
  readFileSync(join(failurePlan.backup_directory, "manifest.json"), "utf8"),
);
assert.equal(
  failureManifest.targets.length,
  TARGET_IDS.length,
  "backup manifest must cover all twelve targets",
);
assert.ok(
  failureManifest.targets.every((item) => item.existed === false),
  "fresh-root manifest must record no pre-existing files",
);
assert.ok(
  !readdirSync(case5Root).some((name) => name.startsWith(".install-tmp-")),
  "no temporary write files may remain after rollback",
);
// Plans are strictly one-time: re-applying an already attempted plan is refused.
result = runApply(failurePlanPath, failureSha);
assert.notEqual(
  result.status,
  0,
  "re-applying an already attempted plan must fail",
);
assert.match(
  result.stderr,
  /already been attempted/,
  `second apply must be refused:\n${result.stderr}`,
);

// (A) Pi below the enforced 0.80.6 minimum: plan must fail before any
// configuration-root write. 0.9.0 exercises the numeric major/minor/patch
// comparison (string ordering would wrongly accept it as above 0.80.6).
const caseARoot = join(fixtureRoot, "caseA-pi-below-minimum");
result = runPlan(FIXED_DEPENDENCIES, caseARoot, { piVersion: "0.9.0" });
assert.notEqual(result.status, 0, "plan must fail when Pi is below 0.80.6");
assert.match(
  result.stderr,
  /0\.9\.0/,
  `stderr must include the actual Pi version:\n${result.stderr}`,
);
assert.match(
  result.stderr,
  /0\.80\.6/,
  `stderr must include the enforced minimum:\n${result.stderr}`,
);
assert.match(
  result.stderr,
  /agent_settled/,
  `stderr must explain the agent_settled reason:\n${result.stderr}`,
);
assert.equal(
  existsSync(join(caseARoot, "install-records")),
  false,
  noAuditCreated(caseARoot),
);

// Boundary: exactly the 0.80.6 minimum must be accepted.
const caseABoundaryRoot = join(fixtureRoot, "caseA-boundary-minimum");
result = runPlan(FIXED_DEPENDENCIES, caseABoundaryRoot, {
  piVersion: "0.80.6",
});
assert.equal(
  result.status,
  0,
  `plan must succeed when Pi is exactly 0.80.6:\n${result.stderr}`,
);
const boundaryPlanPath = result.stdout.trim().split(/\r?\n/)[0];
assert.equal(
  JSON.parse(readFileSync(boundaryPlanPath, "utf8")).pi.version,
  "0.80.6",
  "boundary plan must record 0.80.6",
);

// (B) pi-subagents below the enforced 0.15.0 minimum: strict routing's
// fallbackSubagent: "none" only exists from 0.15.0, so an older release
// would silently fail open. Plan must fail with an actionable message and
// no configuration-root write.
const caseBRoot = join(fixtureRoot, "caseB-subagents-below-minimum");
result = runPlan(FIXED_DEPENDENCIES, caseBRoot, {
  versions: { "npm:@tintinweb/pi-subagents": "0.14.3" },
});
assert.notEqual(
  result.status,
  0,
  "plan must fail when pi-subagents is below 0.15.0",
);
assert.match(
  result.stderr,
  /0\.14\.3/,
  `stderr must include the installed version:\n${result.stderr}`,
);
assert.match(
  result.stderr,
  /0\.15\.0/,
  `stderr must include the enforced minimum:\n${result.stderr}`,
);
assert.match(
  result.stderr,
  /fallbackSubagent/,
  `stderr must explain the fallbackSubagent reason:\n${result.stderr}`,
);
assert.match(
  result.stderr,
  /fail-closed/,
  `stderr must state the fail-closed consequence:\n${result.stderr}`,
);
assert.equal(
  existsSync(join(caseBRoot, "install-records")),
  false,
  noAuditCreated(caseBRoot),
);

// (T) validatePlan must reject tampered or missing new fields even when the
// tampered bytes are re-hashed and re-submitted (acceptance criterion 4).
const caseTRoot = join(fixtureRoot, "caseT-tampered-plan");
function freshTamperCase() {
  const fresh = runPlan(FIXED_DEPENDENCIES, caseTRoot, {
    piVersion: "0.84.2",
    versions: { "npm:@tintinweb/pi-subagents": "0.15.0" },
  });
  assert.equal(
    fresh.status,
    0,
    `tamper-case plan must succeed:\n${fresh.stderr}`,
  );
  return fresh.stdout.trim().split(/\r?\n/)[0];
}
function applyTampered(planPath, from, to) {
  const original = readFileSync(planPath, "utf8");
  const tampered = original.split(from).join(to);
  assert.notEqual(
    tampered,
    original,
    "tamper replacement must change the plan",
  );
  writeFileSync(planPath, tampered, "utf8");
  const tamperedSha = createHash("sha256").update(tampered).digest("hex");
  return runApply(planPath, tamperedSha);
}
let tamperPlanPath = freshTamperCase();
result = applyTampered(
  tamperPlanPath,
  '"npm:@tintinweb/pi-subagents": "0.15.0"',
  '"npm:@tintinweb/pi-subagents": "0.14.3"',
);
assert.notEqual(
  result.status,
  0,
  "apply must reject a plan whose pi-subagents version is below the minimum",
);
assert.match(
  result.stderr,
  /below the required minimum 0\.15\.0/,
  `stderr must report the pi-subagents minimum:\n${result.stderr}`,
);
assert.equal(
  existsSync(join(dirname(tamperPlanPath), "apply-started.json")),
  false,
  "a validation failure must not write apply-started.json",
);
tamperPlanPath = freshTamperCase();
result = applyTampered(
  tamperPlanPath,
  '"minimum_version": "0.80.6"',
  '"minimum_version": "0.80.5"',
);
assert.notEqual(
  result.status,
  0,
  "apply must reject a plan with a tampered Pi minimum",
);
assert.match(
  result.stderr,
  /Invalid Pi minimum version in plan/,
  `stderr must report the invalid minimum:\n${result.stderr}`,
);
tamperPlanPath = freshTamperCase();
result = applyTampered(
  tamperPlanPath,
  '"npm:@tintinweb/pi-subagents": "0.15.0",\n',
  "",
);
assert.notEqual(
  result.status,
  0,
  "apply must reject a plan with a missing dependency version",
);
assert.match(
  result.stderr,
  /Invalid dependency versions in plan/,
  `stderr must report the missing dependency version:\n${result.stderr}`,
);

// (L) The apply lock: a live lock from another process must be refused, a
// stale lock (dead PID) is reclaimed automatically, and a successful apply
// releases its lock.
const caseLRoot = join(fixtureRoot, "caseL-apply-lock");
result = runPlan(FIXED_DEPENDENCIES, caseLRoot, { piVersion: "0.84.2" });
assert.equal(
  result.status,
  0,
  `lock-case plan must succeed:\n${result.stderr}`,
);
const [lockPlanPath, lockSha] = result.stdout.trim().split(/\r?\n/);
const lockPath = join(caseLRoot, "install-records", ".install.lock");
writeFileSync(
  lockPath,
  `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
);
result = runApply(lockPlanPath, lockSha);
assert.notEqual(result.status, 0, "apply must refuse a live lock");
assert.match(
  result.stderr,
  /Another installation appears to be in progress/,
  `stderr must report the lock:\n${result.stderr}`,
);
writeFileSync(
  lockPath,
  `${JSON.stringify({ pid: 2147483647, created_at: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
);
result = runApply(lockPlanPath, lockSha);
assert.equal(
  result.status,
  0,
  `apply must reclaim a stale lock:\n${result.stderr}`,
);
assert.equal(
  existsSync(lockPath),
  false,
  "apply must release its lock on success",
);

// (P) apply must re-check the Pi floor: an environment downgrade between
// plan approval and execution is refused fail-closed.
const casePRoot = join(fixtureRoot, "caseP-apply-pi-floor");
result = runPlan(FIXED_DEPENDENCIES, casePRoot, { piVersion: "0.84.2" });
assert.equal(
  result.status,
  0,
  `apply-floor plan must succeed:\n${result.stderr}`,
);
const [applyFloorPlanPath, applyFloorSha] = result.stdout.trim().split(/\r?\n/);
result = runApply(applyFloorPlanPath, applyFloorSha, {
  FAKE_PI_VERSION: "0.80.0",
});
assert.notEqual(result.status, 0, "apply must refuse a downgraded Pi");
assert.match(
  result.stderr,
  /below the required minimum/,
  `stderr must report the Pi floor:\n${result.stderr}`,
);

// (W) Concurrent write during the after_temp_write pause: another writer
// creates the destination before the atomic rename. Apply must refuse the
// write and its rollback must leave the concurrent content untouched,
// recording the blocked paths as unresolved.
const caseWRoot = join(fixtureRoot, "caseW-concurrent-write");
result = runPlan(FIXED_DEPENDENCIES, caseWRoot, { piVersion: "0.84.2" });
assert.equal(
  result.status,
  0,
  `concurrent-write plan must succeed:\n${result.stderr}`,
);
const [writePlanPath, writeSha] = result.stdout.trim().split(/\r?\n/);
const writePlan = JSON.parse(readFileSync(writePlanPath, "utf8"));
const exploreTarget = writePlan.targets.find(
  (item) => item.id === "agents/Explore.md",
);
assert.ok(exploreTarget, "plan must include agents/Explore.md");
const markerPath = join(fixtureRoot, "pause-marker");
const resumePath = join(fixtureRoot, "pause-resume");
const concurrentContent = "concurrent writer content\n";
const child = spawn(
  process.execPath,
  [script, "apply", "--plan", writePlanPath, "--sha256", writeSha],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      ...fakePiEnv(writePlan, {
        PI_OMO_INSTALL_TEST_MODE: "1",
        PI_OMO_INSTALL_TEST_PAUSE: "after_temp_write",
        PI_OMO_INSTALL_TEST_PAUSE_MARKER: markerPath,
        PI_OMO_INSTALL_TEST_PAUSE_RESUME: resumePath,
      }),
    },
  },
);
const waitDeadline = Date.now() + 30000;
while (!existsSync(markerPath)) {
  if (Date.now() > waitDeadline)
    throw new Error("installer never reached the after_temp_write pause");
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
}
writeFileSync(exploreTarget.destination, concurrentContent, "utf8");
writeFileSync(resumePath, "go\n", "utf8");
const { status: concurrentStatus } = await new Promise((resolveExit) => {
  child.on("exit", (exitCode) => resolveExit({ status: exitCode }));
  child.on("error", (error) =>
    resolveExit({ status: -1, error: error.message }),
  );
});
assert.notEqual(
  concurrentStatus,
  0,
  `apply must refuse the concurrent write (exit ${concurrentStatus})`,
);
assert.equal(
  readFileSync(exploreTarget.destination, "utf8"),
  concurrentContent,
  "rollback must not delete or overwrite the concurrent write",
);
const writeResult = JSON.parse(
  readFileSync(
    join(caseWRoot, "install-records", writePlan.plan_id, "result.json"),
    "utf8",
  ),
);
assert.equal(
  writeResult.status,
  "rollback_incomplete",
  "rollback must record rollback_incomplete",
);
assert.ok(
  writeResult.unresolved_paths.length >= 1,
  `rollback must record blocked paths as unresolved:\n${JSON.stringify(writeResult.unresolved_paths)}`,
);

// (V1) Dependency version drift between plan and apply: apply must refuse
// fail-closed instead of installing against a changed environment.
const caseV1Root = join(fixtureRoot, "caseV1-dependency-drift");
result = runPlan(FIXED_DEPENDENCIES, caseV1Root, { piVersion: "0.84.2" });
assert.equal(result.status, 0, `drift plan must succeed:\n${result.stderr}`);
const [driftPlanPath, driftSha] = result.stdout.trim().split(/\r?\n/);
// Build a drifted inventory at its own paths: the fake env rebuild in
// runApply writes the planned versions to the shared fixture paths, so the
// drifted versions must live somewhere inventoryPi will read instead.
const driftedPackageRoot = join(fixtureRoot, "drifted-packages");
const driftedList = ["User packages:"];
for (const identifier of FIXED_DEPENDENCIES) {
  const version =
    identifier === "npm:@tintinweb/pi-subagents"
      ? "0.16.0"
      : DEFAULT_PACKAGE_VERSIONS[identifier];
  const pathname = join(
    driftedPackageRoot,
    identifier.slice(4).replaceAll("/", "__"),
  );
  mkdirSync(pathname, { recursive: true });
  writeFileSync(
    join(pathname, "package.json"),
    `${JSON.stringify({ name: identifier, version }, null, 2)}\n`,
    "utf8",
  );
  driftedList.push(`  ${identifier}`, `    ${pathname}`);
}
result = runApply(driftPlanPath, driftSha, {
  FAKE_PI_PACKAGES: `${driftedList.join("\n")}\n`,
});
assert.notEqual(
  result.status,
  0,
  "apply must refuse a dependency version drift",
);
assert.match(
  result.stderr,
  /version changed since plan approval/,
  `stderr must report the drift:\n${result.stderr}`,
);

// (V2) Pi version drift between plan and apply: a newer (still >= minimum) Pi
// is also refused because the approved plan pinned the environment.
const caseV2Root = join(fixtureRoot, "caseV2-pi-drift");
result = runPlan(FIXED_DEPENDENCIES, caseV2Root, { piVersion: "0.84.2" });
assert.equal(result.status, 0, `pi-drift plan must succeed:\n${result.stderr}`);
const [piDriftPlanPath, piDriftSha] = result.stdout.trim().split(/\r?\n/);
result = runApply(piDriftPlanPath, piDriftSha, { FAKE_PI_VERSION: "0.85.0" });
assert.notEqual(result.status, 0, "apply must refuse a Pi version drift");
assert.match(
  result.stderr,
  /Pi version changed since plan approval/,
  `stderr must report the Pi drift:\n${result.stderr}`,
);

// (V) Case-variant Agent files: on case-insensitive filesystems a user's
// agents/explore.md IS the agents/Explore.md target, so it must not be
// recorded as an unrelated Agent and keep must apply cleanly. On
// case-sensitive filesystems the same setup is refused as a case-ambiguous
// agent type.
const caseInsensitive =
  process.platform === "win32" || process.platform === "darwin";
const caseVRoot = join(fixtureRoot, "caseV-case-variant");
mkdirSync(join(caseVRoot, "agents"), { recursive: true });
const variantContent = "# user explore agent\n";
writeFileSync(join(caseVRoot, "agents", "explore.md"), variantContent, "utf8");
const variantRequestPath = join(fixtureRoot, "request-variant.json");
writeFileSync(
  variantRequestPath,
  `${JSON.stringify(
    {
      routing: "strict",
      orchestratorDefaultEnabled: false,
      agents: Object.fromEntries(
        ROLES.map((role) => [
          role,
          {
            action:
              role === "Explore"
                ? caseInsensitive
                  ? "keep"
                  : "install"
                : "install",
            model: "inherit",
            thinking: "inherit",
          },
        ]),
      ),
    },
    null,
    2,
  )}\n`,
  "utf8",
);
result = runPlan(FIXED_DEPENDENCIES, caseVRoot, {
  piVersion: "0.84.2",
  requestPath: variantRequestPath,
});
if (caseInsensitive) {
  assert.equal(
    result.status,
    0,
    `case-insensitive plan with keep must succeed:\n${result.stderr}`,
  );
  const [variantPlanPath, variantSha] = result.stdout.trim().split(/\r?\n/);
  const variantPlan = JSON.parse(readFileSync(variantPlanPath, "utf8"));
  assert.deepEqual(
    variantPlan.unrelated_custom_agents,
    [],
    "the same-file case variant must not be recorded as an unrelated Agent",
  );
  result = runApply(variantPlanPath, variantSha);
  assert.equal(
    result.status,
    0,
    `case-insensitive apply with keep must succeed:\n${result.stderr}`,
  );
  assert.equal(
    readFileSync(join(caseVRoot, "agents", "explore.md"), "utf8"),
    variantContent,
    "the kept case-variant Agent must be untouched",
  );
} else {
  assert.notEqual(
    result.status,
    0,
    "case-sensitive filesystems must refuse a case-variant Agent",
  );
  assert.match(
    result.stderr,
    /Case-variant Agent/,
    `stderr must report the case conflict:\n${result.stderr}`,
  );
}

// (M) Model inventory parsing: bare model ids (fuzzy frontmatter) and
// provider/model pairs from a table-style --list-models output are both
// pinnable.
const caseMRoot = join(fixtureRoot, "caseM-model-pinning");
const modelsRequestPath = join(fixtureRoot, "request-models.json");
writeFileSync(
  modelsRequestPath,
  `${JSON.stringify(
    {
      routing: "strict",
      orchestratorDefaultEnabled: false,
      agents: Object.fromEntries(
        ROLES.map((role) => [
          role,
          {
            action: "install",
            model:
              role === "Explore"
                ? "gpt-5"
                : role === "Oracle"
                  ? "fake-prov/gpt-5"
                  : "inherit",
            thinking: "inherit",
          },
        ]),
      ),
    },
    null,
    2,
  )}\n`,
  "utf8",
);
result = runPlan(FIXED_DEPENDENCIES, caseMRoot, {
  piVersion: "0.84.2",
  requestPath: modelsRequestPath,
  models: "provider model context\nfake-prov gpt-5 1M\n",
});
assert.equal(
  result.status,
  0,
  `bare and paired model pins must both resolve:\n${result.stderr}`,
);
const modelsPlanPath = result.stdout.trim().split(/\r?\n/)[0];
const modelsPlan = JSON.parse(readFileSync(modelsPlanPath, "utf8"));
assert.ok(
  modelsPlan.pi.models.includes("gpt-5"),
  "plan must record the bare model id",
);
assert.ok(
  modelsPlan.pi.models.includes("fake-prov/gpt-5"),
  "plan must record the provider/model pair",
);

// --- Documentation surface assertions (Task 3) ----------------------------
// Static checks that the installation contract and both READMEs stay aligned
// with the installer's fixed eight-dependency gate and the Goal policy.
// Assertions are deliberately local phrases, not whole-paragraph locks.
const docs = {
  "INSTALL_AGENT.md": readFileSync(
    join(projectRoot, "INSTALL_AGENT.md"),
    "utf8",
  ),
  "README.md": readFileSync(join(projectRoot, "README.md"), "utf8"),
  "README.zh-CN.md": readFileSync(join(projectRoot, "README.zh-CN.md"), "utf8"),
};
const docEntries = Object.entries(docs);
const orchestratorPolicy = readFileSync(
  join(
    projectRoot,
    "extensions",
    "orchestrator-mode",
    "orchestrator-policy.md",
  ),
  "utf8",
);
const orchestratorGoalPolicy = readFileSync(
  join(
    projectRoot,
    "extensions",
    "orchestrator-mode",
    "orchestrator-goal-policy.md",
  ),
  "utf8",
);
assert.match(
  orchestratorGoalPolicy,
  /only while the current session has an active Goal/,
  "Goal policy must state its active-Goal scope",
);
assert.ok(
  !/present in the current system prompt snapshot/.test(orchestratorGoalPolicy),
  "policy must not gate rules on a system prompt the model cannot inspect",
);
assert.ok(
  !/`state=` of `planned`/.test(orchestratorGoalPolicy),
  "policy must not pin a lane state enum that nothing consumes",
);
assert.match(
  orchestratorGoalPolicy,
  /Separate lanes with a pipe that has one space on each side/,
  "policy must keep the single-line lane separator",
);
assert.match(
  orchestratorGoalPolicy,
  /separate fields inside a lane with a semicolon followed by one space/i,
  "policy must keep the field separator",
);
assert.ok(
  !/fields by `; ?`/.test(orchestratorGoalPolicy),
  "lane separators must be described in prose so markdown autofix cannot strip their spaces",
);
assert.match(
  orchestratorGoalPolicy,
  /does not echo `metadata`/,
  "policy must keep lane records in description, not metadata",
);
assert.match(
  orchestratorGoalPolicy,
  /Never block on a non-terminal lane with `get_subagent_result\(wait: true\)`/,
  "policy must forbid blocking on a non-terminal background lane",
);
assert.match(
  orchestratorGoalPolicy,
  /dispatch\s+them as parallel background lanes in the same turn/,
  "policy must bias an active Goal toward parallel background lanes",
);
assert.match(
  orchestratorGoalPolicy,
  /never split one bounded action\s+into artificial lanes/,
  "policy must still allow a genuinely bounded Goal to be handled directly",
);
assert.match(
  orchestratorGoalPolicy,
  /resume_after_ms: 1800000/,
  "policy must keep the 30-minute goal_wait fallback",
);

// All three documents name both new packages.
for (const [name, text] of docEntries) {
  for (const pkg of ["@narumitw/pi-goal", "@juicesharp/rpiv-todo"]) {
    assert.ok(text.includes(pkg), `${name} must mention ${pkg}`);
  }
}

// Dependency count is eight, with no leftover "six dependencies" phrasing.
assert.match(
  docs["INSTALL_AGENT.md"],
  /All eight dependencies/,
  "INSTALL_AGENT.md must state eight dependencies",
);
assert.match(
  docs["README.md"],
  /eight required packages/,
  "README.md must say eight required packages",
);
assert.match(
  docs["README.zh-CN.md"],
  /八个必需包/,
  "README.zh-CN.md must say eight required packages",
);
for (const [name, text] of docEntries) {
  assert.ok(
    !/six (required )?packages?/i.test(text),
    `${name} must not leave a "six packages" phrasing`,
  );
  assert.ok(
    !/six dependencies/i.test(text),
    `${name} must not leave a "six dependencies" phrasing`,
  );
  assert.ok(
    !/六个\s*(必需)?\s*(依赖|包)/.test(text),
    `${name} must not leave a "six dependencies/packages" phrasing`,
  );
}
assert.ok(
  docs["INSTALL_AGENT.md"].includes("npm:@narumitw/pi-goal"),
  "INSTALL_AGENT.md fixed list must include npm:@narumitw/pi-goal",
);
assert.ok(
  docs["INSTALL_AGENT.md"].includes("npm:@juicesharp/rpiv-todo"),
  "INSTALL_AGENT.md fixed list must include npm:@juicesharp/rpiv-todo",
);
// Installer contract preserved: never installs/removes packages; missing
// dependencies surface only the fixed pi install command plus separate approval.
assert.match(
  docs["INSTALL_AGENT.md"],
  /never installs or removes packages/,
  "INSTALL_AGENT.md must keep the installer contract",
);
assert.match(
  docs["INSTALL_AGENT.md"],
  /pi install npm:<package>/,
  "INSTALL_AGENT.md must keep the fixed pi install command",
);
assert.match(
  docs["INSTALL_AGENT.md"],
  /separate approval/,
  "INSTALL_AGENT.md must require separate approval for missing dependencies",
);

// The user must explicitly start /goal; the Orchestrator never auto-starts it.
assert.match(
  docs["INSTALL_AGENT.md"],
  /must explicitly run a native/,
  "INSTALL_AGENT.md must require explicit /goal",
);
assert.match(
  docs["README.md"],
  /must explicitly run a native/,
  "README.md must require explicit /goal",
);
assert.match(
  docs["README.zh-CN.md"],
  /显式运行/,
  "README.zh-CN.md must require explicit /goal",
);
for (const [name, text] of docEntries) {
  assert.match(
    text,
    /\/goal <objective>/,
    `${name} must show the native /goal example`,
  );
  assert.match(
    text,
    /\/goal --tokens 100k <objective>/,
    `${name} must show the /goal --tokens example`,
  );
  assert.match(
    text,
    /never auto-starts? a Goal|永远不会自动启动 Goal/,
    `${name} must state the Orchestrator never auto-starts a Goal`,
  );
}

// Default mode still gains rpiv-todo's native tools/guidance; no
// "default mode completely unchanged" claim remains.
assert.match(
  docs["README.md"],
  /all modes/,
  "README.md must say all modes gain rpiv-todo",
);
assert.match(
  docs["README.zh-CN.md"],
  /所有模式/,
  "README.zh-CN.md must say all modes gain rpiv-todo",
);
for (const [name, text] of docEntries) {
  assert.ok(
    !/completely unchanged/i.test(text),
    `${name} must not claim the default mode is completely unchanged`,
  );
  assert.ok(
    !/完全不变/.test(text),
    `${name} must not claim the default mode is completely unchanged`,
  );
}

// Both READMEs disclose the budget scope and never present lanes/max_turns as
// a token-budget substitute.
assert.match(
  docs["README.md"],
  /does not include the independent subagent/,
  "README.md must disclose the budget excludes independent subagents",
);
assert.match(
  docs["README.zh-CN.md"],
  /不包含.{0,32}独立 subagent/,
  "README.zh-CN.md must disclose the budget excludes independent subagents",
);
assert.match(
  docs["README.md"],
  /`max_turns` is not a token-budget substitute/,
  "README.md must state lanes/max_turns are not a budget substitute",
);
assert.match(
  docs["README.zh-CN.md"],
  /`max_turns` 不是 token 预算的替代品/,
  "README.zh-CN.md must state lanes/max_turns are not a budget substitute",
);

// Pi floor/acceptance versions and the optional rpiv-i18n peer in both READMEs.
for (const [name, text] of [
  ["README.md", docs["README.md"]],
  ["README.zh-CN.md", docs["README.zh-CN.md"]],
]) {
  assert.match(text, />= 0\.80\.6/, `${name} must require Pi >= 0.80.6`);
  assert.match(
    text,
    /0\.84\.2/,
    `${name} must record the 0.84.2 acceptance environment`,
  );
  assert.match(
    text,
    /rpiv-i18n/,
    `${name} must explain the optional rpiv-i18n peer`,
  );
  assert.match(
    text,
    /agent_settled/,
    `${name} must explain the agent_settled requirement`,
  );
}

// The enforced version minimums are part of the installation contract.
for (const [name, text] of [
  ["README.md", docs["README.md"]],
  ["README.zh-CN.md", docs["README.zh-CN.md"]],
]) {
  assert.match(
    text,
    />= 0\.15\.0/,
    `${name} must require pi-subagents >= 0.15.0`,
  );
  assert.match(
    text,
    /enforces this minimum|在 `plan` 阶段强制/,
    `${name} must state the installer enforces the minimums`,
  );
}
assert.match(
  docs["INSTALL_AGENT.md"],
  /enforces minimum versions/,
  "INSTALL_AGENT.md must state the installer enforces version minimums",
);
assert.match(
  docs["INSTALL_AGENT.md"],
  />= 0\.15\.0/,
  "INSTALL_AGENT.md must state the pi-subagents minimum",
);
assert.match(
  docs["INSTALL_AGENT.md"],
  />= 0\.80\.6/,
  "INSTALL_AGENT.md must state the Pi minimum",
);

// No /ultragoal or UltraGoal Mode usage instructions in any document.
for (const [name, text] of docEntries) {
  assert.ok(
    !/\/ultragoal/i.test(text),
    `${name} must not document a /ultragoal command`,
  );
  assert.ok(
    !/UltraGoal Mode/.test(text),
    `${name} must not document an UltraGoal Mode`,
  );
}

// Third-party tables in both READMEs carry the accurate tested versions and
// upstream repositories.
for (const [name, text] of [
  ["README.md", docs["README.md"]],
  ["README.zh-CN.md", docs["README.zh-CN.md"]],
]) {
  assert.match(
    text,
    /@narumitw\/pi-goal`\s*\|\s*0\.51\.0\s*\|/,
    `${name} table must list pi-goal 0.51.0`,
  );
  assert.match(
    text,
    /@juicesharp\/rpiv-todo`\s*\|\s*2\.6\.0\s*\|/,
    `${name} table must list rpiv-todo 2.6.0`,
  );
  assert.match(
    text,
    /narumiruna\/pi-extensions/,
    `${name} table must reference the pi-goal repository`,
  );
  assert.match(
    text,
    /juicesharp\/rpiv-mono/,
    `${name} table must reference the rpiv-todo repository`,
  );
}

process.stdout.write(
  `Install dependency-gate, doc-surface, apply-success and rollback tests passed. Fixture retained at ${fixtureRoot}\n`,
);
