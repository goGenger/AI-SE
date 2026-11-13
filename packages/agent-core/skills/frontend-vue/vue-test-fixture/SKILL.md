---
id: vue-test-fixture
name: Vue test fixture (AI-SE)
description: Write/fix Vue assembly and component tests without weakening AC assertions.
binds:
  taskTypes: [FRONTEND, TEST]
  failureClasses: [TEST_FIXTURE_GAP, SPEC_CONFLICT]
  capabilityProfiles: [frontend-vue]
source: vuejs-ai/skills (adapted, MIT)
---

# vue-test-fixture

## When this applies

- Writing or repairing Vitest + Vue Test Utils tests.
- Failure class `TEST_FIXTURE_GAP` (e.g. `getActivePinia`, `injection Symbol(pinia) not found`, missing router).
- Failure class `SPEC_CONFLICT`: fix tests to match the slice AC — **do not** dilute assertions to go green.

## Always mount with active Pinia / Router

If the SUT uses a store or router, the test **must** install them.

```ts
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

const pinia = createPinia()
const router = createRouter({
  history: createMemoryHistory(),
  routes: [/* minimal routes the SUT needs */],
})
await router.push('/')
await router.isReady()

const wrapper = mount(Sut, {
  global: { plugins: [pinia, router] },
})
await flushPromises()
```

```ts
// store unit test
beforeEach(() => {
  setActivePinia(createPinia())
})
```

**Incorrect:** `mount(Sut)` with no Pinia when `useXxxStore()` runs in setup.

## VTU async

- `await` `setValue` / `trigger`.
- Use `flushPromises()` (and `nextTick` when DOM must settle) after async setup/actions.
- Prefer asserting observable DOM / emitted events (black-box); avoid peeking private internals.

## AC contract

- Name every test with the AC marker the task lists, e.g. `test('[AC-01] …', …)`.
- Prefer command-scoped vitest by AC key/glob; **no full-suite fallback** when AC keys exist.
- Snapshots alone are not AC evidence.

## Anti-tamper (hard)

- Fix **harness** for `TEST_FIXTURE_GAP` — not the `expect()`.
- Never weaken, relax, delete, or invert an existing AC assertion.
- `SPEC_CONFLICT` → align test with current slice AC via the TEST repair path; do not greenwash.
