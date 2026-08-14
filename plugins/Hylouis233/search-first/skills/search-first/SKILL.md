---
name: search-first
description: Enforce a search-before-edit workflow for code changes. Use this Skill whenever a task involves changing code, tracing behavior, or understanding an unfamiliar area, so the agent searches and reads the relevant files before proposing or implementing edits.
---

# Search First

Use this skill when a task involves changing code, tracing behavior, or understanding an
unfamiliar area.

## Core rule

Do not modify code until you have first searched for the relevant files, symbols, call sites,
nearby patterns, and affected references.

## Workflow

1. Search for the exact file, symbol, route, command, or error text.
2. Read the most relevant definitions and references.
3. Identify adjacent code paths that could be affected.
4. Identify tests, docs, configs, or UI flows coupled to the target.
5. Before proposing or editing, report a concise investigation summary: the primary
   implementation, important callers, coupled artifacts, the project pattern to follow, and the
   smallest safe change.
6. Only then propose or implement changes.

## Priorities

- Prefer exact evidence over assumptions.
- Prefer existing project patterns over inventing new ones.
- Prefer narrow, targeted changes after understanding the local context.
- For a task that proposes changing how code uses an external API or SDK, prefer versioned
  documentation already present in the repository or local environment. If it is unavailable and
  host policy permits network access, consult the dependency vendor's official documentation using
  only the minimum necessary public product, API, and version details. Never send source code,
  credentials, personal data, private endpoints, internal hostnames, or private package names.
- For read-only tracing, explanation, or investigation tasks, do not initiate an online
  documentation lookup; report any version-sensitive uncertainty instead.
- If official documentation cannot be accessed, report that limitation and treat version-sensitive
  behavior as unverified. Avoid guessing; ask the user for documentation or approval of the
  explicitly stated risk before making that part of the change.
- When the task spans multiple files or uncertainty remains high, narrow the scope or split the
  work instead of guessing.

## Minimum investigation before editing

Before editing, try to answer:

- Where is the primary implementation?
- What calls it or imports it?
- Are there tests, docs, configs, or browser flows coupled to it?
- Is there an existing pattern nearby to follow?
- What is the smallest safe change that solves the request?

## Good outcomes

- Fewer blind edits.
- Lower regression risk.
- Faster convergence on the right file and change shape.

## Notes

- This skill is a workflow aid only.
- It must not modify hooks, settings, plugins, or global configuration on its own.
