#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROLES = [
  "Explore",
  "librarian",
  "oracle",
  "designer",
  "fixer",
  "verifier",
];
const AGENT_IDS = ROLES.map((role) => `agents/${role}.md`);
const TARGET_IDS = [
  ...AGENT_IDS,
  "extensions/orchestrator-mode/index.ts",
  "extensions/orchestrator-mode/orchestrator-policy.md",
  "orchestrator-mode.json",
  "subagents.json",
  "settings.json",
];
const DEPENDENCIES = [
  "npm:@tintinweb/pi-subagents",
  "npm:@ff-labs/pi-fff",
  "npm:pi-web-access",
  "npm:pi-lens",
  "npm:@firstpick/pi-extension-safety-guard",
  "npm:@narumitw/pi-chrome-devtools",
  "npm:@narumitw/pi-goal",
  "npm:@juicesharp/rpiv-todo",
];
const THINKING = new Set([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const SUPPORTED_THINKING_LEVELS = [...THINKING].filter(
  (level) => level !== "inherit",
);
const ACTIONS = new Set(["install", "keep", "replace"]);
// A model identifier is either a bare id (pi-subagents frontmatter accepts
// fuzzy names) or a provider/model pair; both forms come from pi --list-models.
const MODEL_ID_RE = /^[A-Za-z0-9_.:@+~/-]+$/;
const PI_MINIMUM_VERSION = "0.80.6";
const PI_SUBAGENTS_IDENTIFIER = "npm:@tintinweb/pi-subagents";
const PI_SUBAGENTS_MINIMUM_VERSION = "0.15.0";
const PLAN_SCHEMA_VERSION = 2;
// The first `major.minor.patch` token in the output: real `pi --version`
// prints a bare version and test doubles print a `pi x.y.z` prefix, so the
// leading `(?:^|\s)` tolerates both. Comparison is numeric, never string
// ordering (0.9.0 must sort below 0.80.6).
const VERSION_TOKEN_RE =
  /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?=\s|$)/;
// One `pi list` package line: an npm identifier, optionally suffixed with
// "(filtered)". git: entries never match and are therefore ignored.
const PACKAGE_INVENTORY_RE =
  /^(npm:(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+)(?:\s+\(filtered\))?\s*$/;
const CMD_UNSAFE_RE = /["&|<>^%!\r\n]/;
// An apply lock older than this is reclaimed even when its recorded PID looks
// alive; a normal install never runs anywhere near this long.
const INSTALL_LOCK_STALE_MS = 60 * 60 * 1000;

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`${label} has unknown field: ${key}`);
}

function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = text.match(VERSION_TOKEN_RE);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index])
      return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function parseOptions(argv, allowed) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!allowed.has(arg)) fail(`Unknown option: ${arg}`);
    if (options[arg.slice(2)] !== undefined || argv[i + 1] === undefined)
      fail(`Invalid ${arg}`);
    options[arg.slice(2)] = argv[++i];
  }
  return options;
}

function parsePlanArgs(argv) {
  const options = parseOptions(argv, new Set(["--request", "--config-root"]));
  if (!options.request || !options["config-root"])
    fail("--request and --config-root are required");
  if (!isAbsolute(options.request) || !isAbsolute(options["config-root"]))
    fail("CLI paths must be absolute");
  return {
    request: resolve(options.request),
    configRoot: resolve(options["config-root"]),
  };
}

function parseApplyArgs(argv) {
  const options = parseOptions(argv, new Set(["--plan", "--sha256"]));
  if (!options.plan || !options.sha256)
    fail("--plan and --sha256 are required");
  if (!isAbsolute(options.plan)) fail("CLI paths must be absolute");
  if (!/^[a-f0-9]{64}$/i.test(options.sha256))
    fail("--sha256 must be exactly 64 hexadecimal characters");
  return {
    planPath: resolve(options.plan),
    approvedSha256: options.sha256.toLowerCase(),
  };
}

function ensureNoSymlink(pathname, label, allowMissing = true) {
  const absolute = resolve(pathname);
  const parsedRoot = isAbsolute(absolute)
    ? resolve(dirname(absolute), sep)
    : sep;
  let current = parsedRoot;
  const parts = absolute.slice(parsedRoot.length).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return;
      fail(`Cannot inspect ${label}: ${error.message}`);
    }
    if (info.isSymbolicLink())
      fail(`Symbolic links are not allowed in managed path: ${current}`);
  }
}

function contained(root, child, label) {
  const rel = relative(resolve(root), resolve(child));
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    fail(`${label} escapes its root`);
  return rel;
}

function containedReal(root, child, label) {
  contained(root, child, label);
  const realRoot = realpathSync(root);
  let existing = resolve(child);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) fail(`Cannot resolve ${label}`);
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  if (realExisting !== realRoot) contained(realRoot, realExisting, label);
}

function regularFile(pathname, label, required = false) {
  if (!existsSync(pathname)) {
    if (required) fail(`Missing ${label}: ${pathname}`);
    return false;
  }
  ensureNoSymlink(pathname, label, false);
  if (!lstatSync(pathname).isFile())
    fail(`${label} must be a regular file: ${pathname}`);
  return true;
}

function sha256(pathname) {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateRequest(request) {
  assertObject(request, "request");
  assertKeys(
    request,
    new Set(["routing", "orchestratorDefaultEnabled", "agents"]),
    "request",
  );
  if (!["strict", "compatibility"].includes(request.routing))
    fail("routing must be strict or compatibility");
  if (typeof request.orchestratorDefaultEnabled !== "boolean")
    fail("orchestratorDefaultEnabled must be boolean");
  assertObject(request.agents, "agents");
  if (
    Object.keys(request.agents).length !== ROLES.length ||
    ROLES.some((role) => !(role in request.agents))
  )
    fail(`agents must contain exactly ${ROLES.length} required roles`);
  for (const role of ROLES) {
    const choice = request.agents[role];
    assertObject(choice, `agents.${role}`);
    assertKeys(
      choice,
      new Set(["action", "model", "thinking"]),
      `agents.${role}`,
    );
    if (!ACTIONS.has(choice.action)) fail(`Invalid action for ${role}`);
    if (
      typeof choice.model !== "string" ||
      (!choice.model.trim() && choice.model !== "inherit")
    )
      fail(`Invalid model for ${role}`);
    if (typeof choice.thinking !== "string" || !THINKING.has(choice.thinking))
      fail(`Invalid thinking for ${role}`);
  }
  return request;
}

function readRequest(pathname) {
  regularFile(pathname, "request", true);
  let request;
  try {
    request = JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    fail(`Invalid request JSON: ${error.message}`);
  }
  return validateRequest(request);
}

function runPi(executable, args, configRoot) {
  let command = executable;
  let commandArgs = args;
  let windowsVerbatimArguments = false;
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    for (const value of [executable, ...args]) {
      if (CMD_UNSAFE_RE.test(value))
        fail("Unsafe character in Windows Pi command");
    }
    command = process.env.ComSpec || "cmd.exe";
    const invocation = [
      `"${executable}"`,
      ...args.map((arg) => `"${arg}"`),
    ].join(" ");
    commandArgs = ["/d", "/v:off", "/s", "/c", `"${invocation}"`];
    windowsVerbatimArguments = true;
  }
  let output;
  try {
    output = execFileSync(command, commandArgs, {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments,
      // Large model catalogs must not trip the 1 MiB default cap; the error
      // path surfaces the truncated-output message to the caller either way.
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PI_CODING_AGENT_DIR: configRoot },
    });
  } catch (error) {
    fail(
      `Pi command failed (${args.join(" ")}): ${error.stderr?.toString() || error.message}`,
    );
  }
  return output;
}

function inventoryListedPackages(listOutput) {
  // `pi list` prints one package identifier line followed by a more-indented
  // installation path line; "(filtered)" may suffix the identifier and git:
  // entries carry no version the installer can enforce, so they are ignored.
  const packages = new Map();
  const lines = listOutput.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const identifier = lines[index].trim().match(PACKAGE_INVENTORY_RE)?.[1];
    if (!identifier) continue;
    const pathLine = lines[index + 1];
    let pathname = null;
    if (pathLine && /^\s+\S/.test(pathLine) && isAbsolute(pathLine.trim())) {
      pathname = resolve(pathLine.trim());
      index += 1;
    }
    packages.set(identifier, pathname);
  }
  return packages;
}

function installedPackageVersion(pathname) {
  if (!pathname) return null;
  try {
    const value = JSON.parse(
      readFileSync(join(pathname, "package.json"), "utf8"),
    );
    return typeof value.version === "string" && value.version.trim()
      ? value.version.trim()
      : null;
  } catch {
    return null;
  }
}

function resolvePiExecutable() {
  return (
    process.env.PI_EXECUTABLE ||
    (process.platform === "win32" ? "pi.cmd" : "pi")
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Exclusive config-root lock for the whole apply transaction. Two concurrent
// applies must never interleave their preflight reads, writes, or rollbacks.
// The lock is reclaimed when its recorded owner is gone or the file is stale;
// explicit release is best-effort and crash-safe by that same reclamation.
function acquireInstallLock(lockPath) {
  const tryCreate = () => {
    try {
      writeFileSync(
        lockPath,
        canonical({ pid: process.pid, created_at: new Date().toISOString() }),
        { flag: "wx" },
      );
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return false;
    }
  };
  if (tryCreate()) return;
  let stale = false;
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof value.pid === "number" && !processIsAlive(value.pid))
      stale = true;
    if (typeof value.created_at === "string") {
      const created = Date.parse(value.created_at);
      if (
        Number.isFinite(created) &&
        Date.now() - created > INSTALL_LOCK_STALE_MS
      )
        stale = true;
    }
  } catch {
    stale = true;
  }
  if (stale) {
    rmSync(lockPath, { force: true });
    if (tryCreate()) return;
  }
  fail(
    `Another installation appears to be in progress (lock file: ${lockPath}). ` +
      `Wait for it to finish, or remove the lock file if it is stale.`,
  );
}

function releaseInstallLock(lockPath) {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    /* best-effort: a stale lock is reclaimed by the next acquire */
  }
}

function inventoryPi(configRoot) {
  const executable = resolvePiExecutable();
  const versionOutput = runPi(executable, ["--version"], configRoot).trim();
  const version = parseVersion(versionOutput);
  if (!version)
    fail(
      `Cannot parse Pi version from \`pi --version\` output: ${JSON.stringify(versionOutput)}; planning stops fail-closed`,
    );
  const versionText = version.join(".");
  if (compareVersions(version, parseVersion(PI_MINIMUM_VERSION)) < 0)
    fail(
      `Pi ${versionText} is below the required minimum ${PI_MINIMUM_VERSION}: ` +
        `@narumitw/pi-goal depends on Pi's agent_settled lifecycle event, so ` +
        `planning stops fail-closed. Update Pi and generate a new plan.`,
    );
  const listOutput = runPi(executable, ["list"], configRoot);
  const listedPackages = inventoryListedPackages(listOutput);
  const installed = DEPENDENCIES.filter((dependency) =>
    listedPackages.has(dependency),
  );
  if (installed.length !== DEPENDENCIES.length)
    fail(
      `Missing Pi dependencies: ${DEPENDENCIES.filter((item) => !installed.includes(item)).join(", ")}`,
    );
  const dependencyVersions = {};
  for (const dependency of DEPENDENCIES) {
    const dependencyVersion = installedPackageVersion(
      listedPackages.get(dependency),
    );
    if (dependency === PI_SUBAGENTS_IDENTIFIER) {
      const dependencyParts = parseVersion(dependencyVersion);
      if (
        !dependencyParts ||
        compareVersions(
          dependencyParts,
          parseVersion(PI_SUBAGENTS_MINIMUM_VERSION),
        ) < 0
      )
        fail(
          `${dependency} ${dependencyVersion ?? "installed version unknown"} is below the required minimum ` +
            `${PI_SUBAGENTS_MINIMUM_VERSION}: strict routing's ` +
            `fallbackSubagent: "none" only exists from ` +
            `${PI_SUBAGENTS_MINIMUM_VERSION}, so an older release would silently ` +
            `fall back to the permissive general-purpose Agent. Planning stops ` +
            `fail-closed; update the package and generate a new plan.`,
        );
    }
    dependencyVersions[dependency] = dependencyVersion;
  }
  const modelsOutput = runPi(executable, ["--list-models"], configRoot);
  const models = new Set();
  for (const line of modelsOutput.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length === 1) {
      if (
        columns[0] &&
        columns[0] !== "provider" &&
        MODEL_ID_RE.test(columns[0])
      )
        models.add(columns[0]);
      continue;
    }
    if (columns.length >= 2 && columns[0] !== "provider") {
      const combined = `${columns[0]}/${columns[1]}`;
      if (MODEL_ID_RE.test(combined)) models.add(combined);
      // Bare model ids are also pinnable (fuzzy frontmatter), so collect the
      // model column on its own as well.
      if (MODEL_ID_RE.test(columns[1])) models.add(columns[1]);
    }
  }
  return {
    executable,
    version: versionText,
    minimum_version: PI_MINIMUM_VERSION,
    dependencies: installed,
    dependency_versions: dependencyVersions,
    models: [...models],
  };
}

function validateJsonObject(pathname, label) {
  if (!regularFile(pathname, label)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    fail(`Invalid ${label} JSON: ${error.message}`);
  }
  assertObject(value, label);
  return value;
}

function targetState(destination, source, label) {
  const exists = regularFile(destination, label);
  const sourceExists = source
    ? regularFile(source, `template ${label}`, true)
    : false;
  const destinationHash = exists ? sha256(destination) : null;
  const sourceHash = sourceExists ? sha256(source) : null;
  return {
    state: exists
      ? sourceHash === destinationHash
        ? "identical"
        : "conflict"
      : "absent",
    exists_before: exists,
    destination_hash: destinationHash,
    template_hash: sourceHash,
  };
}

function planMain(argv) {
  const { request: requestPath, configRoot } = parsePlanArgs(argv);
  ensureNoSymlink(configRoot, "configuration root", false);
  if (!lstatSync(configRoot).isDirectory())
    fail("Configuration root must be a directory");
  const realConfigRoot = realpathSync(configRoot);
  const repositoryRoot = resolve(
    process.env.PI_OMO_REPOSITORY_ROOT ||
      join(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  ensureNoSymlink(repositoryRoot, "repository root", false);
  if (!lstatSync(repositoryRoot).isDirectory())
    fail("Repository root must be a directory");
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const request = readRequest(requestPath);
  const sources = expectedSourceMap(repositoryRoot);
  for (const id of TARGET_IDS)
    if (sources[id]) {
      containedReal(realRepositoryRoot, sources[id], "template");
      ensureNoSymlink(sources[id], "template", false);
    }
  const pi = inventoryPi(configRoot);
  for (const role of ROLES) {
    const model = request.agents[role].model;
    if (model !== "inherit" && !pi.models.includes(model))
      fail(`Unavailable pinned model for ${role}: ${model}`);
  }
  validateJsonObject(
    join(configRoot, "orchestrator-mode.json"),
    "orchestrator-mode.json",
  );
  validateJsonObject(join(configRoot, "subagents.json"), "subagents.json");
  validateJsonObject(join(configRoot, "settings.json"), "settings.json");
  const targets = TARGET_IDS.map((id) => {
    const destination = join(configRoot, id);
    containedReal(realConfigRoot, destination, `destination ${id}`);
    ensureNoSymlink(destination, `destination ${id}`);
    const state = targetState(destination, sources[id], id);
    let action = "install";
    if (id.startsWith("agents/")) {
      const requested = request.agents[id.slice(7, -3)].action;
      if (state.state === "conflict" && requested === "install")
        fail(`Conflict requires keep or replace: ${id}`);
      if (state.state !== "conflict" && requested !== "install")
        fail(
          `Action ${requested} is not allowed for ${state.state} destination: ${id}`,
        );
      action = requested;
    } else if (id === "orchestrator-mode.json") action = "merge";
    else if (id === "subagents.json")
      action = request.routing === "strict" ? "merge" : "keep";
    else if (id === "settings.json") action = "observe";
    else if (state.state === "identical") action = "keep";
    const mayModify = ["install", "replace", "merge"].includes(action);
    return {
      id,
      source: sources[id]
        ? relative(repositoryRoot, sources[id]).replaceAll(sep, "/")
        : null,
      destination: resolve(destination),
      state: state.state,
      exists_before: state.exists_before,
      planned_action: action,
      source_hash: state.template_hash,
      destination_hash: state.destination_hash,
      replacement_conflict_hash:
        state.state === "conflict" ? state.destination_hash : null,
      may_modify: mayModify,
    };
  });
  const customAgents = [];
  const agentsDir = join(configRoot, "agents");
  if (existsSync(agentsDir)) {
    ensureNoSymlink(agentsDir, "agents directory", false);
    if (!lstatSync(agentsDir).isDirectory()) fail("agents must be a directory");
    for (const name of readdirSync(agentsDir)) {
      const id = `agents/${name}`;
      const relation = agentNameRelation(agentsDir, name);
      if (relation === "exact" || relation === "same-file-variant") continue;
      if (relation === "independent-variant")
        fail(
          `Case-variant Agent ${id} conflicts with a managed Agent target: ` +
            `on case-sensitive filesystems both files would register as ` +
            `case-ambiguous agent types. Rename or remove it and generate a new plan.`,
        );
      const path = join(agentsDir, name);
      ensureNoSymlink(path, `custom Agent ${id}`, false);
      if (lstatSync(path).isFile())
        customAgents.push({ id, path: resolve(path), sha256: sha256(path) });
    }
  }
  const planId = `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomBytes(10).toString("hex")}`;
  const auditDir = join(configRoot, "install-records", planId);
  containedReal(realConfigRoot, auditDir, "audit directory");
  ensureNoSymlink(join(configRoot, "install-records"), "install-records");
  if (existsSync(auditDir)) fail(`Plan collision: ${auditDir}`);
  const rollbackDirectories = new Set();
  for (const target of targets.filter(
    (item) => !item.exists_before && item.may_modify,
  )) {
    let directory = dirname(target.destination);
    while (directory !== configRoot && !existsSync(directory)) {
      rollbackDirectories.add(directory);
      directory = dirname(directory);
    }
  }
  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    plan_id: planId,
    generated_at: new Date().toISOString(),
    status: "planned",
    repository_root: repositoryRoot,
    config_root: configRoot,
    request: {
      routing: request.routing,
      orchestratorDefaultEnabled: request.orchestratorDefaultEnabled,
      agents: Object.fromEntries(
        ROLES.map((role) => [role, { ...request.agents[role] }]),
      ),
    },
    pi: {
      executable: pi.executable,
      version: pi.version,
      minimum_version: pi.minimum_version,
      dependencies: pi.dependencies,
      dependency_versions: pi.dependency_versions,
      models: pi.models,
      accepted_thinking_levels: SUPPORTED_THINKING_LEVELS,
    },
    targets,
    unrelated_custom_agents: customAgents,
    backup_directory: join(configRoot, "backups", planId),
    rollback: {
      delete_files: targets
        .filter((target) => !target.exists_before && target.may_modify)
        .map((target) => target.destination),
      remove_empty_directories: [...rollbackDirectories].sort(
        (left, right) =>
          right.length - left.length || left.localeCompare(right),
      ),
    },
    template_hashes: Object.fromEntries(
      targets
        .filter((target) => target.source_hash)
        .map((target) => [target.source, target.source_hash]),
    ),
    replacement_conflict_hashes: Object.fromEntries(
      targets
        .filter((target) => target.replacement_conflict_hash)
        .map((target) => [target.id, target.replacement_conflict_hash]),
    ),
  };
  mkdirSync(dirname(auditDir), { recursive: true });
  mkdirSync(auditDir, { recursive: false });
  const planPath = join(auditDir, "plan.json");
  writeFileSync(planPath, canonical(plan), { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${planPath}\n${sha256(planPath)}\n`);
}

function readJsonObject(pathname, label, fallback = null) {
  if (!existsSync(pathname)) return fallback;
  regularFile(pathname, label, true);
  let value;
  try {
    value = JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    fail(`Invalid ${label} JSON: ${error.message}`);
  }
  assertObject(value, label);
  return value;
}

function jsonFromBuffer(buffer, label) {
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    fail(`Invalid ${label} JSON: ${error.message}`);
  }
  assertObject(value, label);
  return value;
}

function expectedSourceMap(repositoryRoot) {
  return Object.fromEntries([
    ...AGENT_IDS.map((id) => [id, join(repositoryRoot, id)]),
    [
      "extensions/orchestrator-mode/index.ts",
      join(repositoryRoot, "extensions/orchestrator-mode/index.ts"),
    ],
    [
      "extensions/orchestrator-mode/orchestrator-policy.md",
      join(
        repositoryRoot,
        "extensions/orchestrator-mode/orchestrator-policy.md",
      ),
    ],
    [
      "orchestrator-mode.json",
      join(repositoryRoot, "config/orchestrator-mode.json.example"),
    ],
    ["subagents.json", join(repositoryRoot, "config/subagents.json")],
    ["settings.json", null],
  ]);
}

function validatePlan(plan, planPath) {
  assertObject(plan, "plan");
  if (plan.schema_version !== PLAN_SCHEMA_VERSION || plan.status !== "planned")
    fail("Unsupported or non-planned install plan");
  if (
    typeof plan.plan_id !== "string" ||
    !/^[0-9]{14}-[a-f0-9]{20}$/.test(plan.plan_id)
  )
    fail("Invalid plan ID");
  if (
    !isAbsolute(plan.config_root) ||
    !isAbsolute(plan.repository_root) ||
    !isAbsolute(plan.backup_directory)
  )
    fail("Plan roots must be absolute");
  const configRoot = resolve(plan.config_root);
  const repositoryRoot = resolve(plan.repository_root);
  ensureNoSymlink(configRoot, "configuration root", false);
  ensureNoSymlink(repositoryRoot, "repository root", false);
  if (
    !lstatSync(configRoot).isDirectory() ||
    !lstatSync(repositoryRoot).isDirectory()
  )
    fail("Plan roots must be directories");
  const expectedPlanPath = join(
    configRoot,
    "install-records",
    plan.plan_id,
    "plan.json",
  );
  if (resolve(planPath) !== expectedPlanPath)
    fail("Plan path does not match its recorded audit directory");
  if (
    resolve(plan.backup_directory) !== join(configRoot, "backups", plan.plan_id)
  )
    fail("Invalid backup directory");
  assertObject(plan.request, "plan.request");
  validateRequest(plan.request);
  assertObject(plan.pi, "plan.pi");
  if (!Array.isArray(plan.pi.models) || !Array.isArray(plan.pi.dependencies))
    fail("Invalid Pi inventory in plan");
  if (plan.pi.minimum_version !== PI_MINIMUM_VERSION)
    fail("Invalid Pi minimum version in plan");
  if (!parseVersion(plan.pi.version))
    fail(`Invalid Pi version in plan: ${plan.pi.version}`);
  if (
    compareVersions(
      parseVersion(plan.pi.version),
      parseVersion(PI_MINIMUM_VERSION),
    ) < 0
  )
    fail(
      `Pi ${plan.pi.version} in plan is below the required minimum ${PI_MINIMUM_VERSION}`,
    );
  if (
    plan.pi.dependencies.length !== DEPENDENCIES.length ||
    DEPENDENCIES.some(
      (identifier, index) => plan.pi.dependencies[index] !== identifier,
    )
  )
    fail("Invalid Pi dependency list in plan");
  assertObject(plan.pi.dependency_versions, "plan.pi.dependency_versions");
  const dependencyVersionKeys = Object.keys(plan.pi.dependency_versions);
  if (
    dependencyVersionKeys.length !== DEPENDENCIES.length ||
    DEPENDENCIES.some(
      (identifier) => !(identifier in plan.pi.dependency_versions),
    )
  )
    fail("Invalid dependency versions in plan");
  for (const [identifier, dependencyVersion] of Object.entries(
    plan.pi.dependency_versions,
  )) {
    if (dependencyVersion !== null && typeof dependencyVersion !== "string")
      fail(`Invalid dependency version for ${identifier}`);
    if (identifier === PI_SUBAGENTS_IDENTIFIER) {
      const dependencyParts = parseVersion(dependencyVersion);
      if (
        !dependencyParts ||
        compareVersions(
          dependencyParts,
          parseVersion(PI_SUBAGENTS_MINIMUM_VERSION),
        ) < 0
      )
        fail(
          `${identifier} version ${dependencyVersion} in plan is below the required minimum ${PI_SUBAGENTS_MINIMUM_VERSION}`,
        );
    }
  }
  for (const role of ROLES) {
    const model = plan.request.agents[role].model;
    if (
      model !== "inherit" &&
      (!MODEL_ID_RE.test(model) || !plan.pi.models.includes(model))
    )
      fail(`Invalid pinned model in plan for ${role}`);
  }
  if (!Array.isArray(plan.targets) || plan.targets.length !== TARGET_IDS.length)
    fail(`Plan must contain exactly ${TARGET_IDS.length} targets`);
  const targetIds = plan.targets.map((target) => target?.id);
  if (
    new Set(targetIds).size !== TARGET_IDS.length ||
    TARGET_IDS.some((id) => !targetIds.includes(id))
  )
    fail("Plan target IDs are invalid");
  const sources = expectedSourceMap(repositoryRoot);
  for (const target of plan.targets) {
    assertObject(target, `target ${target?.id}`);
    if (resolve(target.destination) !== join(configRoot, target.id))
      fail(`Invalid destination for ${target.id}`);
    containedReal(
      realpathSync(configRoot),
      target.destination,
      `destination ${target.id}`,
    );
    const expectedSource = sources[target.id];
    const expectedSourceId = expectedSource
      ? relative(repositoryRoot, expectedSource).replaceAll(sep, "/")
      : null;
    if (target.source !== expectedSourceId)
      fail(`Invalid source for ${target.id}`);
    if (expectedSource && !/^[a-f0-9]{64}$/.test(target.source_hash))
      fail(`Invalid source hash for ${target.id}`);
    if (!expectedSource && target.source_hash !== null)
      fail(`Unexpected source hash for ${target.id}`);
    if (
      typeof target.exists_before !== "boolean" ||
      typeof target.may_modify !== "boolean"
    )
      fail(`Invalid state for ${target.id}`);
    if (
      !["absent", "identical", "conflict"].includes(target.state) ||
      target.exists_before !== (target.state !== "absent")
    )
      fail(`Invalid planned state for ${target.id}`);
    let expectedAction;
    if (target.id.startsWith("agents/")) {
      const role = target.id.slice(7, -3);
      expectedAction = plan.request.agents[role].action;
      if (
        target.state === "conflict"
          ? !["keep", "replace"].includes(expectedAction)
          : expectedAction !== "install"
      )
        fail(`Invalid Agent action for ${target.id}`);
    } else if (target.id === "orchestrator-mode.json") expectedAction = "merge";
    else if (target.id === "subagents.json")
      expectedAction = plan.request.routing === "strict" ? "merge" : "keep";
    else if (target.id === "settings.json") expectedAction = "observe";
    else expectedAction = target.state === "identical" ? "keep" : "install";
    const expectedMayModify = ["install", "replace", "merge"].includes(
      expectedAction,
    );
    if (
      target.planned_action !== expectedAction ||
      target.may_modify !== expectedMayModify
    )
      fail(`Invalid planned operation for ${target.id}`);
    if (target.state === "conflict") {
      if (
        !/^[a-f0-9]{64}$/.test(target.destination_hash) ||
        target.replacement_conflict_hash !== target.destination_hash
      )
        fail(`Invalid conflict hash for ${target.id}`);
    } else if (target.replacement_conflict_hash !== null)
      fail(`Unexpected conflict hash for ${target.id}`);
  }
  assertObject(plan.rollback, "plan.rollback");
  if (
    !Array.isArray(plan.rollback.delete_files) ||
    !Array.isArray(plan.rollback.remove_empty_directories)
  )
    fail("Invalid rollback lists");
  const approvedDeletes = new Set(
    plan.targets
      .filter((target) => !target.exists_before && target.may_modify)
      .map((target) => target.destination),
  );
  if (
    plan.rollback.delete_files.length !== approvedDeletes.size ||
    plan.rollback.delete_files.some(
      (pathname) => !approvedDeletes.has(pathname),
    )
  )
    fail("Invalid rollback delete list");
  for (const pathname of plan.rollback.remove_empty_directories) {
    containedReal(realpathSync(configRoot), pathname, "rollback directory");
    if (
      ![...approvedDeletes].some((file) => {
        const rel = relative(pathname, file);
        return (
          rel !== "" &&
          rel !== ".." &&
          !rel.startsWith(`..${sep}`) &&
          !isAbsolute(rel)
        );
      })
    )
      fail(
        `Rollback directory is not an ancestor of an approved file: ${pathname}`,
      );
  }
  return { configRoot, repositoryRoot, sources };
}

function transformAgent(sourceBytes, choice, role) {
  const text = sourceBytes.toString("utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const delimiters = lines
    .map((line, index) => (line === "---" ? index : -1))
    .filter((index) => index !== -1);
  if (delimiters.length !== 2 || delimiters[0] !== 0 || delimiters[1] <= 1)
    fail(`Invalid frontmatter delimiters for ${role}`);
  const frontmatter = lines
    .slice(1, delimiters[1])
    .filter((line) => !/^(?:model|thinking):\s*/.test(line));
  if (choice.model !== "inherit") frontmatter.push(`model: ${choice.model}`);
  if (choice.thinking !== "inherit")
    frontmatter.push(`thinking: ${choice.thinking}`);
  const transformed = [
    "---",
    ...frontmatter,
    "---",
    ...lines.slice(delimiters[1] + 1),
  ].join(newline);
  return Buffer.from(transformed, "utf8");
}

// Classifies an agents-directory entry against the six managed Agent targets:
// "exact" (a managed target), "same-file-variant" (a case-variant that the
// filesystem resolves to the exact target file, i.e. a case-insensitive
// filesystem), "independent-variant" (a separate file on a case-sensitive
// filesystem, which would register as a case-ambiguous agent type next to its
// managed target), or null (unrelated).
function agentNameRelation(agentsDir, name) {
  const id = `agents/${name}`;
  if (AGENT_IDS.includes(id)) return "exact";
  const variant = AGENT_IDS.find(
    (agentId) => agentId.toLowerCase() === id.toLowerCase(),
  );
  if (!variant) return null;
  const exactPath = join(agentsDir, variant.slice("agents/".length));
  return existsSync(exactPath) ? "same-file-variant" : "independent-variant";
}

function snapshotUnrelatedAgents(configRoot) {
  const result = new Map();
  const agentsDir = join(configRoot, "agents");
  if (!existsSync(agentsDir)) return result;
  ensureNoSymlink(agentsDir, "agents directory", false);
  for (const name of readdirSync(agentsDir)) {
    const id = `agents/${name}`;
    const relation = agentNameRelation(agentsDir, name);
    if (relation === "exact" || relation === "same-file-variant") continue;
    if (relation === "independent-variant")
      fail(
        `Case-variant Agent ${id} appeared after plan approval: ` +
          `it would register as a case-ambiguous agent type next to its managed target.`,
      );
    const pathname = join(agentsDir, name);
    ensureNoSymlink(pathname, `unrelated Agent ${id}`, false);
    if (lstatSync(pathname).isFile()) result.set(id, sha256(pathname));
  }
  return result;
}

function injectFailure(checkpoint) {
  if (
    process.env.PI_OMO_INSTALL_TEST_MODE === "1" &&
    process.env.PI_OMO_INSTALL_TEST_FAILURE === checkpoint
  ) {
    fail(`Injected failure at ${checkpoint}`);
  }
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Test-only pause: lets the test suite mutate sources/targets between installer
// phases to prove drift cannot be installed. Never active outside PI_OMO_INSTALL_TEST_MODE.
function testPause(checkpoint) {
  if (
    process.env.PI_OMO_INSTALL_TEST_MODE !== "1" ||
    process.env.PI_OMO_INSTALL_TEST_PAUSE !== checkpoint
  )
    return;
  const marker = process.env.PI_OMO_INSTALL_TEST_PAUSE_MARKER;
  const resume = process.env.PI_OMO_INSTALL_TEST_PAUSE_RESUME;
  if (marker) writeFileSync(marker, checkpoint);
  if (resume) {
    const deadline = Date.now() + 60000;
    while (!existsSync(resume)) {
      if (Date.now() > deadline) fail(`Test pause timed out at ${checkpoint}`);
      sleepMs(10);
    }
  }
}

function applyMain(argv) {
  const { planPath, approvedSha256 } = parseApplyArgs(argv);
  regularFile(planPath, "plan", true);
  const planBytes = readFileSync(planPath);
  const actualPlanSha = createHash("sha256").update(planBytes).digest("hex");
  if (actualPlanSha !== approvedSha256)
    fail("Approved plan SHA-256 does not match plan bytes");
  let plan;
  try {
    plan = JSON.parse(planBytes.toString("utf8"));
  } catch (error) {
    fail(`Invalid plan JSON: ${error.message}`);
  }
  const { configRoot, repositoryRoot, sources } = validatePlan(plan, planPath);
  // Re-verify the environment at apply time: it may have drifted between plan
  // approval and execution. inventoryPi re-checks the Pi floor and the
  // dependency minimums fail-closed; the checks below pin the execution
  // environment to what the approved plan recorded.
  const applyInventory = inventoryPi(configRoot);
  if (applyInventory.version !== plan.pi.version)
    fail(
      `Pi version changed since plan approval: plan ${plan.pi.version}, ` +
        `current ${applyInventory.version}; generate a new plan.`,
    );
  for (const [identifier, plannedVersion] of Object.entries(
    plan.pi.dependency_versions,
  )) {
    const currentVersion = applyInventory.dependency_versions[identifier];
    if (currentVersion !== plannedVersion)
      fail(
        `${identifier} version changed since plan approval: plan ` +
          `${plannedVersion}, current ${currentVersion}; generate a new plan.`,
      );
  }
  for (const role of ROLES) {
    const model = plan.request.agents[role].model;
    if (model !== "inherit" && !applyInventory.models.includes(model))
      fail(
        `Pinned model ${model} for ${role} is no longer available; ` +
          `generate a new plan.`,
      );
  }
  const installLockPath = join(configRoot, "install-records", ".install.lock");
  acquireInstallLock(installLockPath);
  const auditDir = dirname(planPath);
  const attemptPath = join(auditDir, "apply-started.json");
  const resultPath = join(auditDir, "result.json");
  const rollbackPath = join(auditDir, "rollback.json");
  if (
    existsSync(attemptPath) ||
    existsSync(resultPath) ||
    existsSync(plan.backup_directory)
  )
    fail("Plan has already been attempted or its output paths exist");

  const verifiedSources = new Map();
  for (const target of plan.targets) {
    if (target.source) {
      const sourcePath = sources[target.id];
      regularFile(sourcePath, `source ${target.id}`, true);
      containedReal(
        realpathSync(repositoryRoot),
        sourcePath,
        `source ${target.id}`,
      );
      const bytes = readFileSync(sourcePath);
      if (sha256Bytes(bytes) !== target.source_hash)
        fail(`Source drift detected: ${target.id}`);
      verifiedSources.set(target.id, bytes);
    }
    const destinationExists = existsSync(target.destination);
    if (target.planned_action === "replace") {
      if (
        !destinationExists ||
        sha256(target.destination) !== target.replacement_conflict_hash
      )
        fail(`Approved replacement drift detected: ${target.id}`);
    }
    if (!target.exists_before && destinationExists)
      fail(`Destination appeared after approval: ${target.id}`);
    if (target.exists_before && !destinationExists)
      fail(`Destination disappeared after approval: ${target.id}`);
  }
  testPause("after_preflight");

  const routingTemplate = jsonFromBuffer(
    verifiedSources.get("subagents.json"),
    "routing template",
  );
  const beforeHashes = new Map();
  for (const target of plan.targets)
    if (existsSync(target.destination))
      beforeHashes.set(target.id, sha256(target.destination));
  const unrelatedAgents = snapshotUnrelatedAgents(configRoot);
  // Fresh installs merge over the repository template instead of an empty
  // object, so future example keys are preserved rather than silently dropped.
  const orchestratorBefore = readJsonObject(
    join(configRoot, "orchestrator-mode.json"),
    "orchestrator-mode.json",
    null,
  );
  const orchestratorBase =
    orchestratorBefore ??
    jsonFromBuffer(
      verifiedSources.get("orchestrator-mode.json"),
      "orchestrator template",
    );
  const routingBefore = readJsonObject(
    join(configRoot, "subagents.json"),
    "subagents.json",
    null,
  );
  readJsonObject(join(configRoot, "settings.json"), "settings.json", null);

  writeFileSync(
    attemptPath,
    canonical({
      plan_id: plan.plan_id,
      started_at: new Date().toISOString(),
      approved_sha256: approvedSha256,
    }),
    { flag: "wx" },
  );
  const transaction = { files: [], directories: [], operations: [] };
  const temporaryFiles = new Set();
  const backupById = new Map();
  const existedAtBackup = new Map();
  const hashAtBackup = new Map();
  let createCount = 0;
  let replacementCount = 0;

  function ensureManagedParent(pathname) {
    const missing = [];
    let current = dirname(pathname);
    while (current !== configRoot && !existsSync(current)) {
      missing.push(current);
      current = dirname(current);
    }
    for (const directory of missing.reverse()) {
      if (!plan.rollback.remove_empty_directories.includes(directory))
        fail(`Directory creation was not approved: ${directory}`);
      mkdirSync(directory, { recursive: false });
      transaction.directories.push(directory);
    }
  }

  function writeManaged(target, bytes) {
    containedReal(
      realpathSync(configRoot),
      target.destination,
      `write ${target.id}`,
    );
    ensureNoSymlink(target.destination, `write ${target.id}`);
    ensureManagedParent(target.destination);
    const existed = existsSync(target.destination);
    if (existed !== existedAtBackup.get(target.id))
      fail(`Target changed after backup: ${target.id}`);
    if (existed && sha256(target.destination) !== hashAtBackup.get(target.id))
      fail(`Target content changed after backup: ${target.id}`);
    // Same-directory temporary file (unique random name, exclusive create), verified,
    // then re-checked and renamed over the destination for the narrowest write window.
    const tempPath = join(
      dirname(target.destination),
      `.install-tmp-${randomBytes(8).toString("hex")}`,
    );
    try {
      writeFileSync(tempPath, bytes, { flag: "wx" });
      temporaryFiles.add(tempPath);
      if (!readFileSync(tempPath).equals(bytes))
        fail(`Temp write verification failed: ${target.id}`);
      testPause("after_temp_write");
      containedReal(
        realpathSync(configRoot),
        target.destination,
        `write ${target.id}`,
      );
      ensureNoSymlink(target.destination, `write ${target.id}`);
      // Narrow the write window to the two calls between this re-check and the
      // atomic rename: refuse to overwrite a destination that appeared or
      // changed after the backup snapshot.
      const existedNow = existsSync(target.destination);
      if (existedNow !== existedAtBackup.get(target.id))
        fail(`Target changed after backup: ${target.id}`);
      if (
        existedNow &&
        sha256(target.destination) !== hashAtBackup.get(target.id)
      )
        fail(`Target content changed after backup: ${target.id}`);
      renameSync(tempPath, target.destination);
      temporaryFiles.delete(tempPath);
    } catch (error) {
      temporaryFiles.delete(tempPath);
      try {
        rmSync(tempPath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
      throw error;
    }
    const backup = backupById.get(target.id) || null;
    transaction.files.push({
      id: target.id,
      path: target.destination,
      existed,
      backup,
      installed_sha256: sha256Bytes(bytes),
    });
    transaction.operations.push({
      type: existed ? "replace" : "create",
      id: target.id,
      path: target.destination,
    });
    if (existed) {
      replacementCount += 1;
      if (replacementCount === 1) injectFailure("after_first_replacement");
    } else {
      createCount += 1;
      if (createCount === 1) injectFailure("after_first_create");
    }
  }

  function writeRecord(pathname, value) {
    writeFileSync(pathname, canonical(value), { flag: "wx" });
  }

  try {
    const backupsRoot = dirname(plan.backup_directory);
    containedReal(realpathSync(configRoot), backupsRoot, "backups directory");
    ensureNoSymlink(backupsRoot, "backups directory");
    mkdirSync(backupsRoot, { recursive: true });
    ensureNoSymlink(backupsRoot, "backups directory", false);
    mkdirSync(plan.backup_directory, { recursive: false });
    const manifestTargets = [];
    for (const target of plan.targets) {
      const existed = existsSync(target.destination);
      existedAtBackup.set(target.id, existed);
      const shouldBackup =
        existed && (target.may_modify || target.id === "settings.json");
      let backupPath = null;
      const originalHash = existed ? sha256(target.destination) : null;
      hashAtBackup.set(target.id, originalHash);
      let backupHash = null;
      if (shouldBackup) {
        backupPath = join(plan.backup_directory, target.id);
        mkdirSync(dirname(backupPath), { recursive: true });
        copyFileSync(target.destination, backupPath);
        backupHash = sha256(backupPath);
        if (backupHash !== originalHash)
          fail(`Backup verification failed: ${target.id}`);
        backupById.set(target.id, backupPath);
      }
      manifestTargets.push({
        id: target.id,
        existed,
        may_modify: target.may_modify,
        original_sha256: originalHash,
        backup_path: backupPath,
        backup_sha256: backupHash,
      });
    }
    const manifestPath = join(plan.backup_directory, "manifest.json");
    writeFileSync(
      manifestPath,
      canonical({
        schema_version: 1,
        plan_id: plan.plan_id,
        created_at: new Date().toISOString(),
        targets: manifestTargets,
      }),
      { flag: "wx" },
    );
    injectFailure("after_backup");
    testPause("after_backup");

    for (const role of ROLES) {
      const target = plan.targets.find(
        (item) => item.id === `agents/${role}.md`,
      );
      if (!target.may_modify) continue;
      writeManaged(
        target,
        transformAgent(
          verifiedSources.get(target.id),
          plan.request.agents[role],
          role,
        ),
      );
    }
    for (const id of [
      "extensions/orchestrator-mode/index.ts",
      "extensions/orchestrator-mode/orchestrator-policy.md",
    ]) {
      const target = plan.targets.find((item) => item.id === id);
      if (target.may_modify) writeManaged(target, verifiedSources.get(id));
    }
    const orchestratorTarget = plan.targets.find(
      (item) => item.id === "orchestrator-mode.json",
    );
    writeManaged(
      orchestratorTarget,
      Buffer.from(
        canonical({
          ...orchestratorBase,
          defaultEnabled: plan.request.orchestratorDefaultEnabled,
        }),
      ),
    );
    if (plan.request.routing === "strict") {
      const routingTarget = plan.targets.find(
        (item) => item.id === "subagents.json",
      );
      const routingBase = routingBefore ?? routingTemplate;
      writeManaged(
        routingTarget,
        Buffer.from(
          canonical({
            ...routingBase,
            disableDefaultAgents: true,
            fallbackSubagent: "none",
          }),
        ),
      );
    }
    injectFailure("after_json_merge");
    testPause("after_json_merge");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest.targets.length !== TARGET_IDS.length ||
      new Set(manifest.targets.map((item) => item.id)).size !==
        TARGET_IDS.length
    )
      fail("Manifest target set is invalid");
    for (const item of manifest.targets)
      if (item.backup_path && sha256(item.backup_path) !== item.backup_sha256)
        fail(`Backup hash mismatch: ${item.id}`);
    for (const role of ROLES) {
      const target = plan.targets.find(
        (item) => item.id === `agents/${role}.md`,
      );
      if (target.may_modify) {
        const expected = transformAgent(
          verifiedSources.get(target.id),
          plan.request.agents[role],
          role,
        );
        if (!readFileSync(target.destination).equals(expected))
          fail(`Installed Agent verification failed: ${role}`);
        const installedText = expected.toString("utf8");
        if (
          (installedText.match(/^---\r?$/gm) || []).length !== 2 ||
          /^allowed_subagents:/m.test(installedText) ||
          !/^inherit_context: false\r?$/m.test(installedText) ||
          !/^prompt_mode: replace\r?$/m.test(installedText)
        )
          fail(`Agent safety verification failed: ${role}`);
      } else if (beforeHashes.get(target.id) !== sha256(target.destination))
        fail(`Kept Agent changed: ${role}`);
    }
    for (const id of [
      "extensions/orchestrator-mode/index.ts",
      "extensions/orchestrator-mode/orchestrator-policy.md",
    ]) {
      const target = plan.targets.find((item) => item.id === id);
      if (
        target.may_modify &&
        !readFileSync(target.destination).equals(verifiedSources.get(id))
      )
        fail(`Extension verification failed: ${id}`);
    }
    const actualOrchestrator = readJsonObject(
      orchestratorTarget.destination,
      "orchestrator-mode.json",
      null,
    );
    if (
      canonical(actualOrchestrator) !==
      canonical({
        ...orchestratorBase,
        defaultEnabled: plan.request.orchestratorDefaultEnabled,
      })
    )
      fail("Orchestrator verification failed");
    const routingTarget = plan.targets.find(
      (item) => item.id === "subagents.json",
    );
    if (plan.request.routing === "strict") {
      const routingBase = routingBefore ?? routingTemplate;
      if (
        canonical(
          readJsonObject(routingTarget.destination, "subagents.json", null),
        ) !==
        canonical({
          ...routingBase,
          disableDefaultAgents: true,
          fallbackSubagent: "none",
        })
      )
        fail("Strict routing verification failed");
    } else if (
      beforeHashes.has(routingTarget.id)
        ? sha256(routingTarget.destination) !==
          beforeHashes.get(routingTarget.id)
        : existsSync(routingTarget.destination)
    )
      fail("Compatibility routing changed");
    const settingsTarget = plan.targets.find(
      (item) => item.id === "settings.json",
    );
    if (
      beforeHashes.has(settingsTarget.id)
        ? sha256(settingsTarget.destination) !==
          beforeHashes.get(settingsTarget.id)
        : existsSync(settingsTarget.destination)
    )
      fail("settings.json changed");
    const unrelatedAfter = snapshotUnrelatedAgents(configRoot);
    if (
      unrelatedAfter.size !== unrelatedAgents.size ||
      [...unrelatedAgents].some(([id, hash]) => unrelatedAfter.get(id) !== hash)
    )
      fail("Unrelated Agent changed");
    injectFailure("during_verification");
    writeRecord(resultPath, {
      schema_version: 1,
      plan_id: plan.plan_id,
      status: "succeeded",
      completed_at: new Date().toISOString(),
      manifest: manifestPath,
      operations: transaction.operations,
    });
    releaseInstallLock(installLockPath);
    process.stdout.write(`${resultPath}\n`);
  } catch (error) {
    const compensations = [];
    const unresolved = [];
    let simulatedRollbackFailure =
      process.env.PI_OMO_INSTALL_TEST_MODE === "1" &&
      process.env.PI_OMO_INSTALL_TEST_ROLLBACK_FAILURE === "first";
    for (const file of [...transaction.files].reverse()) {
      try {
        if (simulatedRollbackFailure) {
          simulatedRollbackFailure = false;
          throw new Error("Injected rollback failure");
        }
        if (file.existed) {
          if (!file.backup) throw new Error("Missing verified backup");
          // Re-check containment and symlink state before restoring: never let
          // copyFileSync follow a destination or ancestor that became a
          // symlink/junction after the transaction wrote it.
          containedReal(
            realpathSync(configRoot),
            file.path,
            `restore ${file.path}`,
          );
          ensureNoSymlink(file.path, `restore ${file.path}`);
          // Ownership check: only overwrite a destination that still holds the
          // bytes this transaction wrote. A concurrent writer's changes are
          // never clobbered by rollback; they surface as unresolved instead.
          if (
            existsSync(file.path) &&
            sha256(file.path) !== file.installed_sha256
          )
            throw new Error(
              `Target changed after install; refusing to overwrite with backup: ${file.path}`,
            );
          copyFileSync(file.backup, file.path);
        } else if (existsSync(file.path)) {
          // Re-check containment and symlink state before deleting: never let
          // rmSync follow a destination or ancestor that became a symlink/
          // junction after the transaction created the file.
          containedReal(
            realpathSync(configRoot),
            file.path,
            `delete ${file.path}`,
          );
          ensureNoSymlink(file.path, `delete ${file.path}`);
          // Ownership check: only delete a file that still holds the bytes this
          // transaction created; a concurrent replacement is left in place and
          // reported as unresolved rather than silently removed.
          if (sha256(file.path) !== file.installed_sha256)
            throw new Error(
              `Target changed after install; refusing to delete: ${file.path}`,
            );
          rmSync(file.path, { force: true });
        }
        compensations.push({
          type: file.existed ? "restore" : "delete",
          path: file.path,
          status: "succeeded",
        });
      } catch (rollbackError) {
        unresolved.push(file.path);
        compensations.push({
          type: file.existed ? "restore" : "delete",
          path: file.path,
          status: "failed",
          error: rollbackError.message,
        });
      }
    }
    for (const directory of [...transaction.directories].reverse()) {
      try {
        if (existsSync(directory)) rmdirSync(directory);
        compensations.push({
          type: "remove_empty_directory",
          path: directory,
          status: "succeeded",
        });
      } catch (rollbackError) {
        unresolved.push(directory);
        compensations.push({
          type: "remove_empty_directory",
          path: directory,
          status: "failed",
          error: rollbackError.message,
        });
      }
    }
    for (const tempPath of temporaryFiles) {
      try {
        rmSync(tempPath, { force: true });
        compensations.push({
          type: "remove_temp_file",
          path: tempPath,
          status: "succeeded",
        });
      } catch (rollbackError) {
        unresolved.push(tempPath);
        compensations.push({
          type: "remove_temp_file",
          path: tempPath,
          status: "failed",
          error: rollbackError.message,
        });
      }
    }
    const status =
      unresolved.length === 0 ? "rolled_back" : "rollback_incomplete";
    writeRecord(rollbackPath, {
      schema_version: 1,
      plan_id: plan.plan_id,
      status,
      failed_at: new Date().toISOString(),
      cause: error.message,
      compensations,
      unresolved_paths: unresolved,
    });
    writeRecord(resultPath, {
      schema_version: 1,
      plan_id: plan.plan_id,
      status,
      completed_at: new Date().toISOString(),
      error: error.message,
      unresolved_paths: unresolved,
    });
    releaseInstallLock(installLockPath);
    fail(
      `Installation failed and ${status === "rolled_back" ? "was rolled back" : "rollback is incomplete"}: ${error.message}`,
    );
  }
}

function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand === "plan") return planMain(argv);
  if (subcommand === "apply") return applyMain(argv);
  fail("Subcommand must be plan or apply");
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
