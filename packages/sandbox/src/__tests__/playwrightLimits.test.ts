import { describe, expect, it } from "vitest";
import {
  capPlaywrightWorkers,
  e2eSandboxCommandLimits,
  isPlaywrightTestCommand,
  SANDBOX_PLAYWRIGHT_MAX_WORKERS
} from "../playwrightLimits";

describe("capPlaywrightWorkers (docs/256)", () => {
  it("appends -- --workers=2 to npm run test:e2e", () => {
    expect(capPlaywrightWorkers("npm run test:e2e")).toBe(
      `npm run test:e2e -- --workers=${SANDBOX_PLAYWRIGHT_MAX_WORKERS}`
    );
  });

  it("appends --workers=2 to npx playwright test", () => {
    expect(capPlaywrightWorkers("npx playwright test")).toBe("npx playwright test --workers=2");
  });

  it("does not raise an existing --workers=1", () => {
    expect(capPlaywrightWorkers("npx playwright test --workers=1")).toBe(
      "npx playwright test --workers=1"
    );
  });

  it("caps --workers=8 and --workers 5 down to 2", () => {
    expect(capPlaywrightWorkers("npx playwright test --workers=8")).toBe(
      "npx playwright test --workers=2"
    );
    expect(capPlaywrightWorkers("npm run test:e2e -- --workers 5")).toBe(
      "npm run test:e2e -- --workers=2"
    );
  });

  it("leaves install and vitest commands alone", () => {
    expect(isPlaywrightTestCommand("npx playwright install chromium")).toBe(false);
    expect(capPlaywrightWorkers("npx playwright install chromium")).toBe(
      "npx playwright install chromium"
    );
    expect(capPlaywrightWorkers("npm run test -- --reporter=verbose")).toBe(
      "npm run test -- --reporter=verbose"
    );
    expect(e2eSandboxCommandLimits("npm run test")).toEqual({});
  });

  it("gives E2E commands 2g memory and 1g tmpfs", () => {
    expect(e2eSandboxCommandLimits("npm run test:e2e")).toEqual({
      memory: "2g",
      tmpfsSize: "1g"
    });
  });
});
