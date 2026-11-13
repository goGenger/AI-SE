/**
 * Phase 5.6-2 Repair: UI Specification → Frontend Task → Frontend Agent.
 *
 * Pure bridge (no I/O). Consumes a frozen `FrontendTaskDraft`
 * (packages/visual converter output) structurally — the draft schema stays the
 * single source of truth and is NOT duplicated here — and composes the task
 * text handed to the existing frontend-agent (ProfessionalAgent) through the
 * existing Task/ToolRuntime/Sandbox chain. No new task system is introduced.
 */
import path from "node:path";

/** One element exactly as the frozen draft carries it. */
export interface FrontendTaskElement {
  id: string;
  role: string;
  description: string;
}

export interface FrontendTaskSection {
  sectionId: string;
  title: string;
  rect: { x: number; y: number; width: number; height: number };
  elements: FrontendTaskElement[];
  styleTokens: { namespace: string; name: string; value: string }[];
  componentHint?: string;
  unmatchedReason?: string;
}

/** Structural mirror of the draft fields this bridge consumes. */
export interface FrontendTaskSpec {
  taskKey: string;
  title: string;
  description: string;
  visualInput: { source: string; viewportWidth: number; viewportHeight: number };
  instructions: { sections: FrontendTaskSection[] };
}

/** Project layout the agent must work within (per-project configuration). */
export interface FrontendWorkspaceConventions {
  /** App root relative to the workspace (run_build/run_unit_test cwd). */
  appRoot: string;
  componentsDir: string;
  tokensFile: string;
  pagesDir: string;
  assetsDir: string;
  buildCommand: string;
  testCommand: string;
}

/**
 * Defaults match the apps/web layout the stock frontend-agent permissions
 * already allow (`readPaths`/`writePaths`: apps/web).
 */
export const DEFAULT_FRONTEND_CONVENTIONS: FrontendWorkspaceConventions = Object.freeze({
  appRoot: "apps/web",
  componentsDir: "apps/web/src/components",
  tokensFile: "apps/web/src/tokens.css",
  pagesDir: "apps/web/src/pages",
  assetsDir: "apps/web/src/assets",
  buildCommand: "node scripts/build.mjs",
  testCommand: "node --test tests/*.test.mjs"
});

export class FrontendTaskInputError extends Error {
  readonly code = "FRONTEND_TASK_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "FrontendTaskInputError";
  }
}

const TASK_KEY_PATTERN = /^visual:([a-z0-9-]+):([0-9]+)$/;

/** `visual:<pageSlug>:<N>` → target page module inside the pages dir. */
export function frontendTaskTargetPage(
  spec: FrontendTaskSpec,
  conventions: FrontendWorkspaceConventions = DEFAULT_FRONTEND_CONVENTIONS
): { pageSlug: string; pageFile: string } {
  const match = TASK_KEY_PATTERN.exec(spec.taskKey ?? "");
  if (!match?.[1]) {
    throw new FrontendTaskInputError(
      `taskKey must match visual:<pageSlug>:<N>, got "${spec.taskKey}"`
    );
  }
  const pageSlug = match[1];
  return { pageSlug, pageFile: `${conventions.pagesDir}/${pageSlug}.js` };
}

/** Deterministic design-token → CSS custom property name (`--<ns>-<name>`). */
export function tokenCssVarName(token: { namespace: string; name: string }): string {
  return `--${token.namespace}-${token.name}`;
}

function assertSpec(spec: FrontendTaskSpec): void {
  if (!spec || typeof spec !== "object") throw new FrontendTaskInputError("spec is required");
  if (!TASK_KEY_PATTERN.test(spec.taskKey ?? "")) {
    throw new FrontendTaskInputError(
      `taskKey must match visual:<pageSlug>:<N>, got "${spec.taskKey}"`
    );
  }
  if (typeof spec.title !== "string" || spec.title.trim().length === 0) {
    throw new FrontendTaskInputError("title is required");
  }
  const sections = spec.instructions?.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new FrontendTaskInputError("instructions.sections must contain at least one section");
  }
  for (const section of sections) {
    if (typeof section.sectionId !== "string" || section.sectionId.trim().length === 0) {
      throw new FrontendTaskInputError("section.sectionId is required");
    }
    const rect = section.rect;
    if (
      !rect ||
      ![rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value))
    ) {
      throw new FrontendTaskInputError(`section "${section.sectionId}" has an invalid rect`);
    }
  }
}

/**
 * The task text handed to the existing frontend-agent. Everything the agent
 * needs is in the text: the frozen draft (machine block) plus the explicit
 * implementation rules for component reuse, tokens, layout, assets, targeted
 * change scope and verification commands.
 */
export function buildFrontendAgentTask(
  spec: FrontendTaskSpec,
  conventions: FrontendWorkspaceConventions = DEFAULT_FRONTEND_CONVENTIONS
): string {
  assertSpec(spec);
  const { pageSlug, pageFile } = frontendTaskTargetPage(spec, conventions);
  const relative = (from: string, to: string): string =>
    path.posix.relative(path.posix.dirname(from), to);

  const machine = {
    task: {
      taskKey: spec.taskKey,
      title: spec.title,
      description: spec.description,
      visualInput: spec.visualInput,
      instructions: spec.instructions
    },
    conventions,
    targetPage: { pageSlug, pageFile }
  };
  const machineJson = JSON.stringify(machine, null, 1).replaceAll("</", "<\\/");

  const sectionLines = spec.instructions.sections.flatMap((section) => [
    `- ${section.sectionId} "${section.title}" rect=${section.rect.x},${section.rect.y},${section.rect.width},${section.rect.height}`,
    ...section.elements.map(
      (element) => `  - ${element.id} [${element.role}] "${element.description}"`
    ),
    ...(section.styleTokens.length > 0
      ? [
          `  tokens: ${section.styleTokens
            .map((token) => `${tokenCssVarName(token)}=${token.value}`)
            .join(", ")}`
        ]
      : ["  tokens: (none carried)"]),
    ...(section.componentHint ? [`  reuse hint: ${section.componentHint}`] : []),
    ...(section.unmatchedReason ? [`  component gap: ${section.unmatchedReason}`] : [])
  ]);

  return [
    `Implement the target page module for visual task ${spec.taskKey} in this project.`,
    `Target file: ${pageFile} (new module unless it already exists).`,
    "",
    `1. Inspect BEFORE writing (use ls/read_file):`,
    `   - existing components in ${conventions.componentsDir}`,
    `   - design tokens in ${conventions.tokensFile}`,
    `   - assets in ${conventions.assetsDir}`,
    `   - the reuse-hint component file for the roles you are about to implement.`,
    "",
    `2. Reuse existing components. Import them from "${relative(pageFile, conventions.componentsDir)}/<File>.js"`,
    `   using their existing named exports. Do NOT create new components for matched roles.`,
    `   Any role whose component is missing from the components dir must be implemented with`,
    `   semantic HTML and RECORDED as a missing component in your result — never assumed silently.`,
    "",
    `3. Style with the project design tokens: use var(--<namespace>-<name>) CSS custom`,
    `   properties (e.g. ${spec.instructions.sections[0].styleTokens.map(tokenCssVarName).slice(0, 3).join(", ") || "var(--colors-primary)"})`,
    `   referencing the values in ${conventions.tokensFile}. Do not hardcode token values.`,
    "",
    `4. Layout: keep the section order and encode geometry on the section node as`,
    `   data-section-id="<sectionId>" and data-rect="x,y,width,height"; set min-height from`,
    `   the rect height.`,
    "",
    `5. Assets: implement image-role elements with <img> referencing an existing file under`,
    `   ${conventions.assetsDir} (relative to the page module). No external URLs.`,
    "",
    `6. Targeted change: create/modify ONLY ${pageFile} (and nothing else). Do not rewrite`,
    `   other pages, components, tokens, or tests.`,
    "",
    `7. Verify before reporting SUCCESS (both must pass):`,
    `   - run_build   { command: "${conventions.buildCommand}", cwd: "${conventions.appRoot}" }`,
    `   - run_unit_test { command: "${conventions.testCommand}", cwd: "${conventions.appRoot}" }`,
    "",
    `Sections carried by this task:`,
    ...sectionLines,
    "",
    `Machine block (authoritative; do not invent fields):`,
    "<ai-se-frontend-task>",
    machineJson,
    "</ai-se-frontend-task>",
    "",
    `Report reusedComponents, missingComponents, tokensUsed and assetRefs in your result metadata.`
  ].join("\n");
}
