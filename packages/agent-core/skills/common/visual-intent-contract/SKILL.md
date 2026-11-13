---
id: visual-intent-contract
name: Visual intent contract (AI-SE)
description: Framework-agnostic visual and component contract for UI implementation and repair. Design intent, not pixel-perfect reproduction.
binds:
  taskTypes: [FRONTEND, DEBUG]
  failureClasses: []
  capabilityProfiles: []
source: docs/265
---

# visual-intent-contract

Cross-stack visual and component contract for UI implementation and repair. Official review judges design intent, not pixel-perfect reproduction.

## 1. Use the project encapsulation layer

Business UI must go through the project's encapsulation layer. Do not place component-library default appearance directly on business screens.

## 2. Design tokens only

Colors, typography, spacing, and corner radii must reference the project's design tokens. Do not hard-code these values on business screens, and do not treat the component library's default theme as the visual system.

## 3. Match design intent against visual baselines

When implementing a key page or key state, compare against the visual baselines already attached to the requirement. The bar is design intent: information hierarchy, layout skeleton, typography and color system, and primary control appearance. Slight spacing or color deviations are not failures. Pixel-level reproduction is not required, and a pixel diff is not a pass condition.

## 4. Official visual gate is the source of truth

Visual acceptance passes only when the official visual gate passes. A self-reported "looks correct" or "implemented per the baseline" is not sufficient.
