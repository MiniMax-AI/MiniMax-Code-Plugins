# Review contract

## Required inputs

- artifact or exact file set under review;
- intended claim and audience;
- acceptance criteria or target journal requirements;
- available source data, code, environment, and citation library;
- declared scope exclusions.

## Evidence matrix

| ID | Claim/artifact | Required evidence | Observed evidence | Status | Required action |
|---|---|---|---|---|---|

Status is `verified`, `partially verified`, `unsupported`, `contradicted`, or `not assessable`.

## Figure-code-data check

For each figure, verify: final filename and hash; generation script; input table; filters and transformations; panel labels; group labels and units; n and error definition; statistical annotation; legend; manuscript values. Regenerate when feasible and compare output.

## Citation check

Verify DOI/title/authors/year, open the source, identify the passage/result that supports the claim, and note whether the support is direct or inferential. A related paper that does not support the clause fails.

## Report

1. outcome and scope;
2. blocking findings first, each with file/line/figure evidence;
3. claim and number traceability gaps;
4. reproducibility and privacy results;
5. residual risk;
6. verdict and exact revisions required for re-review.
