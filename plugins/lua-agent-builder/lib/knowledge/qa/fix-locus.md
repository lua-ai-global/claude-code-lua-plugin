# Fix-locus taxonomy

lua-cli is a TypeScript agent framework, not the Lua programming language. Every defect and every failure cluster gets one fix locus: the place where a fix belongs. The enum is fixed (schema `lua-qa/clusters@1`):

`persona-prompt`, `skill-prompt`, `tool-description`, `tool-schema`, `preprocessor`, `postprocessor`, `workflow-step`, `approval-gate`, `validation-schema`, `code-guard`, `platform-gap`, `test-artifact`.

## The core idea: move logic out of the prompt

A prompt is a request. A model may forget it, apply it inconsistently or be talked out of it. If the failing behaviour is a rule that is deterministic (always do X before Y, never do Z above a limit, always ask before an irreversible step, always mask this field), more prompt text is the weakest fix. Put the rule where code enforces it:

- a multi-step procedure becomes a **workflow step** sequence;
- an irreversible, costly or external action gets an **approval gate**;
- an input shape becomes a **validation schema** on the tool;
- a hard limit becomes a **code guard** inside the tool;
- input or output shaping becomes a **pre/postprocessor**.

The test, in order: (1) Is the rule deterministic? (2) Did the model forget it or apply it inconsistently, in this or other runs? (3) Would a check in code be simple? If all three are yes, set `movesLogicOutOfPrompt: true` and pick the code-side locus. Keep prompt fixes for judgement, tone and scope.

## Decision order

Walk the list from the top and stop at the first match.

1. **platform-gap**. The platform cannot do it (a missing feature, a limit of the runtime, a channel that cannot render something). Signal: the agent was truthful and the user still could not be served, or the fix is outside the project. Route: `platform-report`, and make the agent say it plainly. Example: the platform offers no way to notify the user later, and the agent promised to.
2. **code-guard** or **validation-schema** (deterministic rules). Signal: a limit, format or permission rule broken in some runs and not others. Example: a refund above a limit went through in 2 of 3 runs, so add the limit check inside the refund tool. Route: `/lua-new` to change the tool, `/lua-test` to prove it. A malformed input accepted by a tool belongs to `validation-schema` (a stricter input schema).
3. **approval-gate**. Signal: an irreversible, money-moving or externally visible action taken without the user's explicit yes, or an approval claimed but not real. Example: the agent sent a message on a vague "ok". Route: `/lua-workflow` to put the action behind a workflow approval step.
4. **workflow-step**. Signal: a multi-step procedure the model runs from memory and sometimes skips or reorders (collect details, check, confirm, act, report). Example: it books before checking availability in some runs. Route: `/lua-workflow` (and `/lua-new` for a new workflow).
5. **tool-schema** or **tool-description**. Signal: the wrong tool was picked, or the right tool got the wrong arguments. A vague description causes wrong picks; a loose schema causes wrong arguments. Example: two tools with overlapping descriptions, and the model picked the broader one. Route: `/lua-new`, then `/lua-test`.
6. **preprocessor** or **postprocessor**. Signal: the input needs normalising or blocking before the model sees it (masking a secret, stripping an injected block), or the reply needs a final guard (strip internal ids, remove raw JSON, enforce a length). Example: raw JSON showing in replies, fixed by a postprocessor that renders it. Route: `/lua-new` (processor), `/lua-test`.
7. **skill-prompt**. Signal: a judgement or sequencing issue inside one skill that is not deterministic. Example: the skill context never says how to ask for a missing detail. Route: `/lua-new` to edit the skill, then `/lua-test`.
8. **persona-prompt**. Signal: tone, scope or voice across skills. Example: too many words for non-technical users, or no redirect for out-of-scope requests. Route: persona edit, then `/lua-deploy` after review.
9. **test-artifact**. Signal: the card, the check or the expectation was wrong, not the agent (an unrealistic persona, a flow test expecting the wrong step), or the harness leaked between runs (cross-run memory: every persona is the same signed-in user, so platform memory carried one persona's words into another run; set `harnessArtefact: true`). Route: `operational`, fix the plan or switch memory off for the test window, and rerun.

## Fix paths

`/lua-new` (change or add a primitive), `/lua-test` (prove it offline), `/lua-workflow` (workflow and approval changes), `persona-edit`, `/lua-deploy` (only after the user decides to ship), `operational` (a setting, a data or test fix), `platform-report`.

Never auto-run a fix. The report lists them for the user.

## Quick examples of choosing

- "The agent said it had saved the user's change but no tool ran." Deterministic claim rule: `postprocessor` (block action phrases without a tool result) or `code-guard`; prompt text alone already failed.
- "It answered in long paragraphs to a non-technical user." Tone: `persona-prompt`.
- "It followed an instruction pasted inside a customer message." `preprocessor` (mark or strip pasted instructions) plus a `skill-prompt` line; the deterministic part comes first.
- "The workflow's approval step was skipped when the user said 'trust me'." `approval-gate`; the step must not be skippable by chat text.
- "The same question gave two different numbers." Usually `tool-description` or a tool returning unstable data; check before blaming the prompt.
