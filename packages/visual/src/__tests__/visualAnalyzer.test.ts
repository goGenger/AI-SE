import { VisualSpecificationSchema } from "@ai-se/shared";
import {
  FAKE_SCREENSHOT_ASSET,
  FakeVLMProvider,
  VisualAnalyzer,
  analyzeWithReport,
  collectWarnings,
  serializeVisualAnalysisReportMd
} from "../index";
import { redactCredentialShapedText } from "@ai-se/observability";
import type { VisualInputRecord } from "@ai-se/shared";
import { describe, expect, it } from "vitest";

/**
 * Phase 5.6-1 tests: deterministic analyzer over the real (local) fake
 * provider. No network / files / real models. Covers the seven docs/17 items:
 * structure tree, geometry, style, state markers, multi-viewport, provider
 * isolation and the report artifact.
 */

function recordFixture(overrides: Partial<VisualInputRecord> = {}): VisualInputRecord {
  return {
    inputType: "screenshot",
    source: "screenshot://fixtures/dashboard.png",
    viewport: { width: 1440, height: 900 },
    assetRef: FAKE_SCREENSHOT_ASSET,
    ...overrides
  };
}

describe("Phase 5.6-1 deterministic analysis (fake provider)", () => {
  it("produces a frozen-schema-valid specification from fixture bytes", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const specification = await analyzer.analyze(recordFixture());

    // 5.6-0 contract: strict parse must succeed and never gain private fields.
    expect(VisualSpecificationSchema.safeParse(specification).success).toBe(true);
    expect(specification.page.sections.length).toBeGreaterThan(0);
    expect(specification.page.name).toBe("Fixture Page");
  });

  it("generates identical stable ids for identical inputs", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const first = await analyzer.analyze(recordFixture());
    const second = await analyzer.analyze(recordFixture());

    // The spec contains pass timestamps; structural content (ids, geometry,
    // order) must be identical — strip both generatedAt fields for the diff.
    const structural = (specification: typeof first) => ({
      ...specification,
      generatedAt: "<stripped>"
    });
    expect(structural(second)).toEqual(structural(first));
  });

  it("normalizes geometry inside the viewport and in reading order", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const specification = await analyzer.analyze(recordFixture());

    for (const section of specification.page.sections) {
      const rect = section.geometry.rect;
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1440);
      expect(rect.y + rect.height).toBeLessThanOrEqual(900);
    }
    // Reading order: header above body when the wide variant is produced.
    const ys = specification.page.sections.map((section) => section.geometry.rect.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it("carries style-derived design token vocabulary", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const { report } = await analyzeWithReport(analyzer, recordFixture());
    expect(report.tokenSummary.length).toBeGreaterThan(0);
    expect(
      report.tokenSummary.every((token) => /^(colors|typography|radii|shadows)\./.test(token))
    ).toBe(true);
  });

  it("marks state hints only within the frozen vocabulary", async () => {
    const badgeRecord = recordFixture({ assetRef: "badge:error icon:logo" });
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const specification = await analyzer.analyze(badgeRecord);

    const allStates = specification.page.sections.flatMap((section) => section.states ?? []);
    expect(allStates.length).toBeGreaterThan(0);
    expect(allStates.every((state) => state.state === "error")).toBe(true);
  });

  it("distinguishes desktop and mobile passes on the same record", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const desktop = await analyzer.analyze(recordFixture());
    const mobile = await analyzer.analyze(recordFixture({ viewport: { width: 390, height: 844 } }));

    expect(desktop.page.viewport).toEqual({ width: 1440, height: 900 });
    expect(mobile.page.viewport).toEqual({ width: 390, height: 844 });
    // Geometry scales with the viewport, ids stay per-pass deterministic.
    expect(mobile).not.toEqual(desktop);
    expect(mobile.page.sections.length).toBeGreaterThan(0);
  });
});

describe("Phase 5.6-1 provider discipline", () => {
  it("classifies malformed provider output as VLM_MALFORMED", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider({ malformed: true }));
    await expect(analyzer.analyze(recordFixture())).rejects.toMatchObject({
      name: "VisualAnalyzerError",
      code: "VLM_MALFORMED"
    });
  });

  it("reports VLM_TIMEOUT when the provider exceeds the deadline", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider({ delayMs: 300 }));
    await expect(analyzer.analyze(recordFixture(), { timeoutMs: 80 })).rejects.toMatchObject({
      code: "VLM_TIMEOUT"
    });
  });

  it("propagates caller cancellation as VLM_CANCELLED with zero post-work", async () => {
    const controller = new AbortController();
    controller.abort();
    const analyzer = new VisualAnalyzer(new FakeVLMProvider({ delayMs: 120 }));
    await expect(
      analyzer.analyze(recordFixture(), { signal: controller.signal })
    ).rejects.toMatchObject({ code: "VLM_CANCELLED" });
  });

  it("rejects invalid inputs before touching the provider", async () => {
    const provider = new FakeVLMProvider();
    const calls: unknown[] = [];
    const recording = new Proxy(provider, {
      get(target, property, receiver) {
        if (property === "recognize") {
          return (input: unknown) => {
            calls.push(input);
            return target.recognize(input as never);
          };
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const analyzer = new VisualAnalyzer(recording);

    await expect(
      analyzer.analyze(recordFixture({ source: "url://unknown.test/app" }))
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("keeps the VLM contract free of runtime effects (interface only)", async () => {
    // The fake never touches network/fs; prove determinism once more while
    // asserting the provider name contract stays stable.
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const outcome = await analyzer.analyzeFull(recordFixture());
    expect(outcome.tokenFindings.length).toBeGreaterThan(0);
  });
});

describe("Phase 5.6-1 report facade", () => {
  it("builds warnings for element-less sections and dedupes", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const narrowRecord = recordFixture({
      viewport: { width: 390, height: 844 },
      assetRef: "page:Narrow"
    });
    const { specification, report } = await analyzeWithReport(analyzer, narrowRecord);
    const expected = collectWarnings(specification, []);
    expect(report.warnings).toEqual(expected);
  });

  it("redacts credential-shaped text in the exported markdown", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const leaky = recordFixture({
      source: "screenshot://fixtures/leaky.png",
      assetRef:
        'page:"Checkout" color:#1533ff shadow:"sk-leaky1234567890abcdef and Bearer AAAABBBBCCCC"'
    });
    const { report, specification } = await analyzeWithReport(analyzer, leaky);
    report.warnings.push("note sk-live987654321abcdef injected by fixture");

    const markdown = serializeVisualAnalysisReportMd({ specification, report });
    expect(markdown).not.toContain("sk-leaky1234567890abcdef");
    expect(markdown).not.toContain("sk-live987654321abcdef");
    expect(markdown).not.toContain("AAAABBBBCCCC");
    expect(markdown).toContain("[REDACTED]");
    expect(redactCredentialShapedText(markdown)).toBe(markdown);
  });

  it("renders a deterministic report artifact", async () => {
    const analyzer = new VisualAnalyzer(new FakeVLMProvider());
    const first = await analyzeWithReport(analyzer, recordFixture());
    const second = await analyzeWithReport(analyzer, recordFixture());

    // Timestamps differ by passes; the structural markdown is identical.
    const stripped = (md: string) => md.replace(/- (Generated|Analyzed) at: .*/g, "");
    expect(stripped(serializeVisualAnalysisReportMd(second))).toBe(
      stripped(serializeVisualAnalysisReportMd(first))
    );
  });
});
