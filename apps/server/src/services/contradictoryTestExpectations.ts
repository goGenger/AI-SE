/**
 * 生成测试互斥期望门禁（确定性、零 LLM）。
 *
 * 背景（F1 round18）：agent 在同一 `test`/`it` 块里对同一查询（如 `titles(wrapper)`）
 * 先 `toEqual` 全量列表、再 `toEqual` 筛选子集，中间没有状态变更——产品按筛选生效是对的，
 * CI 却红（Oracle 绿 / CI 假阴性）。这条门禁在 `LocalCiOperations.runCi` 跑 `pnpm test`
 * **之前**静态扫工作区，早停并给出明确错误码，避免整轮烧在假阴性上。
 *
 * 规则（宁可窄而准）：
 * - 只看 `*.{spec,test}.{ts,tsx,js,jsx,mjs,cjs}`；
 * - 同一用例体内，按「状态变更」切段（await / click / setValue / `.value =` / setX() / resolve 等）；
 * - 同一段内，同一 `expect(subject)` 出现互斥的 `toEqual` / `toStrictEqual` / `toHaveLength`
 *   （不同长度，或同长度但字面量内容不同）→ `CONTRADICTORY_TEST_EXPECTATIONS`；
 * - 合法的「先空态再填充 / 先全量再点筛选 / 多次 keyword.value= 或 setFilter()」因中间有状态边界，不会误杀。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const CONTRADICTORY_TEST_EXPECTATIONS = "CONTRADICTORY_TEST_EXPECTATIONS" as const;

export interface ContradictoryTestFinding {
  code: typeof CONTRADICTORY_TEST_EXPECTATIONS;
  file: string;
  testName: string;
  subject: string;
  detail: string;
  line: number;
}

export interface ContradictoryTestScanResult {
  findings: ContradictoryTestFinding[];
  scannedFiles: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".vite",
  ".turbo",
  ".next",
  "build"
]);

const TEST_FILE_RE = /\.(?:spec|test)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/** 段边界：这些语句可能改变被断言的 UI / mock 状态。 */
const STATE_BOUNDARY_RE =
  /\bawait\b|\.trigger\s*\(|\.setValue\s*\(|\.type\s*\(|clickFilter\s*\(|typeSearch\s*\(|fireEvent\.|\.emit\s*\(|pending\.resolve\b|\.mockResolvedValue|\.mockReturnValue|wrapper\.unmount\s*\(|\.click\s*\(|\.value\s*=|\bset[A-Z]\w*\s*\(/;

interface Expectation {
  subject: string;
  kind: "equal" | "length";
  /** 规范化后的期望摘要（长度或 JSON）。 */
  summary: string;
  length: number | null;
  line: number;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

/** 去掉行注释与块注释，保留换行以便行号大致可用。 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      out += "  ";
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    // 字符串：原样跳过，避免注释误伤
    if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      out += quote;
      i += 1;
      while (i < source.length) {
        const ch = source[i];
        out += ch;
        if (ch === "\\" && i + 1 < source.length) {
          out += source[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (ch === quote) break;
      }
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 解析顶层 `const NAME = [ ... ]`（仅一层数组字面量），供 toEqual(IDENT) 解长度。 */
export function parseConstArrays(source: string): Map<string, { length: number; raw: string }> {
  const map = new Map<string, { length: number; raw: string }>();
  const cleaned = stripComments(source);
  const re = /\bconst\s+([A-Za-z_][\w]*)\s*=\s*(\[[\s\S]*?\])/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned)) !== null) {
    const name = match[1];
    const raw = match[2];
    try {
      const value = Function(`"use strict"; return (${raw});`)() as unknown;
      if (Array.isArray(value)) {
        map.set(name, { length: value.length, raw: JSON.stringify(value) });
      }
    } catch {
      // 含标识符/表达式的数组跳过
    }
  }
  return map;
}

function parseExpected(
  matcher: string,
  arg: string,
  consts: Map<string, { length: number; raw: string }>
): { kind: "equal" | "length"; summary: string; length: number | null } | null {
  const trimmed = arg.trim();
  if (matcher === "toHaveLength") {
    if (!/^\d+$/.test(trimmed)) return null;
    const length = Number(trimmed);
    return { kind: "length", summary: `length=${length}`, length };
  }
  if (trimmed.startsWith("[")) {
    try {
      const value = Function(`"use strict"; return (${trimmed});`)() as unknown;
      if (!Array.isArray(value)) return null;
      return {
        kind: "equal",
        summary: JSON.stringify(value),
        length: value.length
      };
    } catch {
      return null;
    }
  }
  const ident = /^[A-Za-z_][\w]*$/.exec(trimmed);
  if (ident) {
    const hit = consts.get(ident[0]);
    if (!hit) return null;
    return { kind: "equal", summary: hit.raw, length: hit.length };
  }
  return null;
}

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\" && i + 1 < source.length) {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\" && i + 1 < source.length) {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

interface TestBlock {
  name: string;
  body: string;
  bodyStart: number;
}

/** 抽出 test/it 回调体（含 test.only 等）。回调在调用参数里，不在调用括号外。 */
export function extractTestBlocks(source: string): TestBlock[] {
  const cleaned = stripComments(source);
  const blocks: TestBlock[] = [];
  const startRe = /\b(test|it)(?:\.(?:only|skip|todo|concurrent))?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = startRe.exec(cleaned)) !== null) {
    const callOpen = match.index + match[0].length - 1;
    const callClose = findMatchingParen(cleaned, callOpen);
    if (callClose < 0) continue;
    const callInner = cleaned.slice(callOpen + 1, callClose);
    const nameMatch = /^\s*(['"`])([\s\S]*?)\1/.exec(callInner);
    const name = nameMatch ? nameMatch[2].replace(/\s+/g, " ").trim() : "(unnamed)";
    // 第二个参数：async () => { ... } / () => { ... } / function () { ... }
    const arrow = /(?:,\s*)(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][\w]*)\s*=>\s*\{/.exec(callInner);
    const fn = /(?:,\s*)(?:async\s+)?function\b[^{]*\{/.exec(callInner);
    const hit = arrow ?? fn;
    if (!hit) {
      startRe.lastIndex = callClose + 1;
      continue;
    }
    const braceOpenInInner = hit.index + hit[0].lastIndexOf("{");
    const braceOpen = callOpen + 1 + braceOpenInInner;
    const braceClose = findMatchingBrace(cleaned, braceOpen);
    if (braceClose < 0 || braceClose > callClose) {
      startRe.lastIndex = callClose + 1;
      continue;
    }
    blocks.push({
      name,
      body: cleaned.slice(braceOpen + 1, braceClose),
      bodyStart: braceOpen + 1
    });
    startRe.lastIndex = callClose + 1;
  }
  return blocks;
}

function splitSegments(body: string): string[] {
  const segments: string[] = [];
  let start = 0;
  const lines = body.split(/(?<=\n)/);
  let offset = 0;
  for (const line of lines) {
    if (STATE_BOUNDARY_RE.test(line) && offset > start) {
      segments.push(body.slice(start, offset));
      start = offset;
    }
    offset += line.length;
  }
  segments.push(body.slice(start));
  return segments.filter((segment) => segment.trim().length > 0);
}

function readMatcherCall(
  source: string,
  from: number
): { matcher: string; negated: boolean; arg: string; end: number } | null {
  let i = from;
  while (i < source.length && /\s/.test(source[i]!)) i += 1;
  if (source[i] !== ".") return null;
  i += 1;
  while (i < source.length && /\s/.test(source[i]!)) i += 1;
  let negated = false;
  if (source.slice(i, i + 3) === "not") {
    negated = true;
    i += 3;
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    if (source[i] !== ".") return null;
    i += 1;
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
  }
  const matcherMatch = /^(toEqual|toStrictEqual|toHaveLength)\b/.exec(source.slice(i));
  if (!matcherMatch) return null;
  const matcher = matcherMatch[1]!;
  i += matcher.length;
  while (i < source.length && /\s/.test(source[i]!)) i += 1;
  if (source[i] !== "(") return null;
  const close = findMatchingParen(source, i);
  if (close < 0) return null;
  return { matcher, negated, arg: source.slice(i + 1, close), end: close + 1 };
}

function collectExpectations(
  segment: string,
  segmentBaseIndex: number,
  fullSource: string,
  consts: Map<string, { length: number; raw: string }>
): Expectation[] {
  const out: Expectation[] = [];
  const startRe = /\bexpect\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = startRe.exec(segment)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = findMatchingParen(segment, open);
    if (close < 0) continue;
    const subject = normalizeWs(segment.slice(open + 1, close));
    const call = readMatcherCall(segment, close + 1);
    if (!call || call.negated) {
      startRe.lastIndex = close + 1;
      continue;
    }
    const parsed = parseExpected(call.matcher, call.arg, consts);
    if (!parsed) {
      startRe.lastIndex = call.end;
      continue;
    }
    out.push({
      subject,
      kind: parsed.kind,
      summary: parsed.summary,
      length: parsed.length,
      line: lineAt(fullSource, segmentBaseIndex + match.index)
    });
    startRe.lastIndex = call.end;
  }
  return out;
}

function incompatible(a: Expectation, b: Expectation): string | null {
  if (a.summary === b.summary) return null;
  if (a.length !== null && b.length !== null && a.length !== b.length) {
    return `same subject expected length ${a.length} then ${b.length} with no state change between`;
  }
  if (a.kind === "equal" && b.kind === "equal" && a.summary !== b.summary) {
    return `same subject toEqual ${a.summary} then ${b.summary} with no state change between`;
  }
  return null;
}

/**
 * 分析单个测试源文件文本，返回互斥期望发现（file 字段由调用方补）。
 */
export function analyzeTestSource(
  source: string,
  file = "<memory>"
): ContradictoryTestFinding[] {
  const consts = parseConstArrays(source);
  const findings: ContradictoryTestFinding[] = [];
  for (const block of extractTestBlocks(source)) {
    let cursor = block.bodyStart;
    for (const segment of splitSegments(block.body)) {
      const segmentIndex = block.body.indexOf(segment, cursor - block.bodyStart);
      const absoluteStart =
        segmentIndex >= 0 ? block.bodyStart + segmentIndex : cursor;
      const expectations = collectExpectations(segment, absoluteStart, source, consts);
      const bySubject = new Map<string, Expectation[]>();
      for (const expectation of expectations) {
        const list = bySubject.get(expectation.subject) ?? [];
        list.push(expectation);
        bySubject.set(expectation.subject, list);
      }
      for (const [subject, list] of bySubject) {
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const reason = incompatible(list[i], list[j]);
            if (!reason) continue;
            findings.push({
              code: CONTRADICTORY_TEST_EXPECTATIONS,
              file,
              testName: block.name,
              subject,
              detail: reason,
              line: list[j].line
            });
          }
        }
      }
      cursor = absoluteStart + segment.length;
    }
  }
  return findings;
}

function walkTestFiles(root: string, dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTestFiles(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!TEST_FILE_RE.test(entry.name)) continue;
    out.push(full);
  }
}

/** 扫描工作区测试文件；失败只汇总 findings，不抛。 */
export function scanContradictoryTestExpectations(
  workspacePath: string
): ContradictoryTestScanResult {
  let rootStat;
  try {
    rootStat = statSync(workspacePath);
  } catch {
    return { findings: [], scannedFiles: 0 };
  }
  if (!rootStat.isDirectory()) return { findings: [], scannedFiles: 0 };

  const files: string[] = [];
  walkTestFiles(workspacePath, workspacePath, files);
  const findings: ContradictoryTestFinding[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(workspacePath, file).replace(/\\/g, "/");
    findings.push(...analyzeTestSource(text, rel));
  }
  return { findings, scannedFiles: files.length };
}

/** 供 CI 日志 / error 字段使用的短摘要。 */
export function formatContradictoryTestFindings(
  findings: ContradictoryTestFinding[],
  limit = 8
): string {
  return findings
    .slice(0, limit)
    .map(
      (finding) =>
        `${finding.file}:${finding.line} [${finding.testName}] subject=${finding.subject}: ${finding.detail}`
    )
    .join("\n");
}

/**
 * 门禁 P1：CI 失败信息若含互斥期望码，给出 REPLAN 改测提示（fixTaskType=TEST）。
 * DeliveryOrchestrator 写入任务 output；WorkflowEngine.replan 用派发键造 DEBUG→再重跑 CI。
 */
export function contradictoryCiReplanHint(errorMessage: string):
  | { fixTaskType: "TEST"; errorType: typeof CONTRADICTORY_TEST_EXPECTATIONS }
  | undefined {
  if (!errorMessage.includes(CONTRADICTORY_TEST_EXPECTATIONS)) return undefined;
  return { fixTaskType: "TEST", errorType: CONTRADICTORY_TEST_EXPECTATIONS };
}

