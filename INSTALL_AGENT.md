# pi-omo-slim installation procedure for Pi Agents

This document is the operational contract for an Agent after this repository is available in a local directory. Read it completely before taking any installation action. Repository cloning is outside this procedure and its approval does not authorize changes to Pi configuration.

## Objective

Install this repository's Agent definitions and Orchestrator Mode into the user's global Pi configuration, while allowing the user to preserve individual same-name Agent definitions, without silently overwriting unrelated settings and while keeping every change recoverable.

## Non-negotiable rules

1. Resolve paths from the current repository and the user's actual Pi configuration. Never reuse paths from examples or another machine.
2. If `PI_CODING_AGENT_DIR` is set, use it as the configuration root. Otherwise, use `.pi/agent` under the current platform's user home directory.
3. Inspect before modifying.
4. Before every state-changing shell command, show the user the exact command, affected paths, backup location, and expected effect, then obtain explicit approval.
5. Never silently overwrite an Agent, extension, or JSON configuration with the same name. Resolve each same-name Agent conflict separately with the user.
6. Never replace an existing JSON configuration wholesale. Parse it and update only properties the user explicitly approved for this installation.
7. Do not modify model credentials, providers, model allowlists, unrelated Agents, Pi source code, installed-package source code, or project-local Pi settings.
8. Do not delete files during installation. Any later cleanup or rollback deletion requires separate explicit approval for exact, verified targets.
9. Stop on any parsing, copying, dependency-installation, or verification failure. Report the current state and recovery path; do not improvise destructive repairs.

## Repository inputs

The repository must contain:

```text
agents/Explore.md
agents/librarian.md
agents/oracle.md
agents/designer.md
agents/fixer.md
extensions/orchestrator-mode/index.ts
extensions/orchestrator-mode/orchestrator-policy.md
config/orchestrator-mode.json.example
config/subagents.json
scripts/prepare-install-backup.mjs
```

If any input is missing or empty, stop before modifying the user's configuration.

## Phase 1: read-only preflight

Complete the following without changing any state:

1. Resolve and display:
   - the repository root;
   - the Pi executable and `pi --version`;
   - the global Pi configuration root;
   - every destination path.
2. Read `README.md`, every repository input listed above, and all applicable user and project instructions in full.
3. Run `pi list` and determine which of these dependencies are already installed. Treat an installed `@tintinweb/pi-subagents` package as a dependency state only; it does not prove that this project or its five Agent templates were previously installed:

   ```text
   npm:@tintinweb/pi-subagents
   npm:@ff-labs/pi-fff
   npm:pi-web-access
   npm:pi-lens
   npm:@firstpick/pi-extension-safety-guard
   ```

4. Run `pi --list-models` to discover the models currently available in Pi, then prepare the provider/model IDs for the user to choose from. This phase is an availability inventory only. Do not require the repository's Agent templates to contain or resolve any default model, and do not select substitute models during this phase.

5. Inventory the following destinations. For every target, record whether it exists. For each existing file, also record its type, size, and modification time. Compute SHA-256 only when needed to compare a same-name Agent with its repository template; do not use a preflight hash as an execution-time lock:
   - `<config-root>/settings.json`;
   - `<config-root>/agents/Explore.md`;
   - `<config-root>/agents/librarian.md`;
   - `<config-root>/agents/oracle.md`;
   - `<config-root>/agents/designer.md`;
   - `<config-root>/agents/fixer.md`;
   - `<config-root>/extensions/orchestrator-mode/index.ts`;
   - `<config-root>/extensions/orchestrator-mode/orchestrator-policy.md`;
   - `<config-root>/orchestrator-mode.json`;
   - `<config-root>/subagents.json`.
6. For each existing same-name Agent destination, compare its SHA-256 with the corresponding repository template. Classify an exact match as already matching this project. Classify a different file as a same-name custom or unknown-origin conflict; do not infer ownership from its name.
7. Inspect other enabled custom Agents. Explain that this installation does not automatically remove or disable them and that they may remain callable alongside this project's five roles.
8. If `orchestrator-mode.json` or `subagents.json` already exists, parse each existing file as JSON. Stop if either is invalid or if its top-level value is not an object.
9. If `subagents.json` exists, record the current presence and value of `disableDefaultAgents` and `fallbackSubagent`. Prepare this field-level comparison without changing the file:

   ```text
   disableDefaultAgents: <current value or absent> -> true
   fallbackSubagent: <current value or absent> -> "none"
   other properties: preserved
   ```

10. Present a compatibility summary that distinguishes the installed package state, same-name Agent conflicts, unrelated custom Agents, and existing routing configuration. Explicitly warn that strict routing disables package-provided default Agents and makes an unknown Agent type fail instead of falling back.

## Phase 2: configuration and approval checkpoint

First, show the user the models discovered during Phase 1 and ask them to choose one configuration approach:

1. **Inherit everything** — omit both `model` and `thinking` for all five Subagents so that they inherit from the parent Agent at runtime;
2. **Shared configuration** — use one model and thinking level for all five Subagents;
3. **Per-role configuration** — choose a model and thinking level separately for each Subagent.

The model and thinking level may be set to inherit independently. For example, Oracle may pin a model while omitting `thinking` so that its thinking level comes from the parent Agent. Do not silently infer a choice from the current parent model, repository content, or another role's configuration.

Offer provider-neutral capability guidance rather than recommending or requiring a particular commercial model:

| Subagent | Suggested model characteristics | Suggested thinking level |
| --- | --- | --- |
| Explorer | Fast, inexpensive, and reliable at tool use | `low` |
| Librarian | Reliable with Web tools and longer contexts | `low` |
| Oracle | A strong reasoning model available in the user's environment | `high` |
| Designer | Balanced coding and visual/UI understanding | `medium` |
| Fixer | Strong coding and tool-use ability | `high` |

A thinking level must be either inherited or supported by the current Pi version. Pi may clamp a level that a selected model cannot support. Explain this behavior to the user and do not claim that every model will execute the chosen level exactly.

Regardless of the selected approach, expand the result into an explicit five-row configuration for Explorer, Librarian, Oracle, Designer, and Fixer so the user can review it.

For every same-name Agent conflict identified in Phase 1, ask the user separately whether to:

- **replace it** — back up the existing file, then install this project's template and apply the approved model and thinking settings; or
- **keep it** — leave the existing file byte-for-byte unchanged and mark that role as not using this project's template.

Do not use one approval for all same-name conflicts unless the user explicitly chooses the same action for every listed path. An exact template match is not a conflict and may remain in place or be refreshed without being described as a user customization.

Ask the user to choose one routing mode:

1. **Strict mode** — set `disableDefaultAgents` to `true` and `fallbackSubagent` to `"none"`, preserving every unrelated property. Explain the exact field-level changes before approval.
2. **Compatibility mode** — preserve the existing values or absence of both routing properties. If `subagents.json` does not exist, do not create it. Explain that package-provided default Agents may remain available and unknown Agent types may fall back, so routing does not fully match this project's strict design.

Then ask whether Orchestrator Mode should default to enabled or disabled when a session branch has no explicit mode state. Explain that this choice writes only `defaultEnabled` in `<config-root>/orchestrator-mode.json`, affects only this extension, and is overridden by the latest `/orchestrator on` or `/orchestrator off` state recorded in the current session branch.

After they confirm those choices, present a concise final installation proposal containing:

- the exact repository root and configuration root;
- the Pi version and available-model inventory;
- the final model and thinking-level choice for each of the five Subagents, with inherited values explicitly marked as "inherit from parent Agent";
- the separate replace-or-keep decision for every same-name Agent conflict;
- the selected routing mode, including the exact two-field diff in strict mode or the compatibility warning in compatibility mode;
- the selected Orchestrator Mode global default;
- dependencies already installed and dependencies that still need installation;
- every destination that will be created or replaced;
- same-name conflicts and how each will be backed up;
- the exact backup directory;
- the exact `scripts/prepare-install-backup.mjs` command, including one `--keep-agent <filename>` argument for every same-name Agent the user chose to keep;
- the exact package-installation and file-modification commands;
- verification commands;
- an explicit statement that no files will be deleted.

Do not continue without the user's explicit approval of the final installation proposal. Confirming role configurations is not approval to install.

## Phase 3: backup

After approval, choose one new timestamped directory under:

```text
<config-root>/backups/pi-omo-slim-YYYYMMDD-HHMMSS/
```

Immediately before backup, recheck every same-name Agent conflict that the user approved replacing. If one changed after the user reviewed it, stop and obtain a new replace-or-keep decision for that file. For JSON configuration and `settings.json`, do not compare the current file with its preflight SHA-256: Pi may legitimately update those files while the installation is being discussed. Back up their latest state at execution time, and later merge only the approved JSON properties.

Run the repository's fixed backup utility with absolute paths:

```text
node scripts/prepare-install-backup.mjs \
  --config-root <config-root> \
  --backup-dir <config-root>/backups/pi-omo-slim-YYYYMMDD-HHMMSS \
  --routing <strict|compatibility> \
  [--keep-agent <filename>]...
```

Use the exact repository script; do not replace it with an ad hoc Shell, Python, or JavaScript implementation. Pass `--keep-agent` separately for every same-name Agent the user chose to keep, using one of `Explore.md`, `librarian.md`, `oracle.md`, `designer.md`, or `fixer.md`.

The utility backs up every currently existing inventoried target that the approved installation may modify, including the latest `settings.json`, while preserving its relative layout. It creates `manifest.json` entries for all ten targets, including absent and unchanged targets, and records:

- its absolute original path;
- whether it existed immediately before installation;
- whether the approved installation may modify it;
- its backup path, or `null` if it was absent or will remain unchanged;
- the SHA-256 of each existing file at backup time;
- the backup timestamp.

The utility verifies that each copied backup has the same SHA-256 as its source at backup time. This SHA-256 is backup-integrity and rollback evidence only; it is not a requirement that the live file still match a preflight snapshot or remain unchanged after dependency installation. For an absent target, the manifest records its pre-installation absence so a later approved rollback can distinguish a newly created file from a pre-existing one. Do not include credentials or unrelated files in the backup. Stop if the utility fails.

## Phase 4: install missing dependencies

Run only the commands corresponding to packages missing from `pi list`:

```text
pi install npm:@tintinweb/pi-subagents
pi install npm:@ff-labs/pi-fff
pi install npm:pi-web-access
pi install npm:pi-lens
pi install npm:@firstpick/pi-extension-safety-guard
```

Do not use `--local`, because these roles and the mode are installed globally. Stop and report any failed command.

## Phase 5: install repository configuration

1. Create the destination `agents` and `extensions/orchestrator-mode` directories if they do not exist.
2. Process the five Agent destinations independently:
   - copy a repository Agent file when its destination is absent, already matches the repository template, or the user explicitly approved replacing that same-name conflict;
   - leave a same-name conflict byte-for-byte unchanged when the user chose to keep it;
   - apply the Phase 2 model and thinking choices only to Agent files installed from this project's templates;
   - when the model is set to inherit, do not add `model`; otherwise, add the selected exact model ID;
   - when the thinking level is set to inherit, do not add `thinking`; otherwise, add the selected level;
   - do not modify the repository source files or change any other frontmatter or Prompt content.
3. Copy both Orchestrator Mode files to the destination extension directory.
4. Install the Orchestrator Mode global configuration:
   - if `<config-root>/orchestrator-mode.json` is absent, create it from `config/orchestrator-mode.json.example` and set `defaultEnabled` to the boolean approved in Phase 2;
   - if it exists, parse it as JSON and stop if it is invalid or its top-level value is not an object;
   - set only `defaultEnabled` to the approved boolean and preserve every unrelated property;
   - retain the existing indentation style when practical, and always write valid JSON.
5. Apply the approved routing mode:
   - in **strict mode**, create `<config-root>/subagents.json` from `config/subagents.json` when absent; otherwise set only:

     ```json
     {
       "disableDefaultAgents": true,
       "fallbackSubagent": "none"
     }
     ```

     Preserve every unrelated property, retain the existing indentation style when practical, and always write valid JSON;
   - in **compatibility mode**, do not create or modify `<config-root>/subagents.json`.

Do not modify existing custom Agents whose names do not conflict with the five repository files. Do not patch `@tintinweb/pi-subagents` or any other installed package.

## Phase 6: review and verification

Review every changed file before running tests. Fix only issues caused by this installation.

Verify that:

1. `manifest.json` parses, contains all ten inventoried targets, and every copied backup's SHA-256 matches the value recorded for that target. Do not compare the live post-installation `settings.json` with its installation-time backup because successful `pi install` commands are expected to modify the live file.
2. `orchestrator-mode.json` parses as a JSON object and its `defaultEnabled` boolean exactly matches the value approved by the user.
3. Routing matches the approved mode:
   - in strict mode, `subagents.json` parses and contains the two strict values while preserving unrelated properties;
   - in compatibility mode, `subagents.json` remains byte-for-byte unchanged if it existed and remains absent if it did not.
4. For each Agent installed from this project's template, verify that it has exactly two frontmatter delimiters and contains:
   - `prompt_mode: replace`;
   - `skills: false`;
   - `inherit_context: false`;
   - no `allowed_subagents` field.
   Also verify `model` and `thinking` for every installed project role: inherited settings must omit their fields, while pinned settings must exactly match the configuration approved by the user. For every same-name Agent the user chose to keep, verify that its SHA-256 is unchanged and do not apply project-template assertions to it.
5. Explorer, Librarian, and Oracle use this project's no-write/no-shell tool restrictions only when their project templates were installed; report kept same-name roles separately.
6. Designer and Fixer load `pi-extension-safety-guard` only when their project templates were installed; report kept same-name roles separately.
7. Every `ext:` tool referenced by an Agent installed from this project's template belongs to an installed extension; do not apply this assertion to a same-name Agent the user chose to keep.
8. The current Pi executable can load the mode extension independently, for example by combining `--no-extensions`, an explicit `--extension` path, and `--list-models`.
9. Installed-package source code and unrelated global settings were not modified, except for package references written by successful `pi install` commands.

Tell the user to restart Pi or start a new Pi session. In that new session, ask them to verify:

```text
/orchestrator status
/orchestrator on
/orchestrator off
```

In a session branch with no explicit Orchestrator Mode state, the initial state should match the approved `defaultEnabled` value. `/orchestrator on` should display `orchestrator: ON`, while `/orchestrator off` should remove that status and persist the override in the current session branch. Available Agent types should include `Explore`, `librarian`, `oracle`, `designer`, and `fixer`, while any kept same-name role uses the user's existing definition rather than this project's template. In strict mode, calling a definitely unknown type must fail rather than fall back. In compatibility mode, report the observed fallback behavior without treating fallback as an installation failure.

Do not run Designer or Fixer write smoke tests against a real project. Creating a temporary fixture and deleting it afterward both require separate approval.

## Completion report

Report:

- the configuration root;
- files created or replaced;
- the effective model and thinking level for each installed project Subagent, plus every same-name Agent kept unchanged and therefore not using this project's template;
- the selected routing mode and, in compatibility mode, the resulting default-Agent and fallback warning;
- the configured Orchestrator Mode global default;
- dependencies installed and dependencies already present;
- the backup directory and manifest path;
- verification results;
- other custom Agents that remain enabled, plus any compatibility warnings;
- skipped checks and the reasons they were skipped;
- the exact rollback source.

## Rollback guidance

Do not perform a rollback unless the user explicitly requests and approves it.

Treat the manifest as the sole source of truth. Restore backed-up files to their exact original paths. Files recorded as originally absent may need to be deleted to return fully to the pre-installation state, but deletion is destructive and requires separate confirmation for exact targets. Restoring the backed-up `settings.json` removes package references added by this installation. Cached package files may remain; they do not prevent configuration-level rollback.
