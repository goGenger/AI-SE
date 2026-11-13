---
id: vue-visual-contract
name: Vue visual contract mapping (AI-SE)
description: Maps visual-intent-contract onto the frontend-vue stack (wrappers, tokens, import rules).
binds:
  taskTypes: [FRONTEND, DEBUG]
  failureClasses: []
  capabilityProfiles: [frontend-vue]
source: docs/265
---

# vue-visual-contract

Maps the injected `visual-intent-contract` onto `frontend-vue`. This is the stack mapping only — do not treat it as a second copy of the generic contract.

## Encapsulation directory

- Put wrappers in the project's shared component directory: `src/components`, `src/components/ui`, or `apps/web/src/components` (follow the repo if it already has one).
- Wrapper modules belong in that encapsulation layer, not in business route modules (`src/views`, `src/pages`, `views/`, `pages/`, or equivalent).

## Business pages must not import element-plus directly

- In business views/pages (route-level modules such as `src/views`, `src/pages`, `views/`, `pages/`), do **not** `import { … } from 'element-plus'` and do not default-import that library.
- Allowed exceptions: the encapsulation layer itself, and test fixtures under `tests/` (or the project's equivalent fixture directory).
- Dialog, Form, Input, Select, DatePicker, Pagination, Message/feedback, and similar controls used on business pages must go through project wrappers. If a wrapper is missing, add it in the encapsulation layer first; do not drop the library default onto a business page.

## How to reference tokens

- Colors, typography, spacing, and radii come from the project's design tokens — for example `src/tokens.css`, `apps/web/src/tokens.css`, or the project's Tailwind / CSS custom-property map.
- Reference tokens with `var(--…)` or the project's token utilities. Do not hard-code token values, and do not leave key controls on the component-library default theme.

## Baselines

- When the task includes a visual baseline for a key page or key state, implement to that baseline's design intent (see the generic contract). Official visual-gate passage is decided by the platform, not by a self-report.
