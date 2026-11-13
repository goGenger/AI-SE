# frontend-task-test-project (fixture)

Minimal Vue-free frontend workspace used by the **Phase 5.6-2 Repair** E2E:
`UI Specification → Frontend Task → Frontend Agent → real code → build/run`.

Layout (mirrors the stock `frontend-agent` permission sandbox `apps/web`):

```text
apps/web/
  package.json         # build = node scripts/build.mjs ; test = node --test tests/*.test.mjs
  scripts/build.mjs    # renders every page module, fails on empty/invalid output
  src/components/      # shared components the agent must REUSE (Button, Input)
  src/tokens.css       # design tokens (CSS custom properties)
  src/pages/           # page modules, one `render*()` export each
  src/assets/          # static assets (logo.svg)
  tests/page.test.mjs  # acceptance test for the "Fixture Page" visual task
```

The E2E feeds a real visual task for a page named `Fixture Page`; the agent
must create `src/pages/fixture-page.js` that satisfies `tests/page.test.mjs`
(reuse `Button`, use `var(--…)` tokens, encode `data-section-id` / `data-rect`,
reference `../assets/logo.svg`) without touching `src/pages/index.js`,
components, tokens or tests.
