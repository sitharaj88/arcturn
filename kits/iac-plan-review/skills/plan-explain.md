---
name: plan-explain
description: Explains an execution plan from the plan file alone, every sentence carrying a verbatim resource address. A resource it cannot classify as stateful is unknown, never assumed stateless, and it never concludes safe or no downtime.
---
Read an execution plan that has already been produced and say what it changes,
grounded in the file and nothing else. The plan export — a Terraform or OpenTofu
`show -json` file, an Azure `what-if` JSON, or a CloudFormation
`describe-change-set` JSON, given as a path in $CWD: $ARGUMENTS

If $ARGUMENTS is empty, or names a path that does not exist, or names a file
that does not parse as JSON, say which and stop.

This is the pack's credential-free path and the reason it is most of the use:
your CI already produced this file, reading an export needs no credential, no
backend and no cloud API call, and nothing here runs anything. Every other
asset in the pack needs a principal. This one needs a file.

## The three refusals, stated first because they decide most runs

**You will not mention a resource that is not in the file.** Every sentence in
your output carries an address copied verbatim out of the plan — from
`resource_changes[].address` for Terraform and OpenTofu, `changes[].resourceId`
for Azure what-if, `Changes[].ResourceChange.LogicalResourceId` for a
CloudFormation change set. No summarising sentence, no introduction and no
closing paragraph may name a resource, a service or a component that is not
addressed in the file. "This updates the networking layer" is exactly the
sentence this refusal exists to prevent: a plan does not contain layers.

**You will not call a resource stateless because you do not recognise it.**
Classify from the type and the address where the mapping is genuinely known.
Where it is not, the resource is `unknown`, and `unknown` is printed as loudly
as a `delete` is — because "I could not tell whether this holds data" is the
question the approver has to answer, and rounding it to "stateless" answers it
for them, wrongly, in a voice that sounds mechanical.

**You will not write "safe", "no downtime" or "low risk".** Those are the
approver's judgment and a plan file does not contain the inputs to them: not
the traffic, not the hour, not the customer commitments, not the rollback path,
not who is on call. You have the mechanism, they have the tolerance. Print the
mechanism, in these shapes:

```
module.db.aws_db_instance.main — actions ["delete","create"] — replace, destroy-first
  forced by replace_paths: [["engine_version"]] — holds data: yes (aws_db_instance)
```

Rounding a plan you find unremarkable up to "this looks fine" is the same
failure as rounding a plan you find alarming down. Neither word is in the file.

## 1. Identify the dialect and say which

The three exports carry different fields and different silences, and half of
reading a plan correctly is knowing which one you are holding.

| Dialect | The array | Address field | Action field | Replacement is |
|---|---|---|---|---|
| Terraform / OpenTofu `show -json` | `resource_changes[]` | `address` | `change.actions` | `["delete","create"]` or `["create","delete"]` |
| Azure `what-if` | `changes[]` | `resourceId` | `changeType` | `Create` + `Delete` pair, or `Deploy` with a delta |
| CloudFormation change set | `Changes[]` | `ResourceChange.LogicalResourceId` | `ResourceChange.Action` | `ResourceChange.Replacement` |

Print the dialect, the tool version where the file records one
(`terraform_version`, `format_version`), and the file path, in the first line.
A file that parses as JSON but carries none of these three shapes is not a plan
you can read: say what top-level keys it does have, and stop.

## 2. Terraform and OpenTofu

Read the action from `change.actions`. It is the provider's own classification
and it outranks any reading you could do of the before/after values:

| `change.actions` | Meaning |
|---|---|
| `["create"]` | create |
| `["update"]` | in-place update |
| `["delete"]` | destroy |
| `["delete","create"]` | replace, destroy-first — the resource is gone before its successor exists |
| `["create","delete"]` | replace, create-first |
| `["no-op"]` | no change |
| `["read"]` | a data source read during apply |

Print `change.replace_paths` verbatim for every replacement. The provider says
which attribute forced it; paraphrasing it — "due to a configuration change" —
throws away the one fact the reader came for.

`change.after_unknown` marks attributes that are `(known after apply)`. Those
are unknown. Do not compute them, do not carry the `before` value forward as
though it were unchanged, and do not describe an unknown as "unchanged".

`change.before_sensitive` and `change.after_sensitive` mark values the provider
redacted. Print `redacted-by-provider`, never a guess at the value, and never a
claim that the value did not change — the plan does not say that.

Watch for the fields a summary usually drops: `mode` (`managed` versus `data`),
`deposed` (a leftover from a failed create-before-destroy), and
`action_reason` on the resource change, which sometimes names the tainting or
the `replace_triggered_by` that caused a replacement.

## 3. Azure what-if

`changeType` takes `Create`, `Delete`, `Deploy`, `Modify`, `NoChange`, `Ignore`
and `Unsupported`. The last two are the ones that matter and the ones a summary
loses:

- `Ignore` means the resource exists and this deployment's mode leaves it
  alone. It is not "no change to the resource"; it is "outside this
  deployment's scope."
- `Unsupported` means what-if could not evaluate the resource type at all. That
  is `NOT-EVALUATED` in your output, with the `unsupportedReason` quoted
  verbatim where the file carries one. It is never a `NoChange`.

For `Modify` and `Deploy`, read `delta[]`: each entry has `path`,
`propertyChangeType` (`Create`, `Delete`, `Modify`, `Array`, `NoEffect`) plus
`before`/`after`. Print the `path` verbatim. `NoEffect` means what-if predicts
the property will be ignored by the provider — report it as predicted-no-effect
rather than dropping it, because the prediction is what-if's and it can be
wrong.

What-if evaluates a template against what the resource provider tells it, and
the file itself records where that evaluation stopped. Whatever it did not
evaluate, print as not evaluated. Do not fill the gap by reading the template.

## 4. CloudFormation change sets

`ResourceChange.Action` takes `Add`, `Modify`, `Remove`, `Import` and
`Dynamic`. `Dynamic` means CloudFormation cannot determine the change until it
runs; that is `unknown`, printed as such.

`ResourceChange.Replacement` is the field to carry verbatim, and its three
values are not two:

| `Replacement` | What it means |
|---|---|
| `True` | the physical resource is replaced |
| `False` | it is not |
| `Conditional` | **genuinely unknown** — CloudFormation cannot tell in advance |

`Conditional` is not "probably not". It is the service saying it does not know,
and a reader who sees it flattened to "no replacement" has been told something
the file does not say. Print `Conditional` as `unknown-replacement`, alongside
the `Details[]` entries whose `Evaluation` is `Dynamic`, which is where the
uncertainty comes from.

`Details[]` also carries `ChangeSource` and `CausingEntity` — the parameter,
resource attribute or reference that drove the change. Quote them; they are the
CloudFormation equivalent of `replace_paths`.

Read the change set's own `Status` and `ExecutionStatus` before anything else.
A change set in `FAILED` with a `StatusReason` describes no changes at all, and
the honest output is that reason quoted verbatim, not an empty diff.

## 5. Classify what holds data

For each resource, one of three values, and the third is a real answer:

- **holds data: yes** — with the reason from the type or the address. Databases
  and their instances and clusters, object stores, disks and volumes,
  filesystems, queues and streams with retained messages, caches holding the
  only copy, secrets and key material, stateful sets and their claims.
- **holds data: no** — with the reason. Routing rules, security-group rules,
  IAM attachments, tags, DNS records, log-group settings, most policy
  documents.
- **holds data: unknown** — because the type is one you cannot map with
  confidence, because the resource is a module output or a generic custom
  resource, or because a name suggests one thing and the type another. This is
  the honest and frequent case. Print it; do not resolve it.

Key material and secrets deserve their own note when replaced: a replacement of
a key or a secret can be recoverable or can be permanent depending on the
service's own retention behaviour, and the plan does not record which. That is
`unknown`.

## 6. Order by mechanism, not by feeling

Rank the output this way, and say that this is the ordering:

```
1. delete
2. replace, destroy-first        (of resources that hold data, then unknown, then not)
3. replace, create-first
4. unknown-replacement           (CloudFormation Conditional, Terraform action_reason absent)
5. update with an unknown attribute
6. update
7. create
8. no-op / NoChange / Ignore / NOT-EVALUATED
```

That is an ordering by irreversibility, which is a property of the file. Any
ordering by "risk" would be a property of your guess.

## Output

```
PLAN-EXPLAIN — <dialect> · <file path> · <tool version if recorded>
COUNTS: create <n>  update <n>  delete <n>  replace <n>  no-op <n>  other <n>
        total <n> = len(<the array>) <n>   [must match]
UNKNOWN: <n> resources whose data-holding could not be classified
NOT-EVALUATED: <n> (Unsupported / Dynamic / FAILED change set)
```

Then one block per resource in the order above:

```
<address, verbatim>
  actions: <verbatim>          replace_paths / Replacement / delta path: <verbatim>
  holds data: yes | no | unknown — <reason>
  changed: <attr: before -> after>, <attr: unknown (known after apply)>,
           <attr: redacted-by-provider>
```

Close with the two lines that bound the claim:

```
Read from <file> alone. No credential was used, no API was called, and no state
was refreshed — so this describes the plan as recorded, not the account as it is
now. Whether these changes are acceptable is the approver's judgment; this file
does not contain the inputs to it.
Not addressed here: <anything in the file you could not read, with the reason>
```

If the file is stale, say so from the file: a plan JSON records the version and
often a timestamp in the surrounding CI artifact, and a change set carries
`CreationTime`. A plan is a claim about the state as it was when it ran. It is
not a claim about now, and this output never implies it is.
