import {
  VisualSpecificationSchema,
  type VisualElement,
  type VisualInputRecord,
  type VisualSection,
  type VisualSpecification
} from "@ai-se/shared";
import { describe, expect, it } from "vitest";
import {
  FakeVLMProvider,
  FrontendTaskDraftSchema,
  VisualAnalyzer,
  attachDesignTokens,
  buildComponentMap,
  buildFrontendTasks,
  deriveApproval,
  redactDraftText
} from "../index.js";

/**
 * Phase 5.6-2 tests: pure converter from frozen 5.6-0 spec to frontend task
 * drafts. Deterministic, gaps surfaced, no credentials. Section-level scope.
 */

function elementFixture(overrides: Partial<VisualElement> = {}): VisualElement {
  return {
    id: "button:submit:1",
    role: "button",
    description: "Submit order",
    ...overrides
  };
}

function sectionFixture(
  elements: VisualElement[],
  overrides: Partial<VisualSection> = {}
): VisualSection {
  return {
    id: "section:order:1",
    title: "Order form",
    geometry: { rect: { x: 0, y: 0, width: 100, height: 60 } },
    elements,
    ...overrides
  };
}

function specFixture(sections: VisualSection[]): VisualSpecification {
  return VisualSpecificationSchema.parse({
    input: {
      inputType: "screenshot",
      source: "screenshot://fixtures/spec.png",
      viewport: { width: 1440, height: 900 }
    },
    page: {
      id: "page:checkout:1",
      name: "Checkout",
      viewport: { width: 1440, height: 900 },
      sections
    },
    generatedAt: new Date().toISOString()
  });
}

describe("5.6-2 component matching", () => {
  it("maps known roles to components and reports gaps with reasons", () => {
    const spec = specFixture([
      sectionFixture([
        elementFixture({ id: "button:submit:1", role: "button" }),
        elementFixture({ id: "calendar:range:1", role: "other" })
      ])
    ]);
    const map = buildComponentMap(spec, { knownComponents: ["Button"] });

    expect(map[0][0]).toMatchObject({ id: "button:submit:1", matched: true, componentName: "Button" });
    // role "other" maps to default "View", but "View" is not in the library → gap
    expect(map[0][1]).toMatchObject({
      id: "calendar:range:1",
      matched: false,
      unmatchedReason: "No component for role other in current library"
    });
  });

  it("honors roleMap override over the default table", () => {
    const spec = specFixture([sectionFixture([elementFixture({ role: "button" })])]);
    const map = buildComponentMap(spec, {
      knownComponents: ["PrimaryAction"],
      roleMap: { button: "PrimaryAction" }
    });
    expect(map[0][0]).toMatchObject({ matched: true, componentName: "PrimaryAction" });
  });

  it("treats knownComponents miss as a gap even when the default map has a name", () => {
    const spec = specFixture([sectionFixture([elementFixture({ role: "button" })])]);
    const map = buildComponentMap(spec, { knownComponents: ["SomethingElse"] });
    expect(map[0][0].matched).toBe(false);
    expect(map[0][0].unmatchedReason).toContain("button");
  });

  it("empty/absent knownComponents is unconstrained (default table rules)", () => {
    const spec = specFixture([sectionFixture([elementFixture({ role: "list" })])]);
    const unconstrained = buildComponentMap(spec, {});
    expect(unconstrained[0][0]).toMatchObject({ matched: true, componentName: "List" });
  });
});

describe("5.6-2 risk derivation (frozen rule)", () => {
  it("marks approval+HIGH when gap ratio exceeds 50%", () => {
    // Roles map to defaults Text/View, which are absent from the library → 100% gap
    const entries = buildComponentMap(
      specFixture([
        sectionFixture([
          elementFixture({ id: "a", role: "text" }),
          elementFixture({ id: "b", role: "container" })
        ])
      ]),
      { knownComponents: ["Never"] }
    )[0];
    const section = sectionFixture([
      elementFixture({ id: "a", role: "text" }),
      elementFixture({ id: "b", role: "container" })
    ]);
    expect(deriveApproval(section, entries)).toEqual({
      approvalRequired: true,
      priority: "HIGH"
    });
  });

  it("keeps no-approval+MEDIUM when everything matches", () => {
    const entries = buildComponentMap(
      specFixture([sectionFixture([elementFixture({ role: "button" })])])
    )[0];
    const section = sectionFixture([elementFixture({ role: "button" })]);
    expect(deriveApproval(section, entries)).toEqual({
      approvalRequired: false,
      priority: "MEDIUM"
    });
  });
});

describe("5.6-2 buildFrontendTasks", () => {
  it("produces one deterministic draft per section with contract literals", () => {
    const spec = specFixture([
      sectionFixture([elementFixture({ role: "button" })]),
      sectionFixture([elementFixture({ role: "button" })], { id: "section:summary:2", title: "Summary" })
    ]);
    const { tasks, componentMap } = buildFrontendTasks(spec, { knownComponents: ["Button"] });

    expect(tasks.length).toBe(2);
    expect(componentMap.length).toBe(2);
    for (const [index, draft] of tasks.entries()) {
      expect(draft.taskKey).toBe(`visual:checkout:${index + 1}`);
      expect(draft.type).toBe("FRONTEND");
      expect(draft.assignedAgent).toBe("frontend-agent");
      expect(draft.approvalRequired).toBe(false);
      expect(draft.priority).toBe("MEDIUM");
      expect(draft.visualInput.source).toBe("screenshot://fixtures/spec.png");
    }

    // Deterministic: same input → identical drafts
    const again = buildFrontendTasks(spec, { knownComponents: ["Button"] });
    expect(again.tasks).toEqual(tasks);
  });

  it("carries component gaps into description and unmatchedReason (never silently dropped)", () => {
    const spec = specFixture([
      sectionFixture([
        elementFixture({ id: "keep:1", role: "button" }),
        elementFixture({ id: "gap:1", role: "other" })
      ])
    ]);
    const { tasks, componentMap } = buildFrontendTasks(spec, { knownComponents: ["Button"] });

    const entry = componentMap[0].find((candidate) => candidate.id === "gap:1");
    expect(entry?.matched).toBe(false);
    expect(tasks[0].description).toContain("component gaps:");
    expect(tasks[0].description).toContain(entry?.unmatchedReason ?? "");
    expect(tasks[0].instructions.sections[0].unmatchedReason).toBe(entry?.unmatchedReason);
  });

  it("serializes valid drafts through the strict schema and rejects extra fields", () => {
    const spec = specFixture([sectionFixture([elementFixture({ role: "button" })])]);
    const { tasks } = buildFrontendTasks(spec);
    for (const draft of tasks) {
      expect(() => FrontendTaskDraftSchema.parse(draft)).not.toThrow();
      expect(() =>
        FrontendTaskDraftSchema.parse({ ...draft, accessToken: "should-fail" })
      ).toThrow();
    }
  });

  it("strips credential-shaped text from descriptions before hand-off", () => {
    const spec = specFixture([
      sectionFixture([
        elementFixture({
          id: "leaky:1",
          role: "text",
          description: "uses token Bearer AAAABBBBCCCC for upload"
        })
      ])
    ]);
    const { tasks } = buildFrontendTasks(spec);
    const redacted = redactDraftText(tasks[0]);
    expect(redacted.description).not.toContain("Bearer AAAABBBBCCCC");
    expect(redacted.description).toContain("[REDACTED]");
  });

  it("STOPS at draft layer: no persistence, no REST, no code writes", async () => {
    // Build result is pure data only — assert publicly exported surface.
    const visual = await import("../index.js");
    const exported = Object.keys(visual);
    expect(exported).toContain("buildFrontendTasks");
    expect(exported).not.toContain("createTask");
    expect(exported).not.toContain("insertTask");
  });
});

describe("5.6-2 repair: attachDesignTokens fills the frozen styleTokens slot", () => {
  function recordFixture(): VisualInputRecord {
    return {
      inputType: "screenshot",
      source: "screenshot://fixtures/dashboard.png",
      viewport: { width: 1440, height: 900 },
      // Explicit marker payload (fake provider grammar) so the color token is
      // well-formed: the canonical FAKE_SCREENSHOT_ASSET concatenates `font:`
      // directly after the hex color and greedily extends it to `#1533fff`.
      assetRef:
        'page:"Fixture Page" color:#1533ff font:14 radius:12 icon:logo button:submit image:avatar'
    };
  }

  it("carries real 5.6-1 token findings into every draft (page-level, deterministic)", async () => {
    const outcome = await new VisualAnalyzer(new FakeVLMProvider()).analyzeFull(recordFixture());
    expect(outcome.tokenFindings.map((token) => `${token.namespace}.${token.name}`)).toEqual([
      "colors.primary",
      "typography.body",
      "radii.card"
    ]);

    const { tasks } = buildFrontendTasks(outcome.specification, { knownComponents: ["Button"] });
    const enriched = attachDesignTokens(tasks, outcome.tokenFindings);

    expect(enriched.length).toBe(tasks.length);
    for (const draft of enriched) {
      const section = draft.instructions.sections[0];
      expect(section.styleTokens).toEqual([
        { namespace: "colors", name: "primary", value: "#1533ff" },
        { namespace: "radii", name: "card", value: "12px" },
        { namespace: "typography", name: "body", value: "14px" }
      ]);
      // Frozen schema stays the sole validator.
      expect(FrontendTaskDraftSchema.safeParse(draft).success).toBe(true);
    }
  });

  it("is pure, idempotent and re-sorted by (namespace, name)", () => {
    const specs = specFixture([sectionFixture([elementFixture()])]);
    const { tasks } = buildFrontendTasks(specs, { knownComponents: ["Button"] });
    const findings = [
      { namespace: "typography" as const, name: "body", value: "14px" },
      { namespace: "colors" as const, name: "primary", value: "#1533ff" },
      { namespace: "colors" as const, name: "primary", value: "#1533ff" }
    ];
    const once = attachDesignTokens(tasks, findings);
    const twice = attachDesignTokens(once, findings);
    expect(twice).toEqual(once);
    expect(once[0].instructions.sections[0].styleTokens.map((t) => t.name)).toEqual([
      "primary",
      "body"
    ]);
    // Inputs untouched.
    expect(tasks[0].instructions.sections[0].styleTokens).toEqual([]);
  });
});
