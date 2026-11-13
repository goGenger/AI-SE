import { describe, expect, it } from "vitest";
import {
  ComponentMapEntrySchema,
  DESIGN_TOKEN_NAMESPACES,
  DesignTokensSchema,
  VisualInputRecordSchema,
  VisualSpecificationSchema,
  VisualStateNameSchema,
  deterministicVisualId,
  isTokenRef,
  validateVisualInput
} from "./index";

/**
 * Phase 5.6-0 contract tests: input URI contract, VisualInputRecord validation,
 * UI spec four-layer structure with deterministic ids, design token reference
 * rule, component map gap semantics. NO parsing / collection / browser code
 * exists at this phase — these tests lock the shapes only.
 */

describe("Phase 5.6-0 visual input contract", () => {
  it("accepts the four input types with matching URI prefixes", () => {
    for (const inputType of ["screenshot", "figma", "url", "code"] as const) {
      // `url://` needs an allowlist entry that resolves to the same host:port
      // (the type test for deny behavior lives in its own case below).
      const source =
        inputType === "url" ? "url://localhost:4173/app" : `${inputType}://samples/${inputType}-1`;
      const allowlist = inputType === "url" ? ["http://localhost:4173"] : [];
      const result = validateVisualInput(
        {
          inputType,
          source,
          viewport: { width: 1440, height: 900 }
        },
        allowlist
      );
      expect(result.ok, `${inputType}: ${result.ok ? "" : result.reason}`).toBe(true);
      if (result.ok) expect(result.record.inputType).toBe(inputType);
    }
  });

  it("rejects a URI whose prefix does not match inputType", () => {
    const result = validateVisualInput({
      inputType: "screenshot",
      source: "url://localhost:4173/app",
      viewport: { width: 1440, height: 900 }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('must be "screenshot://"');
  });

  it("rejects url:// inputs that are not on the allowlist (default deny)", () => {
    // Empty allowlist denies every url:// input.
    const denied = validateVisualInput(
      {
        inputType: "url",
        source: "url://localhost:4173/app",
        viewport: { width: 1440, height: 900 }
      },
      []
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain("allowlist");

    // A non-allowlisted host is denied even with a non-empty allowlist.
    const otherHost = validateVisualInput(
      {
        inputType: "url",
        source: "url://evil.example.test/app",
        viewport: { width: 1440, height: 900 }
      },
      ["http://localhost:4173"]
    );
    expect(otherHost.ok).toBe(false);
  });

  it("accepts url:// inputs on the allowlist, including localhost family", () => {
    const exact = validateVisualInput(
      {
        inputType: "url",
        source: "url://localhost:4173/app",
        viewport: { width: 1440, height: 900 }
      },
      ["http://localhost:4173"]
    );
    expect(exact.ok).toBe(true);

    // Explicit allowlist entry for the loopback family.
    const loopback = validateVisualInput(
      {
        inputType: "url",
        source: "url://127.0.0.1:4173/app",
        viewport: { width: 1440, height: 900 }
      },
      ["http://127.0.0.1:4173"]
    );
    expect(loopback.ok).toBe(true);
  });

  it("rejects invalid viewports and malformed records", () => {
    expect(
      validateVisualInput({
        inputType: "screenshot",
        source: "screenshot://shots/a.png",
        viewport: { width: 0, height: 900 }
      }).ok
    ).toBe(false);
    expect(
      validateVisualInput({
        inputType: "screenshot",
        source: "screenshot://shots/a.png",
        viewport: { width: 1440.5, height: 900 }
      }).ok
    ).toBe(false);
    expect(
      validateVisualInput({
        inputType: "screenshot",
        source: "",
        viewport: { width: 1440, height: 900 }
      }).ok
    ).toBe(false);
  });

  it("keeps the record credential-free by schema (unknown fields rejected)", () => {
    const result = VisualInputRecordSchema.safeParse({
      inputType: "screenshot",
      source: "screenshot://shots/a.png",
      viewport: { width: 1440, height: 900 },
      accessToken: "sk-live1234567890abcdef"
    });
    expect(result.success).toBe(false);
  });
});

describe("Phase 5.6-0 UI specification contract", () => {
  function specFixture() {
    return {
      input: {
        inputType: "screenshot" as const,
        source: "screenshot://shots/dashboard.png",
        viewport: { width: 1440, height: 900 }
      },
      page: {
        id: "page:dashboard:1",
        name: "Dashboard",
        viewport: { width: 1440, height: 900 },
        sections: [
          {
            id: "section:header:1",
            title: "Header",
            geometry: { rect: { x: 0, y: 0, width: 1440, height: 64 } },
            elements: [
              {
                id: "element:logo:1",
                role: "image" as const,
                description: "Product logo"
              },
              {
                id: "element:search:1",
                role: "input" as const,
                description: "Global search",
                states: [{ state: "focus" as const }]
              }
            ]
          }
        ]
      },
      generatedAt: "2026-09-11T10:00:00.000Z"
    };
  }

  it("accepts a well-formed four-layer specification", () => {
    const result = VisualSpecificationSchema.safeParse(specFixture());
    expect(result.success).toBe(true);
    if (result.success) {
      // Section geometry is required and normalized.
      expect(result.data.page.sections[0].geometry.rect).toEqual({
        x: 0,
        y: 0,
        width: 1440,
        height: 64
      });
    }
  });

  it("allows the seven named UI states", () => {
    expect([...VisualStateNameSchema.options].sort()).toEqual(
      ["default", "disabled", "empty", "error", "focus", "hover", "loading"].sort()
    );
  });

  it("requires section geometry", () => {
    const fixture = specFixture();
    const invalid = {
      ...fixture,
      page: {
        ...fixture.page,
        sections: [{ ...fixture.page.sections[0], geometry: undefined }]
      }
    };
    // Extra-property / missing-required both surface through safeParse.
    expect(VisualSpecificationSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects unknown fields anywhere (strict layers)", () => {
    const fixture = specFixture();
    const invalid = {
      ...fixture,
      page: {
        ...fixture.page,
        sections: [
          {
            ...fixture.page.sections[0],
            credentialRef: "vault://x"
          }
        ]
      }
    };
    expect(VisualSpecificationSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("Phase 5.6-0 deterministic ids", () => {
  it("produces identical ids for identical inputs regardless of call order", () => {
    const a = deterministicVisualId("section", "Order Summary", 2);
    const b = deterministicVisualId("section", "Order Summary", 2);
    expect(a).toBe(b);
    expect(a).toBe("section:order-summary:2");

    // Distinct inputs → distinct ids; index disambiguates duplicates.
    expect(deterministicVisualId("element", "button", 1)).not.toBe(
      deterministicVisualId("element", "button", 2)
    );
    expect(deterministicVisualId("section", "Header", 1)).not.toBe(
      deterministicVisualId("element", "Header", 1)
    );
  });

  it("falls back to a stable placeholder for empty slugs", () => {
    expect(deterministicVisualId("page", "###", 1)).toBe("page:unnamed:1");
  });
});

describe("Phase 5.6-0 design tokens contract", () => {
  it("accepts all six namespaces and rejects unknown ones", () => {
    expect([...DESIGN_TOKEN_NAMESPACES].sort()).toEqual(
      ["colors", "motion", "radii", "shadows", "spacing", "typography"].sort()
    );

    const tokens: Record<string, Record<string, string | number>> = {
      colors: { primary: "#1533ff", "text-primary": "@ref:colors.primary" },
      typography: { body: "14px/20px Inter" },
      spacing: { md: "16px" },
      radii: { card: "12px" },
      shadows: { elevated: "0 8px 24px rgba(0,0,0,0.2)" },
      motion: { fast: "120ms ease-out" }
    };
    expect(DesignTokensSchema.safeParse(tokens).success).toBe(true);

    expect(DesignTokensSchema.safeParse({ ...tokens, fonts: { body: "Inter" } }).success).toBe(
      false
    );
  });

  it("recognizes @ref token references (references preferred over inlining)", () => {
    expect(isTokenRef("@ref:colors.primary")).toBe(true);
    expect(isTokenRef("#1533ff")).toBe(false);
    expect(isTokenRef(16)).toBe(false);
  });
});

describe("Phase 5.6-0 component map contract", () => {
  it("keeps matched:false gaps as valid, first-class data", () => {
    const gap = ComponentMapEntrySchema.safeParse({
      id: "element:chart:1",
      matched: false,
      unmatchedReason: "No chart component in the current library"
    });
    expect(gap.success).toBe(true);
    if (gap.success) expect(gap.data.componentName).toBeUndefined();

    const matched = ComponentMapEntrySchema.safeParse({
      id: "element:button:1",
      componentName: "AppButton",
      matched: true,
      confidence: 0.92
    });
    expect(matched.success).toBe(true);
  });

  it("requires unmatchedReason on gaps", () => {
    expect(
      ComponentMapEntrySchema.safeParse({
        id: "element:chart:1",
        matched: false
      }).success
    ).toBe(false);
  });
});
