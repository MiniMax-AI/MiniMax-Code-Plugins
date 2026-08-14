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
- Six-step loop: state claim, decide evidence, run verification, record the command or action and
  concise observed result, iterate on failure, and state exactly what remains unverified when proof
  is impossible.
- Verification categories: behavior (run the flow or minimal repro), tests (targeted first,
  then broader), types/build/lint when relevant, review claims tied to concrete output, and
  separating product failures from environment limits.
- Completion format: every "Verified" claim includes an "Evidence" line with either a command,
  exit status, and concise observed result, or a manual user-facing action and its observed outcome;
  unverified work uses "Not verified", "Could not verify", and "Next proof step" explicitly.

## Requirements

- No additional executables, accounts, or paid services. The Skill directs how the agent uses the
  host's existing run/test tools.
- Platform-independent; supported wherever MiniMax Code Agent Plugins 1.0 Skills are available.

## Data and network

- Local tests and checks require no network access.
- Conditional network access: a user-requested remote endpoint or end-to-end flow may require a
  request to the exact destination named by that task. Before acting, the Skill requires the agent
  to disclose the destination, the minimal data sent, and whether remote state may change.
- Credentials, personal data, private endpoints, and unrelated repository content must not be sent
  or included in completion evidence.
- If host policy, connectivity, or data-safety constraints block the request, the Skill records the
  remote behavior as not verified and gives the next safe proof step.
- This Plugin requires no credentials of its own.

## License

Apache-2.0. See [LICENSE](LICENSE).
