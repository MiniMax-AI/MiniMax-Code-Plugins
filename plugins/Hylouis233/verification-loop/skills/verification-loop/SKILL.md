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
4. Read the actual result, not the expected result.
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

## Good completion language

- Verified: <what was checked>
- Not verified: <what was not checked>
- Could not verify: <why verification was blocked>
- Next proof step: <the most useful remaining check>

## Good outcomes

- Fewer premature completion claims.
- Clearer handoffs between implementation and review.
- Lower regression risk.
- Better distinction between confirmed facts and assumptions.

## Notes

- This is a workflow skill only.
- It must not modify hooks, settings, plugins, or global configuration on its own.
