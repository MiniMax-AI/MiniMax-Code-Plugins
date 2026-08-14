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
5. Only then propose or implement changes.

## Priorities

- Prefer exact evidence over assumptions.
- Prefer existing project patterns over inventing new ones.
- Prefer narrow, targeted changes after understanding the local context.
- When external APIs or SDKs are involved, verify with official documentation before changing
  code.
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
