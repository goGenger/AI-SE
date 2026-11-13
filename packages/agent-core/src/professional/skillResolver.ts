import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * AI-SE agent skills: declarative injection by taskType / failureClass / capabilityProfile.
 * Model does not self-select. See `packages/agent-core/skills/frontend-vue/README.md`
 * and `packages/agent-core/skills/common/README.md`.
 */

export type SkillTaskType =
  | "FRONTEND"
  | "TEST"
  | "DEBUG"
  | "ANALYSIS"
  | "DESIGN"
  | "REVIEW"
  | string;
export type SkillFailureClass = "TEST_FIXTURE_GAP" | "SPEC_CONFLICT" | string;

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  binds: {
    taskTypes: string[];
    failureClasses: string[];
    capabilityProfiles: string[];
  };
  source: string;
  body: string;
}

export interface ResolvedSkill {
  id: string;
  body: string;
}

export interface ResolveSkillsInput {
  taskType: SkillTaskType;
  failureClass?: SkillFailureClass | undefined;
  capabilityProfile?: string | undefined;
}

const COMMON_SKILL_ORDER = [
  "visual-intent-contract",
  "planning-intent-contract",
  "test-quality-contract",
  "review-evidence-contract"
] as const;
const FRONTEND_VUE_SKILL_ORDER = [
  "vue-visual-contract",
  "vue-implement",
  "vue-test-fixture",
  "vue-debug-repair"
] as const;
const SKILL_ORDER = [...COMMON_SKILL_ORDER, ...FRONTEND_VUE_SKILL_ORDER] as const;

function isFrontendCapabilityProfile(profile: string): boolean {
  return profile.startsWith("frontend-");
}

export function skillsRoot(): string | undefined {
  const candidates = [
    resolve(__dirname, "../../skills"),
    resolve(process.cwd(), "skills"),
    resolve(process.cwd(), "packages/agent-core/skills")
  ];
  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, "common", "visual-intent-contract", "SKILL.md")) &&
      existsSync(join(candidate, "frontend-vue", "vue-implement", "SKILL.md"))
    ) {
      return candidate;
    }
  }
  return undefined;
}

export function frontendVueSkillsRoot(): string | undefined {
  const root = skillsRoot();
  return root ? join(root, "frontend-vue") : undefined;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseStringList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((part) => stripQuotes(part.trim()))
    .filter(Boolean);
}

export function parseSkillMarkdown(raw: string): SkillMeta {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error("SKILL.md missing YAML frontmatter");
  }
  const front = match[1]!;
  const body = match[2]!.trim();
  const fields: Record<string, string> = {};
  let activeListKey: string | undefined;
  const lists: Record<string, string[]> = {
    taskTypes: [],
    failureClasses: [],
    capabilityProfiles: []
  };

  for (const line of front.split(/\r?\n/)) {
    const listItem = line.match(/^\s+-\s+(.+)\s*$/);
    if (listItem && activeListKey) {
      lists[activeListKey] = lists[activeListKey] ?? [];
      lists[activeListKey]!.push(stripQuotes(listItem[1]!));
      continue;
    }
    const nested = line.match(/^\s+(taskTypes|failureClasses|capabilityProfiles):\s*(.*)$/);
    if (nested) {
      activeListKey = nested[1]!;
      const rest = nested[2]!.trim();
      if (rest.startsWith("[")) lists[activeListKey] = parseStringList(rest);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    activeListKey = undefined;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key === "binds") continue;
    if (key === "taskTypes" || key === "failureClasses" || key === "capabilityProfiles") {
      activeListKey = key;
      if (value.startsWith("[")) lists[key] = parseStringList(value);
      continue;
    }
    fields[key] = stripQuotes(value);
  }

  const id = fields.id;
  if (!id) throw new Error("SKILL.md frontmatter missing id");
  return {
    id,
    name: fields.name ?? id,
    description: fields.description ?? "",
    binds: {
      taskTypes: lists.taskTypes ?? [],
      failureClasses: lists.failureClasses ?? [],
      capabilityProfiles: lists.capabilityProfiles ?? []
    },
    source: fields.source ?? "",
    body
  };
}

let catalogCache: Map<string, SkillMeta> | undefined;

function loadSkillsFromDir(dir: string, map: Map<string, SkillMeta>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const meta = parseSkillMarkdown(readFileSync(skillPath, "utf8"));
    map.set(meta.id, meta);
  }
}

function loadCatalog(): Map<string, SkillMeta> {
  if (catalogCache) return catalogCache;
  const map = new Map<string, SkillMeta>();
  const root = skillsRoot();
  if (!root) {
    throw new Error(
      "agent skills root not found (expected packages/agent-core/skills with common/ and frontend-vue/)"
    );
  }
  loadSkillsFromDir(join(root, "common"), map);
  loadSkillsFromDir(join(root, "frontend-vue"), map);
  for (const id of SKILL_ORDER) {
    if (!map.has(id)) {
      throw new Error(
        `agent skills incomplete (missing ${id}); found ${[...map.keys()].join(",") || "none"}`
      );
    }
  }
  catalogCache = map;
  return map;
}

/** Test helper: drop cached catalog (e.g. after writing skills). */
export function resetSkillCatalogCache(): void {
  catalogCache = undefined;
}

export function getSkill(id: string): SkillMeta {
  const skill = loadCatalog().get(id);
  if (!skill) throw new Error(`unknown skill: ${id}`);
  return skill;
}

export function listFrontendVueSkills(): SkillMeta[] {
  const catalog = loadCatalog();
  return FRONTEND_VUE_SKILL_ORDER.map((id) => catalog.get(id)!);
}

/**
 * Declarative bind matrix (docs/252 + docs/265 + docs/267):
 * - visual-intent-contract → FRONTEND, or DEBUG on a frontend-* profile; not SPEC_CONFLICT
 * - vue-visual-contract → same UI tasks, only when capabilityProfile is frontend-vue
 * - FRONTEND + frontend-vue → vue-implement + vue-test-fixture
 * - TEST → test-quality-contract; plus vue-test-fixture on frontend-vue
 * - DEBUG or failureClass TEST_FIXTURE_GAP → vue-test-fixture + vue-debug-repair
 * - SPEC_CONFLICT → vue-test-fixture only (no new common contracts)
 * - ANALYSIS / DESIGN → planning-intent-contract (any profile)
 * - REVIEW → review-evidence-contract (any profile)
 * - BACKEND / DATABASE do not receive the three common contracts
 * - Vue pack skills never inject outside frontend-vue
 *
 * The same planning-intent-contract SKILL.md is also loaded for the
 * requirement / slice / task planning graph via `planningIntentContractBlock`
 * (docs/268). That path does not invent a PLAN / PLANNER task type.
 */
export function resolveSkills(input: ResolveSkillsInput): ResolvedSkill[] {
  const profile = input.capabilityProfile ?? "frontend-vue";
  const ids = new Set<string>();
  const failure = input.failureClass;
  const isVue = profile === "frontend-vue";
  const isUiImplementOrRepair =
    failure !== "SPEC_CONFLICT" &&
    (input.taskType === "FRONTEND" ||
      (input.taskType === "DEBUG" && isFrontendCapabilityProfile(profile)));

  if (isUiImplementOrRepair) {
    ids.add("visual-intent-contract");
    if (isVue) ids.add("vue-visual-contract");
  }

  if (input.taskType === "ANALYSIS" || input.taskType === "DESIGN") {
    ids.add("planning-intent-contract");
  }
  if (input.taskType === "TEST") {
    ids.add("test-quality-contract");
  }
  if (input.taskType === "REVIEW") {
    ids.add("review-evidence-contract");
  }

  if (isVue) {
    if (failure === "SPEC_CONFLICT") {
      ids.add("vue-test-fixture");
    } else {
      if (input.taskType === "FRONTEND") {
        ids.add("vue-implement");
        ids.add("vue-test-fixture");
      }
      if (input.taskType === "TEST") {
        ids.add("vue-test-fixture");
      }
      if (input.taskType === "DEBUG" || failure === "TEST_FIXTURE_GAP") {
        ids.add("vue-test-fixture");
        ids.add("vue-debug-repair");
      }
    }
  }

  const catalog = loadCatalog();
  return SKILL_ORDER.filter((id) => ids.has(id)).map((id) => {
    const skill = catalog.get(id)!;
    return { id: skill.id, body: skill.body };
  });
}

export function formatInjectedSkillsBlock(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return "";
  const parts = ["## Injected skills", ""];
  for (const skill of skills) {
    parts.push(`### ${skill.id}`, "", skill.body.trim(), "");
  }
  return parts.join("\n").trimEnd();
}

export function withInjectedSkills<T extends { systemInstructions: string }>(
  definition: T,
  input: ResolveSkillsInput
): T {
  const block = formatInjectedSkillsBlock(resolveSkills(input));
  if (!block) return definition;
  return {
    ...definition,
    systemInstructions: `${definition.systemInstructions}\n\n${block}`
  };
}

export function readFailureClassFromTask(task: {
  input?: Record<string, unknown> | undefined;
  output?: Record<string, unknown> | undefined;
}): string | undefined {
  const fromInput = task.input?.failureClass;
  if (typeof fromInput === "string" && fromInput.length > 0) return fromInput;
  const fromOutput = task.output?.failureClass;
  if (typeof fromOutput === "string" && fromOutput.length > 0) return fromOutput;
  return undefined;
}

/**
 * Planning-graph stages that receive `planning-intent-contract`.
 * Professional ANALYSIS / DESIGN still go through `resolveSkills`; these stages
 * are the PlanningAgent requirement → slice → UI spec → task path.
 */
export const PLANNING_GRAPH_CONTRACT_STAGES = [
  "requirement_analysis",
  "slice_planning",
  "ui_spec",
  "task_planning"
] as const;
export type PlanningGraphContractStage = (typeof PLANNING_GRAPH_CONTRACT_STAGES)[number];

/** Load the planning contract from the same SKILL.md that `resolveSkills` uses. */
export function planningIntentContractBlock(): string {
  const skill = getSkill("planning-intent-contract");
  return formatInjectedSkillsBlock([{ id: skill.id, body: skill.body }]);
}

/** Append the planning contract once, keeping the skill file as the policy source. */
export function withPlanningIntentContract(prompt: string): string {
  const block = planningIntentContractBlock();
  if (!block) return prompt;
  if (prompt.includes("### planning-intent-contract")) return prompt;
  return `${prompt}\n\n${block}`;
}
