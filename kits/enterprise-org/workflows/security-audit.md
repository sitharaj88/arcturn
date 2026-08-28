---
name: security-audit
description: Threat model, three-lane scan with non-LLM scanners alongside the models, confidence triage, one bounded courtroom round, and a routed human decision. Never auto-remediates.
stepTimeoutMs: 1800000
continueOnError: false
budgetUsd: 20
---
Run it as `/workflow security-audit <the scope, e.g. the permission engine and
everything that calls it>`.

This pipeline is advisory by construction and says so at every stage. No agent
in it signs off on anything. Agents show a 3.5x to 6x capability collapse from
capture-the-flag benchmarks to real CVE exploitation, and a documented
head-to-head found nine agent-discovered vulnerabilities against forty-nine
human-found on the same targets. The pipeline is a ranked first pass that ends
at a named human approver.

Stage 2 runs the real scanners in their own lane alongside the two model
lanes, and stage 3 keeps their output separate from everything a model merely
believed. That separation is the whole point: a scanner rule id is an oracle,
a model opinion is triage input, and the artifact must never blur them.

Stage 4 is one courtroom round, capped. The prosecutor argues the finding; the
defender must cite line numbers and command output rather than assertions.
Debate is capped at two rounds because accuracy peaks there and degrades after,
and because a defender that argues confidently without evidence is the
documented failure mode of this technique. The human is the tie-breaker, never
a majority vote among models from the same family.

Dispatch lane follows the role's declared `tools:`: `write`/`edit` puts a role on the write lane, `bash` alone (with neither of those) puts it on the exec lane, and no mutating tool at all is the read lane. `architect` and `tech-lead` carry none of the three, so they are the only roles in this pipeline on the fresh-context **read lane** — no worktree, nothing to execute. `security-reviewer` and `qa-adversarial` both carry `bash` alone, so both run on the **exec lane**: their own isolated worktree, seeded with the run's state so far, so they can actually run the checks and repros stages 2 and 4 ask of them — but with an unconditional guarantee, not a well-behaved habit: whatever happens inside that worktree is never captured and never applied, and the engine appends `ARCTURN-PATCH: status=discarded` to their output itself, regardless of what the step's own text claims. Stage 4's defender, `@developer`, is the one role here on the **write lane** — it carries `write`/`edit` on top of `bash`, so its worktree's diff genuinely is captured and would be applied if non-empty; the brief just never asks it to touch a file, so its expected trailer is `status=empty` (captured nothing to apply), not `status=discarded` (structurally incapable of applying anything), which is the distinction that actually matters here.

Never auto-remediate from this pipeline. A confirmed finding becomes a work
item that re-enters bug-fix with its own gates and its own independent
reviewer.

1. @architect Build the threat model for this scope: {{input}} — enumerate the trust boundaries actually present in the code you read, name every entry point that crosses one, list the security invariants this codebase already relies on together with the exact command or grep that checks each, and mark which invariants currently have no oracle at all. Emit ARTIFACT: ADR restricted to the security section, and state plainly which parts of the scope you could not read.
2. Three independent lanes over the same scope — two model lanes and one lane that is not a model at all:
   - @security-reviewer Work the CWE and OWASP ASI class lists rather than your intuition, assess reachability and impact for every candidate, and emit ARTIFACT: SECREC with high and medium confidence findings surfaced and low confidence ones ranked in an appendix outside the blocking path. Threat model: {{prev}}
   - @qa-adversarial Attack the invariants named in the threat model by running their check commands, and emit ARTIFACT: FINDINGS in which every blocker carries a reproduction command and its observed output and everything unreproduced is explicitly an annotation. Threat model: {{prev}}
   - [tier:fast] Run only the non-model checks this repository actually has and quote each command with its verbatim output tail and real exit code — dependency audit, lockfile diff against the previous revision, secret scanning, static analysis, licence check, type-check — writing not available in this repo for anything absent rather than inventing a plausible green line, and emit ARTIFACT: SCANREC listing every rule id that fired. Threat model: {{prev}}
3. [tier:build] @tech-lead Triage the three lanes below into one ranked register with the oracle-backed findings — those carrying a scanner rule id or a reproduced proof of concept — listed strictly above every model-judgment finding, deduplicated across lanes with the lane that found each one recorded, and select the top three findings by reachability times impact for the courtroom round. Change nothing about a finding's text while ranking it. Lanes: {{prev}}
4. Courtroom round over the top three findings, one round only:
   - @security-reviewer Act as prosecutor for each of the top three findings below: state the exact attacker, the exact precondition, the exact steps, and the exact observable consequence, citing file and line for every claim, and mark any step you could not demonstrate as unproven rather than asserting it. Findings register: {{prev}}
   - [tier:judgment] @developer Act as defender for each of the top three findings below by citing line numbers, existing guards and command output — never by asserting that the code is fine — and where you cannot produce evidence say so and concede the point rather than arguing. Findings register: {{prev}}
5. [tier:build] @security-reviewer Assemble the final SECREC from the courtroom exchange below, recording for each finding the prosecution case, the defence, whether the defence cited evidence or merely asserted, and a status of confirmed, rebutted or undecided — leaving undecided ones undecided, because a tie is a human decision and not a majority vote. Set VERDICT to ADVISORY, set HUMAN-APPROVER-REQUIRED for every tier-1 path finding regardless of confidence, propose each confirmed finding as a bug-fix work item rather than remediating anything, and end with the DECISION-REQUEST block addressed to the named security approver. Courtroom: {{prev}}
