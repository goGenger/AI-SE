---
id: vue-debug-repair
name: Vue debug repair (AI-SE)
description: DEBUG/FRONTEND repair after gate failure — fix root cause, keep AC assertions.
binds:
  taskTypes: [DEBUG, FRONTEND]
  failureClasses: [TEST_FIXTURE_GAP]
  capabilityProfiles: [frontend-vue]
source: vuejs-ai/skills (adapted, MIT)
---

# vue-debug-repair

## Method

1. Read failure evidence (summary, issues, verification, stack): classify before editing.
2. Fix the **root cause** in `src/` **or** assembly fixture — whichever the evidence names.
3. Re-run **scoped** gates (AC key / glob). Do not expand to full suite when AC present.
4. Keep changes minimal and inside the current slice.

## Map failure → action

| Signal | Action |
| --- | --- |
| `getActivePinia` / pinia injection missing | Install `createPinia()` / `setActivePinia` in mount harness (`TEST_FIXTURE_GAP`) |
| Router / `useRoute` errors in tests | Provide memory router plugin in mount |
| Product logic / wrong DOM | Fix SFC or store; keep expects |
| Assertion contradicts AC | `SPEC_CONFLICT` → TEST repair; do not edit expect to match buggy code |
| Timeout / infra | Do not invent product changes; report honestly |
| README / docs assertions (`readme.ac*`, 项目介绍, `docs/delivery-report`) | **DOCS_GAP → BUILD** — not FRONTEND; do not burn retries on product code |
| Playwright missing or off-pin (`chromium-1254`, `browserType.launch`, Executable doesn't exist, `PLAYWRIGHT_CONTRACT_MISMATCH`) | **ENV_GAP, contract mismatch** — realign to Playwright 1.64.1 / Chromium 1248 or fail closed; do not run `playwright install` and do not open a BUILD install loop; not FRONTEND |

## Reactivity / router gotchas (light)

- Missing `.value` on refs in script.
- Destructuring store state without `storeToRefs`.
- Relying on `onMounted` alone for route-param loads — `watch(() => route.params.id, …, { immediate: true })`.
- Stale async watchers: cancel/ignore outdated responses.

## Anti-tamper (hard)

- **Do not** delete, skip, or weaken the failing AC test to clear the gate.
- Fixture edits are allowed; assertion intent is not.
- If blocked by write policy on a named deliverable, say so in the result — do not silently relocate.
