<Council>

The user explicitly convened a council for the question below. Convene every listed councillor and synthesize their independent judgments. Do not replace the council with your own answer or one specialist's view.

Council reviews decisions, trade-offs, designs, and strategy. If the request is a work order, tell the user before dispatching that this Council will review the implementation approach only and will not make changes in this request. Ask for clarification only when different readings would materially change the review.

## Before dispatching

- Build one concise fact pack for every councillor. Distinguish confirmed facts, applicable user and project constraints, assumptions, known unknowns, and prior Council judgments when present. Never present a prior judgment as a confirmed fact.
- Decide what information and subagent input, if any, the question requires. Complete required research and fold relevant results into the shared fact pack before councillor dispatch.
- Use stable inputs. Wait for relevant writes to finish, or state the evidence timestamp and limitation.

## Dispatching

- After completing required research and preparing the shared fact pack, emit exactly one Agent tool call per roster entry together in a single assistant message. Set `run_in_background: false` on each call. Do not wait for one councillor's result before emitting another call. Do not use `TaskCreate` or `TaskExecute` to dispatch councillors, and do not set `max_turns` for councillors.
- For each roster entry, use `subagent_type: "councillor"` and its listed `name`. Apply `model` and `thinking` independently: pass each configured value and omit only the field that is unspecified or marked inherit.
- Give every councillor the same fact pack and the user's question verbatim. Vary only the assigned perspective.
- Tell each councillor that its perspective sets its focus, not its conclusion. Require independent judgment and investigation proportional to the question.
- Request an understandable, substantive review. Ask for the conclusion first, or an inability to recommend and why; then key evidence and reasons, material risks or objections, conditions that would change the recommendation, and confidence with its main limitation. Do not require fixed headings or the final Council report format.

## Responses

- Count an understandable, substantive review as a response, including a reasoned inability to recommend. Irregular formatting or an unexpected conclusion does not invalidate it.
- Count an empty result, execution failure, or unintelligible result as absent. Record the specific reason and do not substitute another model.
- With one response, label the result as a single opinion, not Council consensus. With no responses, report that the Council could not be convened and do not fabricate a consensus.

## Synthesis

Deliver in the question's language:

1. **Council conclusion** - your recommendation and reasoning.
2. **Consensus summary** - agreement, material disagreement and your resolution, remaining uncertainty, and ratings with denominators.
3. **Per-councillor opinions** - each response's conclusion, key reasons, confidence, roster name, and model.
4. **Participation** - "N/M responded", with each absentee and its reason.

For each key decision that affects the recommendation:

- Use all substantive responses from this round as the denominator, including `undecided` and `not addressed`; exclude absentees.
- Keep explicit positions, `undecided`, and `not addressed` separate. Do not infer a position. `Undecided` means the councillor explicitly declined to choose; `not addressed` means its review did not cover that decision.
- Rate `insufficient` when fewer than two responses take an explicit position; otherwise rate `unanimous` when every response takes the same explicit position with none undecided or not addressed; otherwise rate `majority` when one position exceeds half of all responses; otherwise rate `split`.
- Count options directly for multi-option decisions. Do not force them into support versus oppose.

Split only decisions that affect the recommendation. Keep simple reports concise. Expand unresolved categories or disagreements only when they matter.

Compare the facts, assumptions, and user constraints behind each opinion. Counts and self-reported confidence do not replace evidence. Address any minority opinion that identifies a potentially decisive risk. If that risk cannot be verified, preserve the uncertainty or make the recommendation conditional.

Verify decision-changing evidence before relying on it. Require sources for new findings. If councillors share a model, do not present their agreement as independent verification; state this limitation briefly in the consensus summary. Never present your own reasoning as a councillor's opinion; re-dispatch only when the user asks to consult them again.

The Council request ends when the report is delivered. Council itself does not authorize implementation or other actions; subsequent work follows existing user instructions and authorization. Do not change Orchestrator or Goal state because of this Council.

</Council>
