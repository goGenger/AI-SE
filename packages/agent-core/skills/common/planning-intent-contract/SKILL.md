---
id: planning-intent-contract
name: Planning intent contract (AI-SE)
description: Framework-agnostic planning contract. Honor the current capability profile, attach UI baselines, and break work into independently verifiable slices. Injected into ANALYSIS/DESIGN professional tasks and into the requirement/slice/UI-spec/task planning graph.
binds:
  taskTypes: [ANALYSIS, DESIGN]
  failureClasses: []
  capabilityProfiles: []
source: docs/267
---

# planning-intent-contract

Planning contract for analysis, design, and the requirement/slice/task planning graph. Official end-of-slice gates are scheduled here; they are not run on every intermediate task.

## 1. Honor the current capability profile

Plan only work that the current `capabilityProfile` enables — the agents and task types that profile actually allows. If the profile does not enable backend or database work, do not create those slices or tasks, and do not invent out-of-profile backend work to "complete" a product the profile does not cover.

## 2. New requirements need key-page and key-state baselines

UI-facing requirements must attach visual baselines for key pages and key states (for example dialogs, date panels, dropdowns, and empty states). Missing baselines cannot be silently skipped. Call the gap out in the plan rather than planning as if the baselines already exist.

## 3. Small, dependency-aware, independently verifiable slices

Break work into small slices and tasks with explicit dependencies. Each slice or task must be independently verifiable and must name a check (an acceptance criterion or a gate) that would prove it is done. A task without a check is not a complete plan item.

## 4. Official gates belong at slice end

Official E2E and official visual review belong at slice end or in CI. Do not attach those official full-suite gates to every intermediate implementation task.
