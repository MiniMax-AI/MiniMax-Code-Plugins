# Capability proposals

This directory records evidence and design proposals for future Agent capabilities outside the
current package contract, such as custom Agents, Commands, LSP, OAuth, and Hooks behavior beyond the
observe-only 0.1 contract.

A proposal is not a supported plugin capability. It must identify real user workflows, define host
ownership and security boundaries, explain cross-client portability, and link to implementation and
conformance evidence before documentation can present it as available.

The staged Hooks 0.1 declaration contract lives in [`docs/hooks.md`](../docs/hooks.md). Static
registry acceptance does not promote Hooks to an available runtime capability; that promotion still
requires a linked MiniMax Code implementation and end-to-end conformance evidence under this rule.

TUI Extensions are a separate product extension system. They do not enter this proposal or package
contract.
