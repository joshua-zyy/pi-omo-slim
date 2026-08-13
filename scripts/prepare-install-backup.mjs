import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const AGENT_TARGETS = [
	"agents/Explore.md",
	"agents/librarian.md",
	"agents/oracle.md",
	"agents/designer.md",
	"agents/fixer.md",
];

const OTHER_TARGETS = [
	"settings.json",
	"extensions/orchestrator-mode/index.ts",
	"extensions/orchestrator-mode/orchestrator-policy.md",
	"orchestrator-mode.json",
	"subagents.json",
];

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const options = { keptAgents: new Set() };

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const value = argv[index + 1];

		switch (argument) {
			case "--config-root":
				if (!value) fail("Missing value for --config-root");
				options.configRoot = value;
				index += 1;
				break;
			case "--backup-dir":
				if (!value) fail("Missing value for --backup-dir");
				options.backupDir = value;
				index += 1;
				break;
			case "--routing":
				if (!value) fail("Missing value for --routing");
				options.routing = value;
				index += 1;
				break;
			case "--keep-agent":
				if (!value) fail("Missing value for --keep-agent");
				options.keptAgents.add(value);
				index += 1;
				break;
			default:
				fail(`Unknown argument: ${argument}`);
		}
	}

	if (!options.configRoot) fail("--config-root is required");
	if (!options.backupDir) fail("--backup-dir is required");
	if (!isAbsolute(options.configRoot)) fail("--config-root must be absolute");
	if (!isAbsolute(options.backupDir)) fail("--backup-dir must be absolute");
	if (!new Set(["strict", "compatibility"]).has(options.routing)) {
		fail("--routing must be strict or compatibility");
	}

	const validAgents = new Set(AGENT_TARGETS.map((target) => target.slice(7)));
	for (const name of options.keptAgents) {
		if (!validAgents.has(name)) fail(`Unknown Agent name: ${name}`);
	}

	return options;
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const options = parseArgs(process.argv.slice(2));
const configRoot = resolve(options.configRoot);
const backupDir = resolve(options.backupDir);
const backupsRoot = join(configRoot, "backups");
const backupRelativePath = relative(backupsRoot, backupDir);

if (!existsSync(configRoot) || !statSync(configRoot).isDirectory()) {
	fail(`Configuration root is not a directory: ${configRoot}`);
}
if (
	!backupRelativePath ||
	backupRelativePath.startsWith("..") ||
	isAbsolute(backupRelativePath)
) {
	fail(`--backup-dir must be a child of ${backupsRoot}`);
}
if (existsSync(backupDir))
	fail(`Backup directory already exists: ${backupDir}`);
for (const name of options.keptAgents) {
	const keptPath = join(configRoot, "agents", name);
	if (!existsSync(keptPath) || !lstatSync(keptPath).isFile()) {
		fail(`--keep-agent requires an existing regular file: ${keptPath}`);
	}
}

const targets = [...AGENT_TARGETS, ...OTHER_TARGETS];
const timestamp = new Date().toISOString();
const manifestTargets = [];

mkdirSync(backupDir, { recursive: true });

for (const relativePath of targets) {
	const originalPath = join(configRoot, relativePath);
	const isKeptAgent =
		relativePath.startsWith("agents/") &&
		options.keptAgents.has(relativePath.slice(7));
	const mayModify =
		!isKeptAgent &&
		(relativePath !== "subagents.json" || options.routing === "strict");
	const existed = existsSync(originalPath);

	if (existed && !lstatSync(originalPath).isFile()) {
		fail(`Expected a regular file: ${originalPath}`);
	}

	const originalSha256 = existed ? sha256(originalPath) : null;
	let backupPath = null;

	if (existed && mayModify) {
		backupPath = join(backupDir, relativePath);
		mkdirSync(dirname(backupPath), { recursive: true });
		copyFileSync(originalPath, backupPath);

		const currentSha256 = sha256(originalPath);
		const backupSha256 = sha256(backupPath);
		if (currentSha256 !== originalSha256 || backupSha256 !== originalSha256) {
			fail(`Backup verification failed: ${originalPath}`);
		}
	}

	const stats = existed ? statSync(originalPath) : null;
	manifestTargets.push({
		absolute_original_path: originalPath,
		existed_before_installation: existed,
		approved_installation_may_modify: mayModify,
		backup_path: backupPath,
		sha256: originalSha256,
		backup_timestamp: timestamp,
		...(stats
			? {
					type: "file",
					size: stats.size,
					modification_time: stats.mtime.toISOString(),
				}
			: {}),
	});
}

const manifestPath = join(backupDir, "manifest.json");
writeFileSync(
	manifestPath,
	`${JSON.stringify({ backup_timestamp: timestamp, targets: manifestTargets }, null, 2)}\n`,
	"utf8",
);

let writtenManifest;
try {
	writtenManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	fail(`Manifest verification failed: ${message}`);
}
if (writtenManifest.targets.length !== targets.length) {
	fail("Manifest verification failed: unexpected target count");
}

process.stdout.write(`Backup prepared: ${backupDir}\n`);
process.stdout.write(`Manifest written: ${manifestPath}\n`);
