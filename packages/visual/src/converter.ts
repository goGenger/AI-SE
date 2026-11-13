import { z } from "zod";
import { ComponentMapEntrySchema, VisualSpecificationSchema } from "@ai-se/shared";
import type {
  ComponentMapEntry,
  VisualSection,
  VisualSpecification
} from "@ai-se/shared";
import { redactCredentialShapedText } from "@ai-se/observability";
import type { DesignTokenFinding } from "./analyzer";

/**
 * Phase 5.6-2: VisualSpecification → FrontendTaskDraft converter. Pure
 * functions, no I/O, no network. Drafts are NOT Task entities: persistence,
 * state machine and approval are owned by the existing planning/workflow
 * chain (5.6-2 only produces data). Gaps (`matched: false`) are real data
 * and are carried into the task description — never dropped silently.
 */

/** Freezes the role→component default mapping (callers may override). */
export const DEFAULT_ROLE_COMPONENT_MAP: Readonly<Record<string, string>> = Object.freeze({
  button: "Button",
  input: "Input",
  image: "Image",
  icon: "Icon",
  link: "Link",
  list: "List",
  table: "Table",
  text: "Text",
  container: "View",
  other: "View"
});

// ── FrontendTaskDraft schema ════════════════════════════════════════════════

/** One draft per section; carries everything a frontend agent needs standalone. */
export const FrontendTaskDraftSchema = z
  .object({
    taskKey: z.string().regex(/^visual:[a-zA-Z0-9-]+:[0-9]+$/, "taskKey must be visual:<pageTitleSlug>:<N>"),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(20_000),
    type: z.literal("FRONTEND"),
    priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
    assignedAgent: z.literal("frontend-agent"),
    approvalRequired: z.boolean(),
    visualInput: z
      .object({
        source: z.string().trim().min(1),
        viewportWidth: z.number().int().positive(),
        viewportHeight: z.number().int().positive()
      })
      .strict(),
    instructions: z
      .object({
        sections: z
          .array(
            z
              .object({
                sectionId: z.string().trim().min(1).max(120),
                title: z.string().trim().min(1).max(300),
                rect: z
                  .object({
                    x: z.number(),
                    y: z.number(),
                    width: z.number(),
                    height: z.number()
                  })
                  .strict(),
                elements: z.array(
                  z
                    .object({
                      id: z.string().trim().min(1).max(120),
                      role: z.string().trim().min(1).max(40),
                      description: z.string().trim().max(2_000),
                      geometryWidth: z.number().optional(),
                      geometryHeight: z.number().optional(),
                      states: z.array(z.string().trim().min(1).max(40)).max(16).optional()
                    })
                    .strict()
                ),
                styleTokens: z.array(
                  z
                    .object({
                      namespace: z.string().trim().min(1).max(40),
                      name: z.string().trim().min(1).max(200),
                      value: z.string().trim().min(1).max(500)
                    })
                    .strict()
                ),
                componentHint: z.string().trim().min(1).max(200).optional(),
                unmatchedReason: z.string().trim().min(1).max(500).optional()
              })
              .strict()
          )
          .max(1) // one draft per section — see buildFrontendTasks grouping
      })
      .strict()
  })
  .strict();
export type FrontendTaskDraft = z.infer<typeof FrontendTaskDraftSchema>;

// ── Component matching ═══════════════════════════════════════════════════════

export interface MatchOptions {
  /** Component names available in the caller's project component library. */
  knownComponents?: string[];
  /** role→component override; wins over DEFAULT_ROLE_COMPONENT_MAP. */
  roleMap?: Record<string, string>;
}

const GAP_REASON_PREFIX = "No component for role";

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

/** Deterministic role→component resolution for one element. */
function matchComponent(
  role: string,
  options: MatchOptions
): { componentName?: string; gapReason?: string } {
  const override = options.roleMap?.[role];
  const candidate = override ?? DEFAULT_ROLE_COMPONENT_MAP[role];
  if (!candidate) {
    return { gapReason: `${GAP_REASON_PREFIX} ${role} in current library` };
  }
  // knownComponents is unconstrained when absent/empty (fall back to default
  // mapping); when provided, the candidate must be in the library.
  const known = options.knownComponents;
  if (known && known.length > 0) {
    const exists = known.some((name) => normalizeName(name) === normalizeName(candidate));
    if (!exists) {
      return { gapReason: `${GAP_REASON_PREFIX} ${role} in current library` };
    }
  }
  return { componentName: candidate };
}

/** Match every element of every section; returns entries aligned per section. */
export function buildComponentMap(
  specification: VisualSpecification,
  options: MatchOptions = {}
): ComponentMapEntry[][] {
  const perSection: ComponentMapEntry[][] = [];
  for (const section of specification.page.sections) {
    const entries: ComponentMapEntry[] = [];
    for (const element of section.elements ?? []) {
      const result = matchComponent(element.role, options);
      entries.push(
        ComponentMapEntrySchema.parse(
          result.gapReason
            ? { id: element.id, matched: false, unmatchedReason: result.gapReason }
            : {
                id: element.id,
                componentName: result.componentName,
                matched: true,
                confidence: 1
              }
        )
      );
    }
    perSection.push(entries);
  }
  return perSection;
}

// ── Draft building ═══════════════════════════════════════════════════════════

/** Deterministic slug for taskKey (page name → lowercase, nonalnum→'-'). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "page"
  );
}

function sectionGapRatio(section: VisualSection, entries: ComponentMapEntry[]): number {
  const total = entries.length || (section.elements?.length ?? 0);
  if (total === 0) return 0;
  const gaps = entries.filter((entry) => !entry.matched).length;
  return gaps / total;
}

function buildDescription(
  section: VisualSection,
  entries: ComponentMapEntry[],
  styleTokens: DesignTokenSummary[]
): string {
  const lines: string[] = [];
  lines.push(`Section "${section.title}" (id=${section.id})`);
  lines.push(
    `rect: x=${section.geometry.rect.x}, y=${section.geometry.rect.y}, w=${section.geometry.rect.width}, h=${section.geometry.rect.height}`
  );
  const elements = section.elements ?? [];
  if (elements.length > 0) {
    lines.push("elements:");
    for (const element of elements) {
      const entry = entries.find((candidate) => candidate.id === element.id);
      const componentPart = entry?.matched ? ` → ${entry.componentName}` : "";
      lines.push(`- [${element.role}] ${element.description || element.id}${componentPart}`);
    }
  }
  if (styleTokens.length > 0) {
    lines.push("style tokens:");
    for (const token of styleTokens) {
      lines.push(`- @ref:${token.namespace}.${token.name} = ${token.value}`);
    }
  }
  const gaps = entries.filter((entry) => !entry.matched);
  if (gaps.length > 0) {
    lines.push("component gaps:");
    for (const gap of gaps) {
      lines.push(`- ${gap.id}: ${gap.unmatchedReason}`);
    }
  }
  return lines.join("\n");
}

export interface DesignTokenSummary {
  namespace: string;
  name: string;
  value: string;
}

export interface FrontendTaskBuildOptions extends MatchOptions {
  /** Reserved for future converter extensions (frozen shape, avoid breaks). */
  extension?: never;
}

/**
 * Frozen risk/approval derivation (tests lock this; callers must not rewrite):
 *   gap ratio > 50% in a section → approvalRequired + HIGH
 *   all matched                    → no approval + MEDIUM
 */
export function deriveApproval(section: VisualSection, entries: ComponentMapEntry[]): {
  approvalRequired: boolean;
  priority: "HIGH" | "MEDIUM" | "LOW";
} {
  const ratio = sectionGapRatio(section, entries);
  if (ratio > 0.5) {
    return { approvalRequired: true, priority: "HIGH" };
  }
  return { approvalRequired: false, priority: "MEDIUM" };
}

/**
 * Grouping rule (frozen): ONE draft per section of .page.sections, each
 * repeating page metadata so drafts are independently executable.
 */
export function buildFrontendTasks(
  specification: VisualSpecification,
  options: MatchOptions = {}
): { tasks: FrontendTaskDraft[]; componentMap: ComponentMapEntry[][] } {
  // Input contract gate (frozen 5.6-0 schema).
  VisualSpecificationSchema.parse(specification);

  const perSection = buildComponentMap(specification, options);
  const page = specification.page;
  const pageSlug = slugify(page.name);
  const tasks: FrontendTaskDraft[] = [];

  page.sections.forEach((section, index) => {
    const entries = perSection[index];
    const { approvalRequired, priority } = deriveApproval(section, entries);
    const sectionMatched = entries.filter((entry) => entry.matched);
    const matchedHint =
      sectionMatched.length > 0 ? sectionMatched[0].componentName : undefined;
    const firstGap = entries.find((entry) => !entry.matched);
    const styleTokens: DesignTokenSummary[] = []; // filled by caller variant below

    let draft: FrontendTaskDraft = {
      taskKey: `visual:${pageSlug}:${index + 1}`,
      title: `Implement page ${page.name} section ${section.title}`,
      description: buildDescription(section, entries, styleTokens),
      type: "FRONTEND",
      priority,
      assignedAgent: "frontend-agent",
      approvalRequired,
      visualInput: {
        source: specification.input.source,
        viewportWidth: page.viewport.width,
        viewportHeight: page.viewport.height
      },
      instructions: {
        sections: [
          {
            sectionId: section.id,
            title: section.title,
            rect: {
              x: section.geometry.rect.x,
              y: section.geometry.rect.y,
              width: section.geometry.rect.width,
              height: section.geometry.rect.height
            },
            elements: (section.elements ?? []).map((element) => ({
              id: element.id,
              role: element.role,
              description: element.description,
              geometryWidth: element.geometry?.rect.width,
              geometryHeight: element.geometry?.rect.height,
              states: element.states?.map((state) => state.state)
            })),
            styleTokens: [],
            componentHint: matchedHint,
            unmatchedReason: firstGap?.unmatchedReason
          }
        ]
      }
    };
    draft = FrontendTaskDraftSchema.parse(draft);
    tasks.push(draft);
  });

  return { tasks, componentMap: perSection };
}

/** Redacts credential-shaped substrings from any draft text before export. */
export function redactDraftText<T extends { description: string }>(draft: T): T {
  return { ...draft, description: redactCredentialShapedText(draft.description) };
}

/**
 * Phase 5.6-2 Repair: fills the frozen `styleTokens` slot of each draft with
 * the page-level design-token findings from the Phase 5.6-1 analysis outcome
 * (`extractDesignTokens`).
 *
 * Token findings are page-level (derived from the page-leading section style
 * per the 5.6-0 contract) and drafts deliberately repeat page metadata so
 * each one is independently executable — so every draft carries the same
 * token set. Deterministic: deduplicated by `namespace.name`, ordered by
 * (namespace, name). Pure: returns re-validated drafts, inputs untouched.
 */
export function attachDesignTokens(
  tasks: FrontendTaskDraft[],
  findings: DesignTokenFinding[]
): FrontendTaskDraft[] {
  const unique = new Map<string, DesignTokenSummary>();
  for (const finding of findings) {
    const key = `${finding.namespace}.${finding.name}`;
    if (!unique.has(key)) {
      unique.set(key, { namespace: finding.namespace, name: finding.name, value: finding.value });
    }
  }
  const ordered = [...unique.values()].sort(
    (a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)
  );
  return tasks.map((task) =>
    FrontendTaskDraftSchema.parse({
      ...task,
      instructions: {
        ...task.instructions,
        sections: task.instructions.sections.map((section) => ({
          ...section,
          styleTokens: ordered.map((token) => ({ ...token }))
        }))
      }
    })
  );
}
