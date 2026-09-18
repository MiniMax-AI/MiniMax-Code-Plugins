---
name: quantitative-research
description: Design or review statistical, mixed-model, Bayesian, or machine-learning analyses for life-science data. Use when the main risk is estimand, dependence, model choice, diagnostics, leakage, or uncertainty.
---

# Quantitative Research

## First specify

State the response scale, experimental unit, estimand, sampling/dependence structure, planned contrast, missingness, and whether the goal is explanation, estimation, prediction, or discovery.

## Model contract

Before fitting, record candidate model(s), formula, distribution/link, random or correlation structure, assumptions, diagnostics, comparison rule, and fallback. Match the effective sample size to the treatment unit, not the number of rows.

## Required reporting

Report estimates, effect sizes, intervals, sample counts, model diagnostics, multiplicity handling, sensitivity analysis, and limitations. A p value or accuracy score alone is incomplete.

For predictive work, keep preprocessing inside resampling folds, split by subject/site/time when required, keep the test set untouched, compare with a simple baseline, report calibration and uncertainty, and label feature importance as association rather than mechanism.

For Bayesian work, document priors, prior predictive checks, convergence, effective sample size, divergences, posterior predictive checks, and prior sensitivity.

Never change endpoints, exclusions, transformations, or models repeatedly to obtain significance. Exploratory analysis must remain labeled exploratory.
