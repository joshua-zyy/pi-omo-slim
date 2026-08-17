# pi-omo-slim deterministic installation procedure

This document is the operational contract for an Agent after this repository is available locally. Repository cloning is a separate approval checkpoint and never authorizes changes to the user's Pi configuration.

## Safety rules

1. Resolve the repository root, Pi executable, and actual absolute Pi configuration root. If `PI_CODING_AGENT_DIR` is set, use it; otherwise confirm the platform's global Pi configuration directory with the user.
2. Inspect before changing state. Do not overwrite or update an existing clone or Pi configuration without the approval required below.
3. Use `scripts/install.mjs` as the only installation entry point. Do not create ad hoc Shell, JavaScript, Python, or other installation, backup, verification, or rollback programs.
4. The installer never installs or removes packages. All eight dependencies must already be present:

   ```text
   npm:@tintinweb/pi-subagents
   npm:@ff-labs/pi-fff
   npm:pi-web-access
   npm:pi-lens
   npm:@firstpick/pi-extension-safety-guard
   npm:@narumitw/pi-chrome-devtools
   npm:@narumitw/pi-goal
   npm:@juicesharp/rpiv-todo
   ```

5. If a dependency is missing, stop. Show only the missing fixed `pi install npm:<package>` commands, obtain separate approval, run them, and then generate a new plan.
6. Never modify model credentials, providers, unrelated Agents, installed-package source code, or project templates.
7. Never hand-edit `plan.json`. A new choice or environmental change requires a new plan.
8. An approved plan SHA authorizes only the listed writes and the listed automatic rollback deletions. Any unrelated cleanup or later manual rollback requires separate approval.

## 1. Inspect and collect choices

Read `README.md`, `scripts/install.mjs`, all six `agents/*.md` templates, both files under `extensions/orchestrator-mode/`, and the two files under `config/`.

Inspect the following eleven destinations and list unrelated custom Agents:

```text
agents/Explore.md
agents/librarian.md
agents/oracle.md
agents/designer.md
agents/fixer.md
agents/verifier.md
extensions/orchestrator-mode/index.ts
extensions/orchestrator-mode/orchestrator-policy.md
orchestrator-mode.json
subagents.json
settings.json
```

For each conflicting same-name Agent, ask separately whether to `keep` it byte-for-byte or `replace` it with this project's template. An absent or byte-identical Agent uses `install`.

Ask the user to choose:

- `routing`: `strict` merges `disableDefaultAgents: true` and `fallbackSubagent: "none"`; `compatibility` leaves `subagents.json` absent or byte-for-byte unchanged.
- `orchestratorDefaultEnabled`: `true` or `false` for sessions without an explicit branch override.
- for each role, `model`: `inherit` or an exact ID from `pi --list-models`.
- for each role, `thinking`: `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi may clamp a level to a model's capability.

Write those choices to a short `request.json` at an exact user-approved path. The schema is closed; do not add comments or extra fields:

```json
{
  "routing": "strict",
  "orchestratorDefaultEnabled": false,
  "agents": {
    "Explore": { "action": "install", "model": "inherit", "thinking": "inherit" },
    "librarian": { "action": "install", "model": "inherit", "thinking": "inherit" },
    "oracle": { "action": "install", "model": "inherit", "thinking": "inherit" },
    "designer": { "action": "install", "model": "inherit", "thinking": "inherit" },
    "fixer": { "action": "install", "model": "inherit", "thinking": "inherit" },
    "verifier": { "action": "install", "model": "inherit", "thinking": "inherit" }
  }
}
```

## 2. Generate the immutable plan

Show the exact command and obtain approval to create the audit plan, then run:

```text
node scripts/install.mjs plan --request <absolute-request.json> --config-root <absolute-config-root>
```

`plan` validates the closed request, repository templates, Pi dependencies/models, same-name conflict decisions, JSON objects, paths, and symbolic-link safety. Its only configuration-root write is:

```text
<config-root>/install-records/<plan-id>/plan.json
```

If planning fails, stop. Do not repair configuration or improvise another command.

## 3. Present the approval-bound proposal

Read the generated `plan.json` and present:

- repository/configuration roots and Pi version;
- every role's action, model, and thinking choice;
- strict or compatibility routing behavior;
- Orchestrator default;
- every target that may be created, replaced, merged, backed up, or kept;
- unrelated custom Agents that remain untouched;
- exact backup and audit directories;
- every `rollback.delete_files` and `rollback.remove_empty_directories` path;
- the exact SHA-256 printed by `plan`.

Explain that approval of this SHA also approves automatic rollback of transaction-created files/directories listed in the plan. It never approves deletion of pre-existing files. Obtain explicit approval of the exact SHA before applying.

If the user changes any choice or an approved replacement Agent changes, generate a new request/plan and obtain approval for its new SHA.

## 4. Apply exactly once

After SHA approval, show and run only:

```text
node scripts/install.mjs apply --plan <absolute-plan.json> --sha256 <approved-64-hex-sha256>
```

`apply` rejects a changed plan, changed repository template, changed approved replacement, prior attempt, or occupied output path before configuration mutation. It then:

1. creates `apply-started.json` so an interrupted plan cannot be silently retried;
2. backs up the latest execution-time target state and writes an eleven-target `manifest.json`;
3. installs only approved Agent/extension files and merges only approved JSON fields;
4. leaves `settings.json` live bytes untouched while backing up its latest state;
5. runs fixed verification;
6. writes `result.json`;
7. on failure, compensates in reverse order and writes `rollback.json` as `rolled_back` or `rollback_incomplete`.

Do not rerun an attempted plan. Inspect its retained records and generate a new plan if another attempt is appropriate.

## 5. Report the fixed records

Report, without adding ad hoc verification commands:

- `result.json` status and path;
- backup directory and `manifest.json` path;
- installed/replaced/kept roles and their model/thinking behavior;
- routing mode and Orchestrator default;
- unchanged unrelated Agents and `settings.json` behavior;
- `rollback.json` and exact unresolved paths if rollback was attempted;
- any skipped post-install Pi extension smoke check.

On success, tell the user to restart Pi or start a new session, then use:

```text
/orchestrator status
/orchestrator on
/orchestrator off
```

Goal sessions are user-initiated only. The user must explicitly run a native `pi-goal` command, for example:

```text
/goal <objective>
/goal --tokens 100k <objective>
```

The Orchestrator never auto-starts a Goal. `--tokens` sets `pi-goal`'s native token budget for the main session branch; this project adds no budget default, no usage aggregation, and no alternative budget command.

A later manual rollback is outside this transaction. Do not restore or delete anything unless the user explicitly approves the exact retained backup/manifest targets.
