---
id: test-quality-contract
name: Test quality contract (AI-SE)
description: Framework-agnostic test quality contract. Tests must prove behavior; scope them to the slice; do not weaken acceptance intent to go green.
binds:
  taskTypes: [TEST]
  failureClasses: []
  capabilityProfiles: []
source: docs/267
---

# test-quality-contract

Test quality contract. A green result is valid only when the test could have failed for the missing or wrong behavior. Stack-specific fixture assembly belongs in the capability pack, not in this contract.

## 1. Tests must prove behavior

A test that could never fail, asserts the wrong thing, contradicts another test, or only checks already-existing behavior, copy, or README counts is not a valid pass.

## 2. Fail for the right reason, and do not tamper with intent

A new or changed test should fail because the behavior is missing or wrong, not because of typo, fixture, or setup errors. Do not weaken acceptance criteria or rewrite product copy just to go green. Assertion intent is protected.

## 3. Scope tests to the task or slice

Run tests within the task or slice scope (acceptance-criterion key and file glob). Do not fall back to a full project test command mid-slice. Official E2E stays at slice end or in CI.

## 4. Leave the browser runtime to the platform

Playwright version and browser installation are a platform contract. Do not upgrade Playwright or install browsers in the sandbox.
