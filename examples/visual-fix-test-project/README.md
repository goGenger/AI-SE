# visual-fix-test-project (fixture)

Frontend workspace used by the **Phase 5.6-5 Repair** E2E: the real Auto Fix
loop `Visual Issue → Fix Task → Frontend Agent → ToolRuntime/Sandbox → Code →
Build/Test → Browser → Candidate Screenshot → Visual Evaluation (reference
screenshot vs candidate screenshot)`.

```text
apps/web/
  package.json                 # build / test / serve
  scripts/build.mjs            # renders the page module (sanity check)
  scripts/serve.mjs            # dev server: / = live page module · /reference.html = design body
  src/pages/fixture-page.js    # the page module the agent fixes (starts incomplete)
  reference/design.body.html   # design reference body (the visual target)
  tests/page.test.mjs          # non-empty render sanity (Visual Evaluation is the quality gate)
```

Rendering convention: the page draws each section as a full-width **colored
band** (width:100% of the viewport, fixed height), using the fixture section
palette:

| band color | section |
|---|---|
| `#112233` | Header |
| `#445566` | Body |
| `#778899` | Footer |

The dev server wraps both the live page and the reference in the SAME document
shell (margin reset included): a page module that renders the reference body
byte-for-byte produces a document identical to `/reference.html` — identical
pixels and identical detected bands — which is what turns a fix into a
`RESOLVED` evaluation (structural diff clean + pixel diff 0).
