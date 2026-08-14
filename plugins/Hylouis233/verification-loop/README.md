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
- Six-step loop: enumerate every completion claim, decide evidence for each, run the smallest
  verification for each, record the command/action and concise observed result, iterate on any
  failure, and account for every claim before completion.
- Verification categories: behavior (run the flow or minimal repro), tests (targeted first,
  then broader), types/build/lint when relevant, review claims tied to concrete output, and
  separating product failures from environment limits.
- Completion format: every "Verified" or "Failed" claim includes concrete evidence (command +
  exit status + observed result, or manual action + outcome). Untested or blocked work uses "Not
  verified", "Could not verify", and "Next proof step" explicitly.

## Requirements

- No additional executables, accounts, or paid services. The Skill directs how the agent uses the
  host's existing run/test tools.
- Platform-independent; supported wherever MiniMax Code Agent Plugins 1.0 Skills are available.

## Data and network

- This Plugin has no fixed network dependency or destination. Each host-project command or
  user-facing flow selected for verification retains its own network behavior; even a command run
  locally may contact registries, test services, or remote endpoints. The Skill requires inspecting
  that behavior first; unknown behavior is treated as remote and skipped until the destination and
  data flow are explicitly confirmed.
- Before any remote action, the Skill requires disclosure of the exact destination, minimal data
  sent, and whether remote state may change. The destination must be user-supplied or explicitly
  confirmed by the user. Any potentially mutating remote check requires explicit confirmation even
  when the destination was already supplied.
- Credentials, personal data, private endpoints, and unrelated repository content must not be sent
  or included in completion evidence.
- If host policy, connectivity, or data-safety constraints block the request, the Skill records the
  remote behavior as not verified and gives the next safe proof step.
- This Plugin requires no credentials of its own.

## License

Apache-2.0. See [LICENSE](LICENSE).
