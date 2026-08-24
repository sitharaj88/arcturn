---
name: exposure-check
description: Answers whether a resource is reachable from the internet using only what an API returned, lists every denied call as a denial rather than a negative, and never concludes "not exposed".
---
Work out whether the resources named below are reachable from the internet, and
say so in a sentence a reader can size. The resources, the scopes and the
regions to look in — a resource id, an ARN, a bucket name, a subscription, a
project, or a path to a scanner's JSON output in $CWD, and it may be empty:
$ARGUMENTS

If $ARGUMENTS is empty, or names a path that does not exist, say which and stop.

## The refusal, stated first because it decides every run

**You will not conclude "not exposed."** That sentence is a claim about the
resource, and you are not in a position to make one — you are in a position to
report what a finite list of API calls returned to one principal in one set of
regions at one moment. So the verdict you write instead is:

```
No public exposure found by the 6 checks listed below, in us-east-1 and eu-west-1,
as arn:aws:sts::[account]:assumed-role/posture-audit/session.
4 checks could not run — listed as denials below.
```

Every part of that sentence is load-bearing: the count of checks, the checks
themselves listed, the regions, the principal, and the count that did not run.
Drop any one of them and it becomes the sentence you refused to write.

**Every denied call is a denial, never a negative.** An `AccessDenied` on
`s3:GetBucketPolicyStatus` means the bucket's public status is **unknown**. It
does not mean private, it does not mean the check passed, and it does not get
folded into a summary that reports only findings. A denial is a row in the
denial table with its verbatim error and the permission that would fix it.

The same rule covers every other way a call fails to answer: a throttle, a
timeout, a region that is not opted in, a service that is not enabled, an
expired token, a call you never made because a paginator stopped early. All
unknown. All listed.

**You report only what an API returned.** You will not infer exposure from a
Terraform file, a CloudFormation template, a Bicep file, a Helm chart or a
committed policy document. Those describe an intent; the API describes the
world, and the interesting cases are exactly the ones where they differ. If
$ARGUMENTS points only at IaC, say so, print the read-only API calls that would
answer the question, and stop — the analysis you can do on HCL alone is a
different pack's job (`iac-plan-review`), and doing it here under this heading
is how a static reading acquires a live look.

**Where IaC and the live API disagree, you report both.** That is a drift row —
what the file says, what the API returned, both quoted with their sources — and
you pick neither. Deciding which one is "really" true from your chair is the
error; the drift itself is the finding, and it is usually a more important one
than either reading alone.

## Exposure is a path, not a flag

A resource is reachable when every hop in a chain permits it. One permissive
hop is not exposure and one restrictive hop is not safety, so enumerate the
chain and report each hop's state separately.

The hops, and the read-only call that establishes each:

- **Address**: does the resource have a public address at all — a public IP, a
  public DNS name, a public endpoint, a global service URL?
- **Network path**: security groups or NSGs, network ACLs, firewall rules, route
  tables and internet or NAT gateways; for a load-balanced target, the
  listener's scheme and the target group behind it.
- **Resource policy**: the bucket policy, queue policy, topic policy, key
  policy, endpoint policy, or the object ACL — and the account-level public
  access block that overrides them.
- **Identity policy and trust**: who may assume into the account, whether the
  trust policy names a wildcard principal, whether an external id is required.
- **Service front door**: an API gateway's authorizer, a function URL's auth
  type, a database's public accessibility flag, a container service's ingress.
- **DNS and CDN**: a record pointing at the resource, a distribution in front of
  it, an origin that answers directly when the distribution is bypassed.

For each hop write `PERMITS`, `BLOCKS` or `UNKNOWN` with the call that
established it. `UNKNOWN` at any hop caps the whole chain: a path with one
unknown hop is `PATH-UNKNOWN`, never "blocked because another hop blocks it" —
unless the blocking hop is one you actually observed, in which case say which
hop blocks and note that the rest of the chain was not established.

## Reachability observed beats reachability derived

The strongest evidence is a service telling you it computed reachability:
an IAM Access Analyzer external-access finding, a Network Access Analyzer path,
a reachability analyzer result, a Defender for Cloud internet-exposure
recommendation, a GCP org-policy or Security Command Center finding. Quote
those with their finding id and the time they were generated, and prefer them
over your own chain reconstruction.

Say which you used. A chain you reconstructed from six calls and a finding the
provider computed are different classes of evidence, and merging them into one
confidence is how the weaker one inherits the stronger one's authority.

Never attempt to prove exposure by connecting to anything. No `curl` at a
suspected endpoint, no port scan, no `nc`, no DNS-resolve-then-probe, no
credential replay. This skill reads control-plane API responses. Probing a host
is an action against a system that may not be yours, and the fact that it would
settle the question is not a licence.

## Output

```
EXPOSURE CHECK — <what was examined> · <scopes and regions> · <principal>
VERDICT: PUBLIC EXPOSURE FOUND | NO PUBLIC EXPOSURE FOUND BY THE CHECKS BELOW | PATH-UNKNOWN
CHECKS RUN: <n>   DENIED OR UNANSWERED: <n>
```

Then, in this order:

The **checks that ran**, each with its command and what it returned.

The **chain table**, one row per hop per resource: hop, state (`PERMITS` /
`BLOCKS` / `UNKNOWN`), the call that established it, and the quoted line.

The **denials**, and this table is never empty when a call failed:

```
DENIED — s3:GetBucketPolicyStatus on posture-fixture-artifacts
  $ <the exact command>   exit <code>
  <the verbatim error, including the error code>
  Means: UNKNOWN, not private.
  Would be settled by: <the permission this principal lacks>
```

The **drift rows**, where a file and an API disagreed, both quoted with sources
and neither chosen.

The **not examined**: resources in scope you did not reach, regions not
enumerated, services not enabled — each with why.

Close with the bound, which is the whole of what this output claims:

```
Checked <n> resources across <regions> as <principal> at <timestamp>. Says
nothing about resources not enumerated, regions not listed, calls this principal
cannot make, or the state of anything one minute after this timestamp.
```

## What this skill will not write

`Not exposed.` `The bucket is private.` `Locked down.` `No public access.`
`Secure.` Each of those is a claim about a resource, backed by a set of calls
that may have been denied, throttled, scoped to the wrong region or simply not
made. Replace it with the checks, their count, their scopes and the principal —
and if that sentence reads as weaker, that is the measurement, not the writing.
