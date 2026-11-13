---
id: vue-implement
name: Vue implement (AI-SE)
description: FRONTEND implement/repair for Vue 3 + Composition API + Pinia + Router under AI-SE gates.
binds:
  taskTypes: [FRONTEND]
  failureClasses: []
  capabilityProfiles: [frontend-vue]
source: vuejs-ai/skills (adapted, MIT)
---

# vue-implement

Hard constraints for AI-SE FRONTEND tasks on `frontend-vue`.

## Delivery bar (~80%)

- Deliver a **runnable skeleton**: main user flows, basic layout/styles, typed SFCs.
- Progressive input is OK; UI mock may be incomplete — do not block on pixel polish.
- Prefer scoped Vitest by AC key/glob when verifying; never fall back to full suite when AC keys are present.

## Playwright contract (docs/264)

Platform owns Playwright and the baked Chromium revision. New Vue projects and official E2E must pin:

```json
{
  "devDependencies": {
    "@playwright/test": "1.64.1",
    "playwright": "1.64.1"
  },
  "scripts": {
    "test:e2e": "playwright test"
  }
}
```

Use an exact version, never `^`. Do not bump Playwright as an ordinary dependency upgrade. Do not run `playwright install` or `test:e2e:install` in the sandbox (no network; Chromium 1248 is already in `ai-se-sandbox:22-pnpm9`). If the product is off-pin, realign to 1.64.1 or report `ENV_GAP` as a contract mismatch.

## Stack defaults

- Vue 3 + `<script setup lang="ts">` + Composition API only (no Options API / JSX).
- SFC order: `<script>` → `<template>` → `<style scoped>`.
- Props down / events up; typed `defineProps` / `defineEmits`.
- Keep source state minimal (`ref`/`reactive`); derive with `computed`; use `watch` only for side effects.
- Do not mix `v-if` with `v-for` on the same element; give `v-for` a stable `:key`.
- Install order in `main`: `createPinia()` **before** router (guards may use stores). Never call `useXxxStore()` at module top level.

## Pinia

- Prefer setup stores; **return all state** you keep in refs (no hidden private refs).
- Destructure state/getters with `storeToRefs(store)`; destructure actions directly.

```ts
// correct
const store = useTodoStore()
const { items } = storeToRefs(store)
const { add } = store

// incorrect — breaks reactivity
const { items } = useTodoStore()
```

## Vue Router

- Register router via `app.use(router)` after Pinia.
- Same component + different params does **not** re-run `onMounted` — watch params:

```ts
watch(() => route.params.id, load, { immediate: true })
```

## Autonomy / anti-tamper

- You may edit assembly fixtures under `tests/` (createPinia / router mounts) when evidence shows fixture gaps.
- **Never** weaken, relax, delete, or greenwash AC assertions.
- If an assertion contradicts the AC → report `SPEC_CONFLICT` (TEST repair path); do not silently change expected values.
