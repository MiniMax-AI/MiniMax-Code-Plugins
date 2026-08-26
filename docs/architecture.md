# Hosted Plugin architecture

MiniMax Code Plugins keeps contribution and review in one repository.

```text
plugins/<owner>/<plugin>
  plugin.json + README + LICENSE + Skills, MCP, and/or Hooks
          |
          v
local validation -> pull request CI -> human review
          |
          v
main branch -> catalog consumers / MiniMax Code discovery
```

The hosted directory is the publication unit. Reviewers inspect the exact files that enter `main`;
contributors do not create a second repository or maintain a separate catalog record.

Static validation reads package metadata and text contracts without executing Plugin code. In
particular, CI never executes contributed Hook commands. Human review covers usefulness,
dependencies, implicit execution, data flow, and reproducibility. MCP and Hook runtime behavior and
external service quality still require explicit test evidence from a compatible client.

The first version intentionally optimizes for a low-friction community path. External source
registries, release mirroring, and Marketplace publishing interfaces can be proposed later without
changing the portable Agent Plugin package itself.
