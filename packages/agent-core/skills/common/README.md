# Common agent skills (AI-SE)

Framework-agnostic skills. Platform injects them by declaration (`taskType` / `failureClass` / `capabilityProfile`). Agents do **not** self-select skills at runtime.

These files must not name a specific UI framework or component library. Stack-specific mapping lives under the matching capability pack (for example `skills/frontend-vue`).

| id | binds (summary) | purpose |
| --- | --- | --- |
| `visual-intent-contract` | FRONTEND; DEBUG on a frontend-* profile; not TEST / BACKEND / docs; not SPEC_CONFLICT | Encapsulation, design tokens, design-intent baselines, official visual gate |
| `planning-intent-contract` | ANALYSIS, DESIGN (any profile); also the requirement/slice/UI-spec/task planning graph; not BACKEND / DATABASE | Honor the current capability profile, require key-page/key-state baselines, plan small verifiable slices; official E2E / visual review at slice end |
| `test-quality-contract` | TEST (any profile); not DEBUG / SPEC_CONFLICT beyond the existing Vue fixture bind | Tests must prove behavior; no vacuous or contradictory passes; no weakening AC or rewriting copy to go green; scope to the slice; Playwright pin stays a platform contract |
| `review-evidence-contract` | REVIEW (any profile) | Official E2E and official visual gate are the source of truth; missing baseline / default skin / unopenable key state fails; structured findings; no rationalizations for skipping evidence |
