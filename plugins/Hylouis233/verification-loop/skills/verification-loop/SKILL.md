---
name: verification-loop
description: Enforce a claim-to-proof workflow before declaring work complete. Use this Skill when a task involves implementation, debugging, review, or any other work that could be claimed complete without concrete evidence.
---

# Verification Loop

Use this skill when a task involves implementation, debugging, review, or any other work that
could be claimed complete without concrete evidence.

## Core rule

Do not treat a change as done until the relevant claim has been verified with the smallest
meaningful evidence.

## Workflow

1. Enumerate every independent claim that must be true for the task to be complete, including each
   user requirement and acceptance criterion.
2. For each claim, decide what evidence would prove or disprove it.
3. Run the smallest meaningful verification for each claim.
4. Read and record the actual result, not the expected result. For a command, preserve the
   command, exit status, and concise non-sensitive observation. For a manual user-facing action,
   preserve the action and its observed outcome; do not invent a process exit status.
5. If a claim is disproven and the task calls for a fix, iterate when a safe, relevant change
   remains. Otherwise, stop and hand off the negative result honestly; never declare success.
6. Before completion or handoff, account for every claim as Verified, Failed, Not verified, or
   Could not verify.

## Verification categories

- Behavior: run the user-facing flow or a minimal reproduction.
- Tests: run the most relevant targeted tests first, then broader coverage if needed.
- Types/build: confirm typecheck, build, or lint only when they are relevant to the claim.
- Review claims: tie review conclusions to concrete code or tool output.
- Environment limits: distinguish product failures from setup limitations.

## Priorities

- Prefer evidence over confidence.
- Prefer the smallest proof that closes the relevant uncertainty.
- Distinguish verified, unverified, and unverifiable outcomes explicitly.
- Do not rely on "it should work" when a check can be run.
- When an end-to-end flow matters, test the golden path before reporting completion.
- Any selected host command may retain its own network behavior, even when described as a local
  test or check. Inspect its script, configuration, and documentation before running it. If its
  network behavior cannot be determined, treat it as a remote action and do not run it until the
  destination and data flow are explicitly confirmed under the rules below.
- Before any verification that would contact a remote endpoint, state the exact destination, the
  minimal data to be sent, and whether the action may mutate remote state. The destination must be
  supplied by the user or explicitly confirmed by the user before proceeding. Any potentially
  mutating remote check also requires explicit user confirmation, even when its destination was
  already supplied. Host policy must permit the action. Never send credentials, personal data,
  private endpoints, or unrelated repository content.
- If network access is unavailable or unsafe, do not substitute confidence for proof; report the
  remote behavior as not verified and give the next safe proof step.

## Completion evidence format

The final report must include every completion claim enumerated in step 1. Every successful
verification entry must include both the claim and the evidence actually observed. Do not write a
bare statement such as `Verified: targeted tests`, and do not omit an untested requirement.

- Verified: <the claim that was proved>
  - Evidence (command): <command> — <exit status and concise observed result>
  - Evidence (manual): <user-facing action> — <observed outcome>
- Failed: <the claim that was disproven>
  - Evidence: <command/action> — <status or outcome and concise observed result>
- Not verified: <what was not checked>
- Could not verify: <why verification was blocked>
- Next proof step: <the most useful remaining check>

Quote or summarize only the output needed to prove the claim. Redact credentials, personal data,
private endpoints, and unrelated repository content from completion reports.

## Good outcomes

- Fewer premature completion claims.
- Clearer handoffs between implementation and review.
- Lower regression risk.
- Better distinction between confirmed facts and assumptions.

## Notes

- This is a workflow skill only.
- It must not modify hooks, settings, plugins, or global configuration on its own.
