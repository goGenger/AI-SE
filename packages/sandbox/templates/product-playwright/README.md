# Product Playwright pin (docs/264)

New product projects must copy `package.fragment.json` verbatim:

- `@playwright/test` and `playwright` are exact `1.64.1` (no `^`)
- Official E2E is `npm run test:e2e` (or the package runner equivalent)
- The sandbox image `ai-se-sandbox:22-pnpm9` already has Chromium 1248 at `/opt/ms-playwright`
- Never run `playwright install` in the sandbox and never bump this package as an ordinary upgrade
