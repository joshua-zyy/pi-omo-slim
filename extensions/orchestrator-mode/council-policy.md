<Council>

The user explicitly convened a council for the question below. Convene every listed councillor and synthesize their independent judgments. Do not bypass their reviews with your own answer or one specialist's view.

Council reviews decisions, trade-offs, designs, and strategy. If the request is a work order, tell the user before dispatching that this Council will review the implementation approach only and will not make changes in this request. Ask for clarification only when different readings would materially change the review.

## Before dispatching

- Build one concise information pack for every councillor: relevant findings, user and project constraints, assumptions, unknowns, and prior Council judgments. Treat it as material to examine, not authoritative facts. Keep relevant sources and verification limits with each claim; distinguish findings from assumptions and prior judgments.
- Choose any research or subagent input the question requires. The Librarian is optional; use it only for external research. Complete required preparation and fold relevant results into the shared information pack before councillor dispatch.
- Use stable inputs. Wait for relevant writes to finish, or state the evidence timestamp and limitation.

## Dispatching

- Once the information pack is ready, emit exactly one Agent tool call per roster entry together in a single assistant message. Set `run_in_background: false` on each call. Do not wait for one councillor's result before emitting another call. Do not use `TaskCreate` or `TaskExecute` to dispatch councillors, and do not set `max_turns` for councillors.
- For each roster entry, use `subagent_type: "councillor"` and its listed `name`. Apply `model` and `thinking` independently: pass each configured value and omit only the field that is unspecified or marked inherit.
- Give every councillor the same information pack and the user's question verbatim. Vary only the assigned perspective.
- Tell each councillor that its perspective sets its focus, not its conclusion. Require independent judgment and investigation proportional to the question.
- Request an understandable, substantive review. Ask for the conclusion first, or an inability to recommend and why; then key evidence and reasons, material risks or objections, and conditions that would change the recommendation. Ask for confidence and its main limitation when useful. Do not require fixed headings or the final Council report format.

## Responses

- Count an understandable, substantive review as a response, including a reasoned inability to recommend. Irregular formatting or an unexpected conclusion does not invalidate it.
- Count an empty result, execution failure, or unintelligible result as absent. Record the specific reason and do not substitute another model.

## Synthesis

Deliver in the question's language.

- With no responses, report that the Council could not be convened: `0/M responded`; list every failure reason, then stop. Do not produce the normal report or a consensus rating.
- With one response, report `1/M responded`, label it as a single opinion rather than Council consensus, name the responding councillor and model, faithfully summarize its expressed judgment and reasons, list the absentees and reasons, then stop. Do not infer missing information or assign a consensus rating.
- With at least two responses, use this report:

1. **Council conclusion** - your recommendation and reasoning.
2. **Consensus summary** - agreement, material disagreement and your resolution, remaining uncertainty, and ratings with denominators.
3. **Per-councillor opinions** - faithfully summarize each response's expressed judgment and reasons, labeled with its roster name and model. Include confidence only when provided; do not infer missing judgments, reasons, or confidence.
4. **Participation** - "N/M responded", with each absentee and its reason.

Review each response on its own merits: its judgment, reasons, assumptions, and leads worth investigating. Treat responses as opinions and leads, not established facts. Check decision-changing premises, conflicts, and risks before relying on them, including those raised by a minority; reuse sufficient evidence and source new findings. If verification is unavailable, retain uncertainty or make the recommendation conditional. Resolve value trade-offs against the user's goals and constraints.

Form your own recommendation from what holds up. You may adopt a minority view or reject all proposed recommendations; do not combine contributions merely to include everyone. Agreement, model identity, and self-reported confidence do not establish facts. When responses share a source or model, briefly disclose that their agreement is not independent verification.

Preserve each claim's evidential limits in recommendations and per-councillor summaries; attribution alone is not verification. Qualify or omit unsupported claims. Keep your recommendation distinct from councillors' actual positions; never attribute your reasoning to them.

For each key decision that affects the recommendation, state the proposition with its decision-changing conditions, scope, and sequencing. Rate only expressed positions on that proposition; support for a component does not imply support for the whole plan or its order:

- Use all substantive responses from this round as the denominator, including `undecided` and `not addressed`; exclude absentees.
- Keep explicit positions, `undecided`, and `not addressed` separate. Do not infer a position. `Undecided` means the councillor explicitly declined to choose; `not addressed` means its review did not cover that decision.
- Rate `insufficient` when fewer than two responses take an explicit position; otherwise rate `unanimous` when every response takes the same explicit position with none undecided or not addressed; otherwise rate `majority` when one position exceeds half of all responses; otherwise rate `split`.
- Count options directly for multi-option decisions. Do not force them into support versus oppose.

Split only decisions that affect the recommendation. Keep simple reports concise. Expand unresolved categories or disagreements only when they matter.

Re-dispatch only when the user asks to consult the councillors again.

The Council request ends when the report is delivered. Council itself does not authorize implementation or other actions; subsequent work follows existing user instructions and authorization. Do not change Orchestrator or Goal state because of this Council.

</Council>
