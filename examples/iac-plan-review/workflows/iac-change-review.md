---
name: iac-change-review
description: Produce the plan, read the plan, probe the policy tools honestly, and end at a person with the irreversible list named. No step in the pipeline has apply authority.
continueOnError: false
budgetUsd: 18
stepTimeoutMs: 1800000
---
Run it as `/workflow iac-change-review <the change under review: a branch, a
diff range, a PR, or the stack directories you want planned — plus the var
files and workspace it needs>`.

**No step in this pipeline has the authority to change infrastructure.** Not
gated behind an approval, not held back by a prompt: absent. Every stage
dispatches the same exec-lane role, whose `tools:` line carries no writer and
whose deny list refuses the mutating subcommands outright, and the pipeline
ends in a question rather than a decision. An `ORG-ASK` pauses a *run*; it is
not a permission boundary, and answering one does not un-delete anything. The
boundaries that hold are the read-only credential you hand this pipeline and
the permission engine, which does not read prompts at all.

Stage 1 halts when the change touches no stack. A review of nothing is not a
short review, it is a manufactured one — five stages of plausible prose about a
diff that moved a CI config and a README. `ORG-HALT` is fatal and
short-circuits every later stage, so nothing runs `init` against an account to
discover there was nothing to look at.

Stage 2 is the one that costs money and time, and it is the one allowed to
fail. `init` and `plan` against a real backend download providers and reach the
network; the 30-minute step ceiling is set for that and is the catalog floor
for any pipeline that inits. A stack that cannot plan is `PLAN-UNAVAILABLE`
with its verbatim command and real exit code, and the pipeline carries that
forward as a first-class result. Partial coverage stated is worth more than
full coverage implied.

Stage 3 reads the plan JSON and nothing else. It re-derives from the files
stage 2 produced rather than trusting stage 2's prose, which matters here more
than the general rule suggests: a paraphrase of a plan loses exactly the field
a reader needed, which is usually `replace_paths`.

Stage 4 probes each policy tool with a real command and writes **"not available
in this repo"** for every one that is absent. That line is the stage's whole
point. A missing scanner that produces silence reads as a pass on the page a
person signs, and this catalog's rule is that a check that did not run is never
reported as one that did.

Stage 5 asks. It names each resource that becomes irreversible, with its
address and the provider's own action classification, and it asks who accepts
that — it does not recommend, approve, or say the plan looks fine. There is no
`APPROVED` value anywhere in this pack.

One engine consequence worth knowing before you resume a paused run: on resume
the engine continues from the *next* stage and the human's answer **replaces
the asking step's output text**. Stage 5 is the last stage, so resuming ends
the run with the answer in place of the question. The evidence survives in
stage 4's output and in the run journal, which is why stage 5 is instructed to
name the irreversible list and stage 3 is instructed to carry the full ledger:
the packet a reader keeps is not the one being replaced.

Under plan mode this pipeline fails at stage 1 before a token is spent. Every
step dispatches on the exec lane, plan mode has no shell and no egress, so
`/workflow` warns up front and the first step is refused rather than run. Under
an ordinary permission mode the same pre-flight warns that the run will stop
for your approval as those steps come.

1. @terraform-plan-reviewer Establish scope and identity, and produce no plan yet. Print the binary and its version, the workspace, the backend type as init reports it, and the authenticated principal established by a pasted command with its real exit code; where no command can establish it write UNDETERMINED with that command and code rather than reading an identity out of a provider block, a profile name or an environment variable. Then enumerate which stack directories the change below actually touches, by listing the changed paths and mapping each to the directory whose tofu or terraform files it modifies, and print both the changed paths you found and the mapping you drew. If no changed path maps to any stack directory, emit ORG-HALT naming the paths that changed and the stack directories you searched, and stop: there is no plan to produce and this pipeline does not manufacture one. Change: {{input}}
2. @terraform-plan-reviewer For each stack the scope below names, produce a plan yourself and save it as JSON, running init with -input=false, then plan with -input=false -lock=false -out to a plan file, then show -json into a file beside it, and paste every command verbatim with its real exit code. If the input carries an ORG-HALT line, re-emit it verbatim and stop. Take no state lock and break none: a lock held elsewhere is PLAN-UNAVAILABLE with the lock id, holder and timestamp quoted from the error. Any non-zero exit ends that stack with PLAN-UNAVAILABLE carrying the verbatim command, the real exit code and the verbatim stderr, and you review nothing for it rather than reading its HCL and asserting an outcome. Record every provider source and version init installed, and note that these ran as code in your worktree. An empty plan is a successful result, not an unavailable one. Scope: {{prev}}
3. @terraform-plan-reviewer Read the plan JSON files stage 2 wrote, opening the files yourself rather than trusting the previous stage's prose, and build the resource ledger. If the input carries an ORG-HALT line, re-emit it verbatim and stop. Every line you write carries an address copied verbatim from resource_changes[].address and no sentence mentions a resource absent from that array. Print change.actions verbatim as the provider classified it, and for every replacement print change.replace_paths verbatim and say whether the replacement is destroy-first or create-first. Mark every attribute in change.after_unknown as unknown and compute nothing the plan left open. Classify each resource as holding data, not holding data, or unknown, and never call a resource you cannot classify stateless. Print the counts and prove they sum to the length of resource_changes. Write neither safe nor no downtime nor low risk anywhere; rank by mechanism instead, replacement before update and destroy-first before create-first. Plans: {{prev}}
4. @terraform-plan-reviewer Audit what could not be checked, re-deriving from the repository and the tools on this machine rather than from the previous stage. If the input carries an ORG-HALT line, re-emit it verbatim and stop. Probe each policy tool this repo configures or that this stack's ecosystem expects — checkov, tfsec, trivy config, terrascan, conftest and tflint — with a real presence command, paste the probe and its exit code, and write the exact line not available in this repo for every tool that is absent rather than a plausible green line or a silence. For each tool that did run, quote its rule ids and messages verbatim with the tool name and version, and invent no check id, control number, CVE or severity. Then map the plan-time execution surface: search the stacks for external data sources, http data sources and local-exec or remote-exec provisioners and list the addresses found, or write none found with the patterns and paths you searched. Close with the coverage list — every stack that is PLAN-UNAVAILABLE, every tool that was absent, and every scope you could not enumerate. Ledger: {{prev}}
5. @terraform-plan-reviewer Close the run by naming what becomes irreversible and asking who accepts it. If the input carries an ORG-HALT line, re-emit it verbatim and stop. List every resource whose plan action is delete or a replacement, each with its verbatim address, its verbatim change.actions, its replace_paths where present, and whether it was classified as holding data or as unknown; state the count of resources classified unknown separately, because unknown is what the approver is actually deciding about. Restate the principal and the coverage gaps in two lines so the question is legible without scrolling. Then emit a single ORG-ASK line that asks the named human whether they accept those specific irreversible changes on this specific stack as this principal, and that names the deletions, the replacements and the unknown count inside the question. Ask a question and never a recommendation: do not write that the plan looks fine, do not write safe or no downtime or low risk, do not approve anything, and emit VERDICT: ADVISORY, which is the only verdict value in this pack. Coverage audit: {{prev}}
