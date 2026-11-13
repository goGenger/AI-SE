import {
  deterministicVisualId,
  validateVisualInput,
  VisualSpecificationSchema,
  type VisualElement,
  type VisualInputAllowlist,
  type VisualInputRecord,
  type VisualPage,
  type VisualSection,
  type VisualSpecification,
  type VisualState,
  type VisualStateName,
  type VisualViewport
} from "@ai-se/shared";
import { VisualAnalyzerError } from "./errors";
import type {
  VLMElementObservation,
  VLMPageObservation,
  VLMSectionObservation,
  VLMProvider
} from "./vlm/types";

/**
 * Phase 5.6-1: deterministic post-processing of one VLM observation into the
 * frozen 5.6-0 contracts. The provider never writes ids or geometry verbatim —
 * everything passes through normalization (clamping, ordering, vocabulary
 * intersection) and deterministicVisualId before schema parse.
 */

export const DEFAULT_ANALYZE_TIMEOUT_MS = 30_000;

/** Provider state-hint → frozen VisualStateName vocabulary (strict subset). */
const STATE_HINT_MAP: Readonly<Record<string, VisualStateName>> = Object.freeze({
  error: "error",
  loading: "loading",
  hover: "hover",
  focus: "focus",
  disabled: "disabled",
  empty: "empty",
  default: "default"
});

export interface AnalyzeOptions {
  allowlist?: VisualInputAllowlist;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Full analyze outcome: frozen schema + deterministic token findings + raw warnings. */
export interface AnalyzeOutcome {
  specification: VisualSpecification;
  tokenFindings: DesignTokenFinding[];
  providerWarnings: string[];
}

/**
 * Functional entry (used by the facade): validates the record, runs the
 * provider with timeout/cancellation, normalizes deterministically and
 * derives token findings from the FIRST (topmost) section's style — the
 * page-level style carrier per the 5.6-0 contract.
 */
export async function analyzeSpecification(
  analyzer: VisualAnalyzer,
  record: VisualInputRecord,
  options: AnalyzeOptions & { allowlist?: VisualInputAllowlist } = {}
): Promise<AnalyzeOutcome> {
  const allowlist = options.allowlist ?? [];
  // 1. Input contract gate (5.6-0): prefix match + url allowlist.
  const validated = validateVisualInput(record, allowlist);
  if (!validated.ok) {
    throw new VisualAnalyzerError("INPUT_INVALID", validated.reason);
  }

  // 2. Provider call (timeout + cancellation handled inside).
  const observation = await analyzer.callProvider(record, options);

  // 3. Deterministic post-processing → frozen schema (throws VLM_MALFORMED
  //    if nothing usable survives).
  const specification = buildSpecification(observation, validated.record);

  // 4. Token derivation from the page-leading section style.
  const tokenFindings = extractDesignTokens(observation.sections[0]?.style);
  return { specification, tokenFindings, providerWarnings: [...observation.warnings] };
}

/** Analyzer entry: binds the provider once, analyzes many inputs. */
export class VisualAnalyzer {
  constructor(
    private readonly provider: VLMProvider,
    private readonly analysisOptions: { allowlist?: VisualInputAllowlist } = {}
  ) {}

  /** Provider access for the functional entry (install-time composition). */
  get boundProvider(): VLMProvider {
    return this.provider;
  }

  async analyze(
    record: VisualInputRecord,
    options: AnalyzeOptions = {}
  ): Promise<VisualSpecification> {
    return (await this.analyzeFull(record, options)).specification;
  }

  /** Full outcome variant (specification + tokens + warnings). */
  async analyzeFull(
    record: VisualInputRecord,
    options: AnalyzeOptions = {}
  ): Promise<AnalyzeOutcome> {
    const allowlist = options.allowlist ?? this.analysisOptions.allowlist ?? [];
    const validated = validateVisualInput(record, allowlist);
    if (!validated.ok) {
      throw new VisualAnalyzerError("INPUT_INVALID", validated.reason);
    }

    const observation = await this.callProvider(record, options);
    const specification = buildSpecification(observation, validated.record);
    const tokenFindings = extractDesignTokens(observation.sections[0]?.style);
    return { specification, tokenFindings, providerWarnings: [...observation.warnings] };
  }

  async callProvider(
    record: VisualInputRecord,
    options: AnalyzeOptions
  ): Promise<VLMPageObservation> {
    // A pre-aborted caller signal cancels without any provider work.
    if (options.signal?.aborted) {
      throw new VisualAnalyzerError("VLM_CANCELLED", "Visual analysis was cancelled");
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_ANALYZE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      return await this.provider.recognize(
        {
          imageBase64: record.assetRef ?? "",
          mimeType: "image/png",
          viewport: record.viewport
        },
        { signal: controller.signal }
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw options.signal?.aborted
          ? new VisualAnalyzerError("VLM_CANCELLED", "Visual analysis was cancelled")
          : new VisualAnalyzerError("VLM_TIMEOUT", `Visual analysis exceeded ${timeoutMs}ms`);
      }
      throw normalizeProviderError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeProviderError(error: unknown): VisualAnalyzerError {
  if (error instanceof VisualAnalyzerError) return error;
  const message = error instanceof Error ? error.message : "Unknown provider failure";
  if (/abort/i.test(message)) {
    return new VisualAnalyzerError("VLM_CANCELLED", "Visual analysis was aborted");
  }
  return new VisualAnalyzerError("VLM_UNAVAILABLE", message);
}

// ── Observation → frozen schema (pure, deterministic) ───────────────────────

export function buildSpecification(
  observation: VLMPageObservation,
  record: VisualInputRecord
): VisualSpecification {
  const sections = observation.sections
    .map((section, index) => normalizeSection(section, record.viewport, index))
    .filter((section): section is VisualSection => section !== null)
    .sort(compareSections);

  if (sections.length === 0) {
    throw new VisualAnalyzerError(
      "VLM_MALFORMED",
      "Provider returned no usable sections (all invalid or outside the viewport)"
    );
  }

  const page: VisualPage = {
    id: deterministicVisualId("page", observation.pageName || "unnamed", 1),
    name: observation.pageName || "Unnamed Page",
    viewport: record.viewport,
    sections
  };

  // Strict frozen schema — throws ZodError on private/unknown fields, which
  // the analyzer surfaces as VLM_MALFORMED through the caller's try/catch.
  return VisualSpecificationSchema.parse({
    input: record,
    page,
    generatedAt: new Date().toISOString()
  });
}

function normalizeSection(
  section: VLMSectionObservation,
  viewport: VisualViewport,
  index: number
): VisualSection | null {
  const rect = clampRect(section.rect, viewport);
  if (!rect) return null;

  const elements: VisualElement[] = [];
  const warnings: string[] = [];
  const states: VisualState[] = [];
  for (const [elementIndex, observation] of (section.elements ?? []).entries()) {
    const element = normalizeElement(observation, elementIndex);
    if (element) elements.push(element);
    else warnings.push(`Dropped invalid element observation at index ${elementIndex}`);
    if (observation.stateHint) {
      const mapped = STATE_HINT_MAP[observation.stateHint.toLowerCase()];
      if (mapped) states.push({ state: mapped });
    }
  }

  const trimmedName = (section.name ?? "").trim();
  return {
    id: deterministicVisualId("section", trimmedName || `section-${index + 1}`, index + 1),
    title: trimmedName || `Section ${index + 1}`,
    geometry: { rect },
    ...(elements.length > 0 ? { elements } : {}),
    ...(states.length > 0 ? { states } : {})
  };
}

function normalizeElement(observation: VLMElementObservation, index: number): VisualElement | null {
  const name = (observation.name ?? "").trim();
  if (!name) return null;

  let geometry: VisualElement["geometry"] | undefined;
  if (observation.rect) {
    const rect = sanitizeRect(observation.rect);
    // An invalid rect drops the whole element (rect is part of the identity).
    if (!rect) return null;
    geometry = { rect };
  }

  return {
    id: deterministicVisualId("element", name, index + 1),
    role: observation.role,
    description: buildDescription(observation),
    ...(geometry ? { geometry } : {})
  };
}

function buildDescription(observation: VLMElementObservation): string {
  const hint = observation.stateHint;
  const mapped = hint ? STATE_HINT_MAP[hint.toLowerCase()] : undefined;
  const stateSuffix = mapped ? ` — ${mapped} state` : "";
  return `${observation.name}: ${observation.role}${stateSuffix}`;
}

/** Positive ints only; non-finite / non-positive → null (drops the node). */
function sanitizeRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } | null {
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.round(width),
    height: Math.round(height)
  };
}

/** Viewport containment: partial overlap is clamped, full miss → null. */
function clampRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: VisualViewport
): { x: number; y: number; width: number; height: number } | null {
  const sanitized = sanitizeRect(rect);
  if (!sanitized) return null;
  const x = Math.min(sanitized.x, Math.max(0, viewport.width - 1));
  const y = Math.min(sanitized.y, Math.max(0, viewport.height - 1));
  const width = Math.max(1, Math.min(sanitized.width, viewport.width - x));
  const height = Math.max(1, Math.min(sanitized.height, viewport.height - y));
  if (sanitized.x >= viewport.width || sanitized.y >= viewport.height) return null;
  if (sanitized.x + sanitized.width <= 0 || sanitized.y + sanitized.height <= 0) return null;
  return { x, y, width, height };
}

/** Reading order: top → bottom, then left → right (deterministic layout order). */
function compareSections(a: VisualSection, b: VisualSection): number {
  const ra = a.geometry.rect;
  const rb = b.geometry.rect;
  return ra.y - rb.y || ra.x - rb.x;
}

/** Style observation → design-tokens value map (5.6-0 namespaces only). */
export function extractDesignTokens(style: VLMSectionObservation["style"]): DesignTokenFinding[] {
  const tokens: DesignTokenFinding[] = [];
  if (style?.color) tokens.push({ namespace: "colors", name: "primary", value: style.color });
  if (style?.fontSizePx !== undefined) {
    tokens.push({ namespace: "typography", name: "body", value: `${style.fontSizePx}px` });
  }
  if (style?.radiusPx !== undefined) {
    tokens.push({ namespace: "radii", name: "card", value: `${style.radiusPx}px` });
  }
  if (style?.shadow) tokens.push({ namespace: "shadows", name: "elevated", value: style.shadow });
  return tokens;
}

export interface DesignTokenFinding {
  namespace: "colors" | "typography" | "spacing" | "radii" | "shadows" | "motion";
  name: string;
  value: string;
}
