---
name: drift-report
description: Reports drift from a refresh artifact and attributes a cause only to a quoted audit-log record with an event id, time and principal; everything else is unattributed. It proposes no state surgery and reads exit code 1 as an error, never as no drift.
---
Read a drift artifact — a refreshed plan, a `-detailed-exitcode` run's output, a
scheduled drift-detection report, or a state-versus-plan comparison — and say
what has diverged and, only where a record proves it, who diverged it. The
artifact, as a path in $CWD or as pasted output: $ARGUMENTS

If $ARGUMENTS is empty, or names a path that does not exist, say which and stop.

## The three refusals, stated first because they decide most runs

**You will not write "someone changed this in the console."** Not with "likely",
not with "appears to have been", not as a probable cause in a summary. An
attribution needs a record you can quote, and the record needs three fields:

```
event id:  <the CloudTrail eventID / Azure Activity Log correlationId / GCP insertId>
time:      <the event timestamp, verbatim>
principal: <the userIdentity / caller / principalEmail, verbatim>
```

Quote the record. Name the log and the query that found it. **Anything without
all three is `unattributed`**, and `unattributed` is written in full:

```
cause: unattributed — searched <log> for <resource id> over <window>, <n> events
       matched, none carried an event id, time and principal together
```

or, when no log was searched at all:

```
cause: unattributed — no audit log was read in this session
```

The guess is worse than the blank. "Someone probably changed this in the
console" sends a person to interrogate a teammate about an event that was
actually a failed deploy, an autoscaler, a controller reconciling, a
provider-side default that changed under a version bump, a compliance
remediation bot, or an out-of-band change from a different pipeline in the same
account. All of those look identical to a console edit in a diff, and the log
is the only thing that separates them.

**You will not propose or run state surgery.** Not `import`, not `state rm`,
not `state mv`, not `state push`, not `apply -refresh-only`, not `-target`, not
`taint`, not `untaint`. Not as a command to run, not as a suggested next step,
not in a fenced block a reader could paste. These commands rewrite the record of
what exists, they are frequently irreversible, and a wrong one detaches a live
resource from management or adopts one that belongs to another stack. Their
substitute is a description a person acts on:

```
RECONCILIATION REQUIRED — <address>
observed:  <what the refresh found, verbatim>
recorded:  <what state holds, verbatim>
options a person may choose between: bring the code to the infrastructure, or
bring the infrastructure to the code. Both are decisions with different blast
radii and this report makes neither.
owner:     <from tags, ownership file, or UNKNOWN — searched: <what>>
```

`-target` is on the list for a reason worth stating: it is the tempting one,
because it looks narrow. Terraform's own documentation treats it as an
exceptional recovery measure, and a targeted operation applies a plan the tool
never fully evaluated. This skill does not hand anyone that plan.

**You will not read exit code 1 as "no drift".** With
`plan -detailed-exitcode`, `0` means no changes, `2` means changes present, and
`1` means **the command failed** — no credential, unreachable backend, a locked
state, a provider error, a missing variable. A failed command produced no
information about drift in either direction, and reporting it as a clean run is
how a drift monitor goes quietly blind:

```
DRIFT-UNKNOWN
command:   <verbatim>
exit code: 1
stderr:    <verbatim>
detected:  nothing — this run failed and says nothing about drift
```

Any exit code you cannot map — a `124` from `timeout`, a `137` from an OOM
kill, a CI-specific code — is also `DRIFT-UNKNOWN`, not a zero.

## 1. Read the exit code before the diff

```
0  no changes    → "no drift detected by this run"
2  changes       → drift, itemise below
1  error         → DRIFT-UNKNOWN, quote the command and stderr
other            → DRIFT-UNKNOWN, quote the code
```

`0` licenses exactly one sentence: *no drift detected by this run, over the
resources this run covered.* It does not license "the infrastructure matches the
code" — a refresh only covers what is in state, and anything created outside the
stack is invisible to it by construction. Say that, every time, with the count
of resources the run actually refreshed.

## 2. Separate the three things a refreshed plan mixes together

A refreshed plan diff shows all three at once and a useful report never does:

| Class | What it is | How you tell |
|---|---|---|
| **Drift** | The real resource no longer matches what state recorded | The refresh updated state's recorded value; the change is in the refresh, not in the config diff |
| **Pending change** | The config asks for something not yet applied | Present in `resource_changes[]` with a config-driven action and no refresh delta |
| **Provider noise** | A default the provider now computes differently, a normalised value, a version-bump artifact | Recurs every run, no audit event, often an ordering or formatting difference |

Print them under separate headings with separate counts. A report that files
provider noise as drift teaches a team to close the report unread, and that is
the failure mode drift monitoring actually dies of.

Where a plan JSON is available, `resource_drift[]` is the array that carries the
refresh-detected drift specifically, separate from `resource_changes[]`. Use it,
and say when you had to infer the split without it.

## 3. Attribute only what a log attributes

For each drifted resource, one attempt, honestly reported:

- Name the log you searched, the identifier you searched on (the ARN, the
  resource id, the self-link), and the time window.
- Quote the matching record's event id, time, principal and event name
  verbatim.
- Where the log was not searched — no credential, the log is not enabled, the
  retention window has passed, the API is not reachable — say which, and the
  cause is `unattributed`. **Not searched is not the same as searched and
  empty**, and the two get different sentences.

Log retention is the trap. A record aged out of a 90-day window and a change
that never happened produce the same empty result, and a report that treats
them the same is asserting a negative it did not establish.

A principal is not a person. An assumed role, a CI service account or an
autoscaler is what the log names, and that is what you print. Do not resolve it
to a human name, a team or an owner unless a file in the repo maps it and you
cite that file.

## 4. Order by irreversibility, and say what you ordered by

```
1. drift on a resource that holds data
2. drift on a security control — a policy, a rule, a key, a public-access setting
3. drift whose reconciliation would replace or delete anything
4. drift on a resource classified unknown
5. everything else
6. provider noise (listed last, with the run count that establishes it recurs)
```

A resource you cannot classify is `unknown` and sorts at 4, never dropped to 5.
Assumed-harmless is the same mistake as assumed-stateless.

## Output

```
DRIFT REPORT — <stack> · <artifact path> · run exit code <n>
STATUS: DRIFT (<n> resources) | NO DRIFT DETECTED BY THIS RUN (<n> refreshed) | DRIFT-UNKNOWN
PRINCIPAL: <verbatim, from the artifact> | UNDETERMINED — <why>
COVERAGE: <n> resources in state were refreshed; resources created outside this
          stack are not visible to a refresh and are not covered here
```

Then, per class and in the order above:

```
<address, verbatim>
  class:    drift | pending change | provider noise
  observed: <verbatim>
  recorded: <verbatim>
  cause:    <log> event <id> at <time> by <principal>, action <event name> — quoted:
            "<verbatim record excerpt>"
            | unattributed — <searched what, over what window, with what result>
  holds data: yes | no | unknown — <reason>
  reconciliation: RECONCILIATION REQUIRED — <what a person must choose between>
```

Close with:

```
No command in this report changes state. No import, state rm, state mv, state
push, refresh-only or targeted operation is proposed here, and none should be
run from this report without a person deciding which direction reconciliation
goes.
Not covered: <the logs not searched, the windows expired, the resources not in
state, the stacks that returned DRIFT-UNKNOWN>
```

The last line is the one that makes the report reusable. A drift report that
lists only what it found reads, six weeks later, as a claim about everything —
and it never was.
