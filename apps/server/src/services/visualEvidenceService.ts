import { BrowserSession, type PlaywrightLike } from "@ai-se/browser";
import { extname, isAbsolute, join } from "node:path";

/**
 * 功能清点 T3（`docs/231` §4）：UI 交付物的**截图证据**。
 *
 * 这一层只做「看得到」的部分：把任务写出来的页面在真实 Chromium 里打开、等渲染稳定、
 * 截图、记录控制台与网络错误。它是**附加证据**，不参与验证门的判据（§4.2c），
 * 也绝不阻断任务——取证失败只记 `unavailable`。
 *
 * **为什么不是完整的视觉修复闭环**：`runVisualFixLoop`（`visualFixLoop.ts:182`）的输入是
 * 「候选截图 vs **参照**截图」两侧的 VLM 分析。候选侧可以现算，**参照侧没有任何生产来源**
 * ——产品里没有上传设计稿的入口，`VisualSpecification` 在仓库里也只由测试构造。
 * 于是闭环在「比较」这一步就无以为继，硬接只会得到一条永远 `unavailable` 的路径。
 * 本阶段据此只接取证那一半，并把原因写进事件与文档（见 `docs/232` §T3）。
 */

/** 视为「UI 交付物」的扩展名。 */
const UI_EXTENSIONS = new Set([".html", ".htm", ".vue", ".tsx", ".jsx", ".css", ".scss"]);

/** 只有这些扩展名能当**入口页**——组件与样式文件本身不能直接渲染。 */
const PAGE_EXTENSIONS = new Set([".html", ".htm"]);

/** 截图体积上限：超过就只留元数据，避免把库撑大。 */
const MAX_STORED_BYTES = 1_500_000;

export type VisualEvidenceOutcome =
  | {
      status: "captured";
      entry: string;
      assetRef: string;
      bytes: number;
      storedBytes: boolean;
      base64: string;
      consoleErrors: number;
      networkErrors: number;
      settled: "networkidle" | "timeout";
      viewport: { width: number; height: number };
    }
  | {
      status: "unavailable";
      reason:
        | "no-ui-deliverable"
        | "no-entry-page"
        | "browser-failed"
        | "visual-review-without-reference";
      detail?: string;
    };

export interface VisualEvidenceInput {
  workspacePath: string;
  /** 本任务实际写入的路径（绝对或相对工作区）。 */
  writtenPaths: string[];
}

export interface VisualEvidenceOptions {
  playwright: PlaywrightLike;
  viewport?: { width: number; height: number };
}

export function isUiDeliverable(path: string): boolean {
  return UI_EXTENSIONS.has(extname(path).toLowerCase());
}

// ── 基线回归（用户 2026-10-23 裁定 ②） ──────────────────────────────────────

/** 参与比较的客观指标：全部来自截图那一刻，不需要 VLM。 */
export interface VisualMetrics {
  consoleErrors: number;
  networkErrors: number;
  settled: "networkidle" | "timeout";
  bytes: number;
}

export type VisualRegressionSignal =
  | "render-no-longer-settles"
  | "console-errors-increased"
  | "network-errors-increased"
  | "screenshot-empty";

export interface VisualRegressionResult {
  regressed: boolean;
  signals: VisualRegressionSignal[];
  baseline: VisualMetrics;
  candidate: VisualMetrics;
}

/**
 * 候选截图 vs 基线截图的**客观**回归判定。
 *
 * 为什么不用 VLM 比对：产品里没有设计参照（`docs/232` §T3-2），而拿 VLM 给同一张图
 * 打两次分本身也不稳定。这里只回答「比上次更糟了吗」——渲染不再收敛、控制台/网络错误变多、
 * 截图为空。这些都是确定性信号，误报率可控。
 *
 * 只把「变多」算回归：错误变少或持平都算正常（页面可能在改进）。
 */
export function compareVisualEvidence(
  baseline: VisualMetrics,
  candidate: VisualMetrics
): VisualRegressionResult {
  const signals: VisualRegressionSignal[] = [];
  if (candidate.bytes <= 0) {
    signals.push("screenshot-empty");
  }
  if (baseline.settled === "networkidle" && candidate.settled === "timeout") {
    signals.push("render-no-longer-settles");
  }
  if (candidate.consoleErrors > baseline.consoleErrors) {
    signals.push("console-errors-increased");
  }
  if (candidate.networkErrors > baseline.networkErrors) {
    signals.push("network-errors-increased");
  }
  return { regressed: signals.length > 0, signals, baseline, candidate };
}

/**
 * 选入口页：优先工作区根的 `index.html`，否则取本任务写出的第一个 `.html`。
 * 都没有就只能报 `no-entry-page`——组件文件渲染不出页面。
 */
export function resolveEntryPage(
  workspacePath: string,
  writtenPaths: string[]
): string | undefined {
  const written = writtenPaths.filter((path) => PAGE_EXTENSIONS.has(extname(path).toLowerCase()));
  const rootIndex = join(workspacePath, "index.html");
  const hasRootIndex = written.some((path) => resolvePath(workspacePath, path) === rootIndex);
  if (hasRootIndex) return rootIndex;
  const first = written[0];
  return first === undefined ? undefined : resolvePath(workspacePath, first);
}

function resolvePath(workspacePath: string, path: string): string {
  return isAbsolute(path) ? path : join(workspacePath, path);
}

export class VisualEvidenceService {
  constructor(private readonly options: VisualEvidenceOptions) {}

  async capture(input: VisualEvidenceInput): Promise<VisualEvidenceOutcome> {
    if (!input.writtenPaths.some(isUiDeliverable)) {
      return { status: "unavailable", reason: "no-ui-deliverable" };
    }
    const entry = resolveEntryPage(input.workspacePath, input.writtenPaths);
    if (!entry) {
      return { status: "unavailable", reason: "no-entry-page" };
    }

    const viewport = this.options.viewport ?? { width: 1440, height: 900 };
    const session = new BrowserSession({
      playwright: this.options.playwright,
      // 最小权限：这次会话只允许 file:，不给 http/https。
      navigateAllowlist: { allowedProtocols: ["file"] },
      headless: true
    });

    try {
      await session.launch();
      await session.setViewport(viewport.width, viewport.height);
      await session.goto(`file://${entry}`);
      const rendered = await session.waitForRender();
      const shot = await session.screenshot();
      return {
        status: "captured",
        entry,
        assetRef: session.assetRefFor(shot),
        bytes: shot.buffer.length,
        storedBytes: shot.buffer.length <= MAX_STORED_BYTES,
        base64: shot.base64,
        consoleErrors: shot.consoleErrorCountSinceLast,
        networkErrors: shot.networkErrorCountSinceLast,
        settled: rendered.settled,
        viewport
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: "browser-failed",
        detail: error instanceof Error ? error.message : String(error)
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  }
}
