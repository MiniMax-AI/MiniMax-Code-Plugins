# Verification Loop

## The problem

Agents routinely declare work "done" without evidence: the fix was written but never run, the
test suite was never invoked, or a claim of "works now" rests on confidence rather than output.
Downstream, a human discovers the gap only when something breaks.

This Plugin installs one Skill that enforces a claim-to-proof loop: state the claim, decide what
evidence would prove it, run the smallest meaningful verification, read the actual result, and
report verified / not verified / could-not-verify explicitly.

## Try it

```text
Use the verification-loop skill, finish the pagination fix, and report completion with evidence.
```

Expected result: the agent states each claim it is about to make ("page 2 returns 11-20"),
runs the smallest check that proves it (the endpoint or the targeted test), quotes the real
output, and labels anything it could not check as not verified.

## What the Skill does

- Core rule: a change is not done until the relevant claim has been verified with the smallest
  meaningful evidence.
- Six-step loop: state claim, decide evidence, run verification, read the actual result,
  iterate on failure, and state exactly what remains unverified when proof is impossible.
- Verification categories: behavior (run the flow or minimal repro), tests (targeted first,
  then broader), types/build/lint when relevant, review claims tied to concrete output, and
  separating product failures from environment limits.
- Completion vocabulary: "Verified: ...", "Not verified: ...", "Could not verify: ...",
  "Next proof step: ...".

## Requirements

- None. The Skill directs how the agent uses its existing run/test tools.

## Data and network

- No network access required.
- No credentials required.
- No data leaves the machine beyond what the host agent already does.

## License

Apache-2.0. See [LICENSE](LICENSE).
