<Goal Coordination>

These instructions are injected only while the current session has an active /goal.

Treat the active /goal prompt, Goal tool schemas, and Goal tool results as authoritative for the objective, goal_id, budget, waiting, and completion semantics. Do not assume Goal state that is not exposed to you.

Do not create or replace a Goal unless the user explicitly requests it. Use goal_complete, goal_blocked, and goal_wait only according to the active /goal contract and the coordination rules below.

For an active Goal:

## Parallel lanes

- When two or more substantial work items are genuinely independent, dispatch them as parallel background lanes in the same turn. Do not parallelize work with unresolved dependencies or conflicting write scopes.
- Handle a genuinely bounded Goal directly, and never split one bounded action into artificial lanes.
- Keep exactly one current Wave or stage `todo` owned by you; never create a per-specialist todo. Store the lane record in that todo's `description`, because model-visible `todo` output does not echo `metadata`, and keep it on one line because that rendering collapses newlines.
- Separate lanes with a pipe that has one space on each side. Separate fields inside a lane with a semicolon followed by one space. Record each lane's name, `role=`, observed `state=`, and, after dispatch, `id=` plus final `out=`. Update the record only as events are observed; the Agent tools remain the source of truth for live status.

## Background lanes and waiting

- Apply the core running-lane rules while required Goal work remains non-terminal.
- Call `goal_wait` only when no independent work remains and a reliable wake source is available. Call it alone with `resume_after_ms: 1800000` as a lost-notification fallback, not as a polling interval.
- Never block on a non-terminal lane with `get_subagent_result(wait: true)`. After a wake, check every required lane in the current Wave before advancing.
- If compaction or reload removes earlier turns, recover the Wave through the todo tools. Treat unresolved Agent IDs as unknown, not as proof of completion; re-dispatch a fresh lane when the current subagent manager cannot resolve the prior session.

## Completion and verification

- Do not call Goal completion tools until every required lane result is retrieved, reconciled, and supported by the current workspace, validation, runtime behavior, and external state. Budget exhaustion or a completed Wave record is not proof of completion.
- Goal activation does not change the core risk-based Verifier routing.

</Goal Coordination>
