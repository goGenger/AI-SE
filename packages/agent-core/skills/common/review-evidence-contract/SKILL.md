---
id: review-evidence-contract
name: Review evidence contract (AI-SE)
description: Framework-agnostic review contract. Official E2E and the official visual gate are the source of truth, not self-reported success.
binds:
  taskTypes: [REVIEW]
  failureClasses: []
  capabilityProfiles: []
source: docs/267
---

# review-evidence-contract

Review contract. Official gates, not the agent's self-report, decide whether work passed.

## 1. Official gates are the source of truth

Official E2E and the official visual gate are the source of truth. A self-reported "tests passed" or "looks correct" is not sufficient to pass review.

## 2. Missing evidence or a broken visual contract is a fail

Missing visual baseline, default component-library skin used directly on a business page, or a required key state that cannot be opened, is a fail. If official evidence is missing, say so and fail or block — do not pass.

## 3. Design intent, not pixel-perfect diffs

Slight spacing, color, or alignment drift is not a red light. Overall style far from the baseline, or clearly wrong details, is. Review judges design intent, not pixel-perfect reproduction.

## 4. No rationalizations for skipping evidence

Do not pass by arguing that "it looked fine", "the change was small", or "tests were not my job". Absence of official evidence is a finding, not a reason to skip the gate.

## 5. Structure findings

Report findings with a severity and the official evidence that is missing or red. This is a pre-merge quality checklist tied to AI-SE official gates, not a git pull-request ritual.
