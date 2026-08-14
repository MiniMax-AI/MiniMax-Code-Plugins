"""github-explore skill scripts — Python wrappers around common search operations.

Each script is a thin layer that:
  - validates `gh` is installed and authenticated
  - composes qualifiers correctly (escaping, defaults, dedup)
  - applies smart filters (drop forks/archived, sort, score)
  - renders results in table / json / markdown

All scripts accept --format {table,json,markdown}. Default is markdown.
Pass --format json explicitly for machine-readable output (there is NO
auto-switch to JSON when stdout is piped).
"""
