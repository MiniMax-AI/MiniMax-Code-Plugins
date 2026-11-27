# BugX - Autonomous Code Review & Testing Agent

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.7-green.svg)](https://bugx.dev)

Autonomous code review and testing agent for MiniMax Code. Provides deep bug detection, multi-model consensus review, and evidence-backed verification.

---

## What BugX Does

- **Deep Bug Detection**: Uncovers security vulnerabilities, race conditions, logic errors, and corner-case crashes.
- **Multi-Model Consensus Audit**: Cross-validates issues across top AI models to eliminate hallucinations.
- **Evidence-Backed Verification**: Provides executable reproduction scripts, trace call paths, and structural code analysis.
- **MCP Native**: Integrates natively with MiniMax Code via Model Context Protocol.

---

## Prerequisites

Install `bugx-cli` (`>=0.1.7`) locally before using this plugin:

```bash
# Python
pip install -U bugx-cli

# Or npm
npm install -g bugx-cli
```

Verify your installation:

```bash
bugx --version
```

---

## Quick Start in MiniMax Code

Once enabled in MiniMax Code, invoke BugX in any project chat:

```text
/bugx 对当前项目进行自主代码审查，找出深层 Bug
```

Or run targeted security audit:

```text
/bugx 检查当前改动是否存在安全漏洞与边界缺陷
```

---

## License

Apache-2.0 © 2026 BugX Team.
