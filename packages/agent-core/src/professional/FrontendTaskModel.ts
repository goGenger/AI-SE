/**
 * Phase 5.6-2 Repair: deterministic frontend implementation model.
 *
 * This is the TEST/DEMO stand-in for the frontend LLM: it reads the
 * machine-readable task block produced by `buildFrontendAgentTask`, then drives
 * the REAL execution path — ls/read/write through ToolRuntime + Docker
 * Sandbox, then run_build/run_unit_test — inside the existing
 * `ProfessionalAgent` + `DeepAgentLLMProvider` harness. Nothing here executes
 * files itself: every side effect goes through the agent tool loop.
 *
 * It is intentionally reactive: it inspects tool results (component listing,
 * asset listing, write denial, build/test failures) before deciding the next
 * call and the final structured outcome.
 */
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  BaseChatModelCallOptions,
  BindToolsInput
} from "@langchain/core/language_models/chat_models";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { Runnable } from "@langchain/core/runnables";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  FrontendTaskSection,
  FrontendTaskSpec,
  FrontendWorkspaceConventions
} from "./frontendTask";
import { tokenCssVarName } from "./frontendTask";
import type { ProfessionalOutcome } from "./types";

interface MachineTask {
  task: FrontendTaskSpec;
  conventions: FrontendWorkspaceConventions;
  targetPage: { pageSlug: string; pageFile: string };
}

/** role → existing component file the model may reuse. */
const ROLE_COMPONENT_FILE: Readonly<Record<string, string>> = Object.freeze({
  button: "Button",
  input: "Input",
  link: "Link",
  list: "List",
  table: "Table",
  icon: "Icon",
  container: "View",
  other: "View"
});

function contentOf(message: BaseMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function lastToolMessage(messages: BaseMessage[]): ToolMessage | undefined {
  const last = messages[messages.length - 1];
  return ToolMessage.isInstance(last) ? last : undefined;
}

/** "Path is not writable" / "Path is not readable" / hard tool errors. */
function toolFailure(message: BaseMessage | undefined): string | undefined {
  if (!message) return undefined;
  if (message.getType() === "tool") {
    const tool = message as ToolMessage;
    const text = contentOf(tool);
    if (tool.status === "error") return text;
    if (text.includes("is not writable")) return text;
    if (text.includes("is not readable")) return text;
  }
  return undefined;
}

/** ls output is one path per line (`/apps/web/src/components/Button.js`). */
function listedFileNames(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => path.posix.basename(line))
    .sort();
}

function pascalCase(slug: string): string {
  return slug
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

export interface FrontendTaskModelOptions {
  /** Optional fixed outcome override (debug); default is derived from results. */
  outcome?: ProfessionalOutcome;
}

export class FrontendTaskModel extends BaseChatModel<BaseChatModelCallOptions> {
  static lc_name(): string {
    return "ChatOpenAI";
  }

  private machine?: MachineTask;
  private step = 0;
  private componentFiles: string[] = [];
  private assetFiles: string[] = [];
  private reusedComponents: string[] = [];
  private missingComponents: string[] = [];
  private writtenPage = false;
  private buildCommand = "";
  private testCommand = "";
  private readonly override?: ProfessionalOutcome;

  constructor(options: FrontendTaskModelOptions = {}) {
    super({});
    this.override = options.outcome;
  }

  _llmType(): string {
    return "ai-se-frontend-task";
  }

  bindTools(
    _tools: BindToolsInput[]
  ): Runnable<
    unknown,
    import("@langchain/core/messages").AIMessageChunk,
    BaseChatModelCallOptions
  > {
    return this as unknown as Runnable<
      unknown,
      import("@langchain/core/messages").AIMessageChunk,
      BaseChatModelCallOptions
    >;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const parse = (): MachineTask | undefined => {
      if (this.machine) return this.machine;
      const text = messages
        .filter((message) => message.getType() === "human")
        .map((message) => contentOf(message))
        .join("\n");
      const match = /<ai-se-frontend-task>\s*([\s\S]*?)\s*<\/ai-se-frontend-task>/.exec(text);
      if (!match?.[1]) return undefined;
      try {
        this.machine = JSON.parse(match[1].replaceAll("<\\/", "</")) as MachineTask;
      } catch {
        this.machine = undefined;
      }
      return this.machine;
    };

    const emitTool = (toolName: string, input: Record<string, unknown>): ChatResult => ({
      generations: [
        {
          text: "",
          message: new AIMessage({
            content: "",
            tool_calls: [{ id: randomUUID(), name: toolName, args: input, type: "tool_call" }]
          })
        }
      ]
    });
    const emitOutcome = (outcome: ProfessionalOutcome): ChatResult => ({
      generations: [
        { text: "", message: new AIMessage({ content: JSON.stringify(outcome) }) }
      ]
    });
    const failed = (summary: string, description: string): ProfessionalOutcome => ({
      status: "FAILED",
      summary,
      artifacts: [],
      issues: [
        {
          severity: "HIGH",
          file: this.machine?.targetPage.pageFile,
          description,
          recommendation: "Fix the blocking error and rerun the frontend task."
        }
      ],
      recommendations: [],
      metadata: { errorType: "FRONTEND_TASK_FAILED" }
    });

    if (this.override) return emitOutcome(this.override);

    // Reactive failure handling: inspect the latest tool result before the
    // next action. A denied write or a failed build/test ends the run.
    const failure = toolFailure(lastToolMessage(messages));
    if (failure) {
      return emitOutcome(failed("Frontend task stopped on a tool failure.", failure));
    }
    const lastTool = lastToolMessage(messages);

    const task = parse();
    if (!task) {
      return emitOutcome(
        failed(
          "Frontend task machine block not found.",
          "The task text must contain an <ai-se-frontend-task> JSON block (see buildFrontendAgentTask)."
        )
      );
    }
    const section = task.task.instructions.sections[0];

    switch (this.step) {
      case 0:
        this.step = 1;
        return emitTool("ls", { path: task.conventions.componentsDir });
      case 1: {
        this.componentFiles = listedFileNames(contentOf(lastTool));
        this.step = 2;
        return emitTool("ls", { path: task.conventions.assetsDir });
      }
      case 2: {
        this.assetFiles = listedFileNames(contentOf(lastTool));
        this.step = 3;
        return emitTool("read_file", { file_path: task.conventions.tokensFile });
      }
      case 3: {
        const candidate = this.firstReusableComponent(section);
        if (candidate) {
          this.step = 4;
          return emitTool("read_file", {
            file_path: `${task.conventions.componentsDir}/${candidate}.js`
          });
        }
        this.step = 5;
        return this.writeStep(task, section);
      }
      case 4: {
        this.markReuse(section);
        this.step = 5;
        return this.writeStep(task, section);
      }
      case 5: {
        this.step = 6;
        return emitTool("run_build", {
          command: this.buildCommand || task.conventions.buildCommand,
          cwd: task.conventions.appRoot
        });
      }
      case 6: {
        this.step = 7;
        return emitTool("run_unit_test", {
          command: this.testCommand || task.conventions.testCommand,
          cwd: task.conventions.appRoot
        });
      }
      default:
        return emitOutcome(this.successOutcome(task, section));
    }
  }

  private firstReusableComponent(section: FrontendTaskSection): string | undefined {
    for (const element of section.elements) {
      const candidate = ROLE_COMPONENT_FILE[element.role];
      if (candidate && this.componentFiles.includes(`${candidate}.js`)) return candidate;
    }
    return section.componentHint && this.componentFiles.includes(`${section.componentHint}.js`)
      ? section.componentHint
      : undefined;
  }

  private markReuse(section: FrontendTaskSection): void {
    const names = new Set(this.reusedComponents);
    for (const element of section.elements) {
      const candidate = ROLE_COMPONENT_FILE[element.role];
      if (candidate && this.componentFiles.includes(`${candidate}.js`)) names.add(candidate);
      else if (candidate) this.recordMissing(candidate);
    }
    this.reusedComponents = [...names].sort();
  }

  private recordMissing(name: string): void {
    if (!this.missingComponents.includes(name)) this.missingComponents.push(name);
  }

  /** Builds the page module source from the task data (no hardcoded values). */
  private buildPageSource(task: MachineTask, section: FrontendTaskSection): string {
    const relative = (to: string): string =>
      path.posix.relative(path.posix.dirname(task.targetPage.pageFile), to);
    const componentsRel = relative(task.conventions.componentsDir);
    const assetsRel = relative(task.conventions.assetsDir);
    const imageAsset = this.assetFiles.find((file) => /\.(svg|png|jpg|jpeg|webp)$/i.test(file));

    const imports = new Set<string>();
    const body: string[] = [];
    for (const element of section.elements) {
      const candidate = ROLE_COMPONENT_FILE[element.role];
      if (element.role === "image") {
        if (imageAsset) {
          body.push(
            `    <img data-element-id="${element.id}" src="${assetsRel}/${imageAsset}" alt="${element.description}" />`
          );
        } else {
          body.push(
            `    <span data-element-id="${element.id}" data-missing-asset="true">${element.description}</span>`
          );
        }
        continue;
      }
      if (candidate && this.componentFiles.includes(`${candidate}.js`)) {
        imports.add(candidate);
        const prop = element.role === "input" ? "placeholder" : "label";
        body.push(`    \${${candidate}({ ${prop}: ${jsString(element.description)} })}`);
        continue;
      }
      if (candidate) {
        this.recordMissing(candidate);
        body.push(
          `    <span data-element-id="${element.id}" data-missing-component="${candidate}">${element.description}</span>`
        );
        continue;
      }
      body.push(`    <p data-element-id="${element.id}">${element.description}</p>`);
    }

    const tokenVars = section.styleTokens.map((token) => ({
      cssVar: tokenCssVarName(token),
      value: token.value
    }));
    const first = (namespace: string): string | undefined =>
      tokenVars.find((token) => token.cssVar.startsWith(`--${namespace}-`))?.cssVar;
    const styleParts = [
      `min-height: ${section.rect.height}px`,
      ...(first("colors") ? [`color: var(${first("colors")})`] : []),
      ...(first("typography") ? [`font-size: var(${first("typography")})`] : []),
      ...(first("radii") ? [`border-radius: var(${first("radii")})`] : [])
    ];

    const renderName = `render${pascalCase(task.targetPage.pageSlug)}`;
    return [
      `/* Generated by the ai-se frontend agent for ${task.task.taskKey}. */`,
      ...[...imports].sort().map((name) => `import { ${name} } from "${componentsRel}/${name}.js";`),
      ...(imports.size > 0 ? [""] : []),
      `export function ${renderName}() {`,
      "  return `",
      `  <section class="visual-section" data-section-id="${section.sectionId}" data-rect="${section.rect.x},${section.rect.y},${section.rect.width},${section.rect.height}" style="${styleParts.join("; ")};">`,
      `    <h2>${section.title}</h2>`,
      ...body,
      "  </section>`;",
      "}",
      ""
    ].join("\n");
  }

  private writeStep(task: MachineTask, section: FrontendTaskSection): ChatResult {
    this.markReuse(section);
    this.writtenPage = true;
    return {
      generations: [
        {
          text: "",
          message: new AIMessage({
            content: "",
            tool_calls: [
              {
                id: randomUUID(),
                name: "write_file",
                args: {
                  file_path: task.targetPage.pageFile,
                  content: this.buildPageSource(task, section)
                },
                type: "tool_call"
              }
            ]
          })
        }
      ]
    };
  }

  private successOutcome(task: MachineTask, section: FrontendTaskSection): ProfessionalOutcome {
    return {
      status: "SUCCESS",
      summary: `Implemented ${task.targetPage.pageFile} for ${task.task.taskKey}; build and tests passed.`,
      artifacts: [
        {
          type: "GENERATED_FILE",
          name: task.targetPage.pageFile,
          content: { taskKey: task.task.taskKey, sectionId: section.sectionId }
        },
        {
          type: "BUILD_RESULT",
          name: task.conventions.buildCommand,
          content: { command: task.conventions.buildCommand, cwd: task.conventions.appRoot }
        },
        {
          type: "TEST_RESULT",
          name: task.conventions.testCommand,
          content: { command: task.conventions.testCommand, cwd: task.conventions.appRoot }
        }
      ],
      issues: this.missingComponents.map((component) => ({
        severity: "LOW" as const,
        file: task.conventions.componentsDir,
        description: `No component file ${component}.js found for a carried role; implemented with semantic HTML.`,
        recommendation: `Create ${component} in the project component library when the role is reused.`
      })),
      recommendations: [],
      metadata: {
        reusedComponents: this.reusedComponents,
        missingComponents: this.missingComponents,
        tokensUsed: section.styleTokens.map((token) => tokenCssVarName(token)),
        targetPage: task.targetPage.pageFile,
        wrotePage: this.writtenPage
      }
    };
  }
}
