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

1. State what claim needs to be true.
2. Decide what evidence would prove or disprove that claim.
3. Run the smallest meaningful verification.
4. Read and record the actual result, not the expected result. Preserve the command or user-facing
   action, its status, and the concise non-sensitive observation that proves or disproves the claim.
5. If verification fails, continue iterating instead of declaring success.
6. If verification is impossible, say exactly what remains unverified.

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

## Completion evidence format

Every successful verification entry must include both the claim and the evidence actually
observed. Do not write a bare statement such as `Verified: targeted tests`.

- Verified: <the claim that was proved>
  - Evidence: <command or user-facing action> — <exit status and concise observed result>
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
