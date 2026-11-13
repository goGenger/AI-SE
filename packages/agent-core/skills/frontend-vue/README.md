# frontend-vue agent skills (AI-SE)

Injectable skill packs for capability profile `frontend-vue`.

Platform resolves and injects these by **declaration** (`taskType` / `failureClass` / `capabilityProfile`).
Agents do **not** self-select skills at runtime.

The framework-agnostic planning, test-quality, and review contracts (`planning-intent-contract`, `test-quality-contract`, `review-evidence-contract` in `skills/common`) bind by task type (ANALYSIS/DESIGN, TEST, REVIEW). See `docs/267-planning-test-review-contracts.md`.

The framework-agnostic visual contract (`visual-intent-contract` in `skills/common`) is injected alongside
`vue-visual-contract` on UI implement/repair tasks. See `docs/265-visual-intent-gate.md`.

| id | binds (summary) | purpose |
| --- | --- | --- |
| `vue-visual-contract` | FRONTEND / DEBUG + frontend-vue (not TEST, not SPEC_CONFLICT) | Maps visual-intent-contract onto Vue wrappers, tokens, and element-plus import rules |
| `vue-implement` | FRONTEND + frontend-vue | Product SFC / Pinia / Router implementation |
| `vue-test-fixture` | FRONTEND, TEST; also SPEC_CONFLICT | Assembly fixtures + Vitest/VTU; never weaken AC. TEST also receives common `test-quality-contract` |
| `vue-debug-repair` | DEBUG; TEST_FIXTURE_GAP | Gate-failure repair; fix root cause, keep assertions |

Source credit: adapted from [vuejs-ai/skills](https://github.com/vuejs-ai/skills) (MIT).
Rewritten for AI-SE autonomy gates (~80% delivery, anti-tamper, AC-scoped vitest).
`vue-visual-contract` is platform-authored (docs/265), not from that source.
