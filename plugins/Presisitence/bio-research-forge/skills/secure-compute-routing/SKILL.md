---
name: secure-compute-routing
description: Decide whether a life-science computation should run locally, on a controlled HPC over SSH, or on an external cloud GPU based on data sensitivity, scale, cost, and reproducibility. Use before moving data or launching remote work.
---

# Secure Compute Routing

## Classify first

Label every input as `public`, `controlled/private`, or `credentialed`. Record approximate size, required software, compute/memory/GPU need, expected runtime, and output size.

## Default routing

- Public data: local, controlled HPC, or an approved cloud service may be considered.
- Controlled/private data: local or user-controlled HPC over SSH by default.
- Credentials: never embed in scripts, prompts, logs, archives, or repository files.
- External cloud GPU: do not upload or launch until the user has approved the provider, estimated cost, exact transferred files, retention policy, and deletion/return plan.

Do not treat a user's request to analyze data as permission to send it to an external service.

## Execution contract

Before launch, produce:

1. runtime target and reason;
2. data-transfer manifest and excluded files;
3. environment/container specification;
4. command, resources, wall time, retry limit, and stopping condition;
5. log, heartbeat, checkpoint, and failure handling;
6. output validation and checksum plan;
7. return/synchronization plan that does not overwrite source data.

Use SSH to execute on a controlled HPC without installing an agent unless the user explicitly requests and approves it. Keep large intermediate data near the compute environment; transfer only required inputs and final artifacts.

## Completion

Report actual host class, job ID when available, environment, exit status, validated outputs, costs if external, and failed checks. A submitted job is not a completed analysis.
