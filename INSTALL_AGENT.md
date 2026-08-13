# pi-omo-slim installation procedure for Pi Agents

This document is the operational contract for an Agent after this repository is available in a local directory. Read it completely before taking any installation action. Repository cloning is outside this procedure and its approval does not authorize changes to Pi configuration.

## Objective

Install this repository's five Agent definitions and Orchestrator Mode into the user's global Pi configuration without silently overwriting unrelated settings, while keeping every change recoverable.

## Non-negotiable rules

1. Resolve paths from the current repository and the user's actual Pi configuration. Never reuse paths from examples or another machine.
2. If `PI_CODING_AGENT_DIR` is set, use it as the configuration root. Otherwise, use `.pi/agent` under the current platform's user home directory.
3. Inspect before modifying.
4. Before every state-changing shell command, show the user the exact command, affected paths, backup location, and expected effect, then obtain explicit approval.
5. Never silently overwrite an Agent, extension, or JSON configuration with the same name.
6. Never replace an existing JSON configuration wholesale. Parse it and update only the properties supplied by this repository.
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
3. Run `pi list` and determine which of these dependencies are already installed:

   ```text
   npm:@tintinweb/pi-subagents
   npm:@ff-labs/pi-fff
   npm:pi-web-access
   npm:pi-lens
   npm:@firstpick/pi-extension-safety-guard
   ```

4. Run `pi --list-models` to discover the models currently available in Pi, then prepare the provider/model IDs for the user to choose from. This phase is an availability inventory only. Do not require the repository's Agent templates to contain or resolve any default model, and do not select substitute models during this phase.

5. Inventory the following destinations. For each existing file, record its existence, type, size, modification time, and SHA-256:
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
6. Inspect other enabled custom Agents. Explain that this installation does not automatically remove or disable them and that they may remain callable alongside this project's five roles.
7. If `orchestrator-mode.json` or `subagents.json` already exists, parse each existing file as JSON. Stop if either is invalid or if `orchestrator-mode.json` is not a top-level object.

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

Regardless of the selected approach, expand the result into an explicit five-row configuration for Explorer, Librarian, Oracle, Designer, and Fixer so the user can review it. Then ask whether Orchestrator Mode should default to enabled or disabled when a session branch has no explicit mode state. Explain that this choice writes only `defaultEnabled` in `<config-root>/orchestrator-mode.json`, affects only this extension, and is overridden by the latest `/orchestrator on` or `/orchestrator off` state recorded in the current session branch.

After they confirm those choices, present a concise final installation proposal containing:

- the exact repository root and configuration root;
- the Pi version and available-model inventory;
- the final model and thinking-level choice for each of the five Subagents, with inherited values explicitly marked as "inherit from parent Agent";
- the selected Orchestrator Mode global default;
- dependencies already installed and dependencies that still need installation;
- every destination that will be created or replaced;
- same-name conflicts and how each will be backed up;
- the exact backup directory;
- the exact package-installation and file-modification commands;
- verification commands;
- an explicit statement that no files will be deleted.

Do not continue without the user's explicit approval of the final installation proposal. Confirming role configurations is not approval to install.

## Phase 3: backup

After approval, create one timestamped directory under:

```text
<config-root>/backups/pi-omo-slim-YYYYMMDD-HHMMSS/
```

Back up every existing destination from the Phase 1 inventory, including `settings.json`, while preserving an unambiguous relative layout. Create a `manifest.json` that records for every target:

- its absolute original path;
- whether it existed before installation;
- its backup path, or `null` if it was originally absent;
- the SHA-256 of each existing file;
- the backup timestamp.

Before continuing, compare SHA-256 values to verify every copied backup. Do not include credentials or unrelated files in the backup.

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
2. Copy the five repository Agent files to their corresponding destination names, then apply the Phase 2 choices only to the destination copies:
   - when the model is set to inherit, do not add `model`; otherwise, add the selected exact model ID;
   - when the thinking level is set to inherit, do not add `thinking`; otherwise, add the selected level;
   - do not modify the repository source files or change any other frontmatter or Prompt content.
3. Copy both Orchestrator Mode files to the destination extension directory.
4. Install the Orchestrator Mode global configuration:
   - if `<config-root>/orchestrator-mode.json` is absent, create it from `config/orchestrator-mode.json.example` and set `defaultEnabled` to the boolean approved in Phase 2;
   - if it exists, parse it as JSON and stop if it is invalid or its top-level value is not an object;
   - set only `defaultEnabled` to the approved boolean and preserve every unrelated property;
   - retain the existing indentation style when practical, and always write valid JSON.
5. Install strict subagent routing:
   - if `<config-root>/subagents.json` is absent, create it from `config/subagents.json`;
   - if it exists, parse it and set only:

```json
{
  "disableDefaultAgents": true,
  "fallbackSubagent": "none"
}
```

Preserve every unrelated property. Retain the existing indentation style when practical, and always write valid JSON.

Do not modify existing custom Agents whose names do not conflict with the five repository files. Do not patch `@tintinweb/pi-subagents` or any other installed package.

## Phase 6: review and verification

Review every changed file before running tests. Fix only issues caused by this installation.

Verify that:

1. `orchestrator-mode.json` parses as a JSON object and its `defaultEnabled` boolean exactly matches the value approved by the user.
2. `subagents.json` parses and contains the two strict values.
3. Each of the five Agent files has exactly two frontmatter delimiters and contains:
   - `prompt_mode: replace`;
   - `skills: false`;
   - `inherit_context: false`;
   - no `allowed_subagents` field.
   Also verify `model` and `thinking` for every role: inherited settings must omit their fields, while pinned settings must exactly match the configuration approved by the user.
4. Explorer, Librarian, and Oracle have no write or shell tools.
5. Designer and Fixer load `pi-extension-safety-guard`.
6. Every referenced `ext:` tool belongs to an installed extension.
7. The current Pi executable can load the mode extension independently, for example by combining `--no-extensions`, an explicit `--extension` path, and `--list-models`.
8. Installed-package source code and unrelated global settings were not modified, except for package references written by successful `pi install` commands.

Tell the user to restart Pi or start a new Pi session. In that new session, ask them to verify:

```text
/orchestrator status
/orchestrator on
/orchestrator off
```

In a session branch with no explicit Orchestrator Mode state, the initial state should match the approved `defaultEnabled` value. `/orchestrator on` should display `orchestrator: ON`, while `/orchestrator off` should remove that status and persist the override in the current session branch. Available Agent types should include `Explore`, `librarian`, `oracle`, `designer`, and `fixer`. Calling a definitely unknown type must fail rather than fall back.

Do not run Designer or Fixer write smoke tests against a real project. Creating a temporary fixture and deleting it afterward both require separate approval.

## Completion report

Report:

- the configuration root;
- files created or replaced;
- the effective model and thinking level for each of the five Subagents;
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
