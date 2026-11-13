import { createHash } from "node:crypto";
import { AcceptanceCriterion } from "@ai-se/shared";

/** N3：AC 文本归一化（折叠空白）——入库、哈希比对共用同一口径。 */
export function normalizeAcceptanceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** F1-4：acKeys 规范键（AC-01 / ac-1 等形态统一为 AC-1）——与验证门 taskCoversAc 同口径。 */
export function canonicalAcKey(key: string): string {
  return key
    .trim()
    .toUpperCase()
    .replace(/^AC-0*(\d+)$/, "AC-$1");
}

/** PL-M7：FR 引用规范键（[FR-001] / fr-7 等形态统一为 FR-7）——acKeys 里的 FR 命名空间。 */
export function canonicalFrKey(key: string): string {
  return key
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim()
    .toUpperCase()
    .replace(/^FR-0*(\d+)$/, "FR-$1");
}

/** N3：AC 文本哈希（sha256 hex）；先归一化空白。 */
export function hashAcceptanceText(text: string): string {
  return createHash("sha256").update(normalizeAcceptanceText(text), "utf8").digest("hex");
}

export interface ParsedAcceptanceCriteria {
  frs: Array<{ id: string; title: string }>;
  acs: AcceptanceCriterion[];
  /** PRD 内重复出现的 AC 编号（保序；解析取首次出现）。 */
  duplicates: string[];
}

const FR_HEADING_PATTERN = /^#{2,4}\s+(FR-\d+)\b\s*(.*)$/;
const ANY_HEADING_PATTERN = /^#{1,6}\s+/;
const AC_KEY_PATTERN = /^AC-\d+$/;

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return [];
  }

  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * N3：PRD 已带编号时的确定性解析（不调 LLM）。
 * 结构约定：`### FR-x <标题>` 分节下、首列为 AC 编号的 Markdown 表格行；非 FR 分节下的表格
 * （如 FR↔AC 速查表）不参与；重复编号取首次出现并记录。
 *
 * N-68（`docs/232` §10）：**行宽 3–5 列都算**。此前只认 E1 的 5 列形态
 * （编号 | 验收标准 | 优先级 | 验证方式 | smoke），而 F1 的 PRD 是 3 列——解析直接返回 0 条，
 * 于是规划回落到库里 `fr_keys` 为空的记录，把**全部 AC 摊给每个切片**（切片分解因此失效）。
 * 缺列按「未声明」处理：`verification=null`、`smoke=false`，与 5 列表的 `-` / 空单元格同义。
 */
export function parseAcceptanceCriteriaFromPrd(markdown: string): ParsedAcceptanceCriteria {
  const frs: Array<{ id: string; title: string }> = [];
  const acs: AcceptanceCriterion[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  let currentFr: string | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const frHeading = line.match(FR_HEADING_PATTERN);
    if (frHeading) {
      currentFr = frHeading[1];
      frs.push({ id: frHeading[1], title: frHeading[2].trim() });
      continue;
    }

    if (ANY_HEADING_PATTERN.test(line)) {
      currentFr = null;
      continue;
    }

    if (!currentFr) {
      continue;
    }

    const cells = tableCells(line);
    if (cells.length < 3 || !AC_KEY_PATTERN.test(cells[0])) {
      continue;
    }

    const [acKey, text, priorityCell, verificationCell = "", smokeCell = ""] = cells;
    if (seen.has(acKey)) {
      duplicates.push(acKey);
      continue;
    }
    seen.add(acKey);

    acs.push({
      acKey,
      text: normalizeAcceptanceText(text),
      priority: priorityCell === "Must" || priorityCell === "Should" ? priorityCell : null,
      verification: verificationCell === "" || verificationCell === "-" ? null : verificationCell,
      smoke: /✅|✔|✓|yes|true/i.test(smokeCell),
      frKeys: [currentFr]
    });
  }

  return { frs, acs, duplicates };
}

export interface AcceptanceCriterionRecordLike {
  acKey: string;
  text: string;
  textHash: string;
}

/**
 * N3 完整性校验：入库 AC 与 PRD 原文一致（归一化空白后哈希比对）。
 * 丢失（库有源无 / 源有库无）或被改写（哈希/文本不符）→ 返回错误列表；空数组 = 通过。
 */
export function verifyAcceptanceCriteriaIntegrity(
  records: AcceptanceCriterionRecordLike[],
  markdown: string
): string[] {
  const errors: string[] = [];
  const parsed = parseAcceptanceCriteriaFromPrd(markdown);

  for (const acKey of parsed.duplicates) {
    errors.push(`Duplicate AC in source document: ${acKey}`);
  }

  const sourceByKey = new Map(parsed.acs.map((ac) => [ac.acKey, ac]));
  const stored = new Set<string>();

  for (const record of records) {
    if (stored.has(record.acKey)) {
      errors.push(`Duplicate stored AC record: ${record.acKey}`);
      continue;
    }
    stored.add(record.acKey);

    const source = sourceByKey.get(record.acKey);
    if (!source) {
      errors.push(`Stored AC missing from source document: ${record.acKey}`);
      continue;
    }
    if (
      record.textHash !== hashAcceptanceText(source.text) ||
      normalizeAcceptanceText(record.text) !== source.text
    ) {
      errors.push(`Stored AC text differs from source document: ${record.acKey}`);
    }
  }

  for (const ac of parsed.acs) {
    if (!stored.has(ac.acKey)) {
      errors.push(`Source AC missing from stored records: ${ac.acKey}`);
    }
  }

  return errors;
}

/**
 * N3：按切片 FR 范围筛选相关 AC（无 FR 关联的 AC 不参与筛选）。
 * F1-4：携带 `isFinalSlice` 时按全局性 AC 归属过滤——非最终切片剔除全局性 AC；
 * 最终切片在 FR 命中项之外**并入全部全局性 AC**（归入最终集成切片收尾任务）。
 * 缺省（undefined）= 既有行为（单级 full / 非切片场景不受影响）。
 */
export function selectAcceptanceCriteriaForSlice<
  T extends { frKeys: string[]; verification?: string | null }
>(acs: T[], frKeys: string[] | undefined, options: { isFinalSlice?: boolean } = {}): T[] {
  const scope = frKeys && frKeys.length > 0 ? new Set(frKeys) : null;
  const base =
    scope === null
      ? [...acs]
      : acs.filter((ac) => ac.frKeys.length === 0 || ac.frKeys.some((key) => scope.has(key)));

  if (options.isFinalSlice === undefined) {
    // 既有行为：不做全局性归属过滤（单级 full / 非切片场景）。
    return base;
  }

  if (options.isFinalSlice === true) {
    // F1-4：全局性 AC 归入最终集成切片收尾任务——即使 FR 不命中也要纳入最终切片范围。
    const result = [...base];
    for (const ac of acs) {
      if (isGlobalAcceptanceCriterion(ac) && !result.includes(ac)) {
        result.push(ac);
      }
    }
    return result;
  }

  // F1-4：非最终切片不得挂全局性 AC（任务若引用，由 GLOBAL_AC_OUTSIDE_FINAL_SLICE 守卫拦截）。
  return base.filter((ac) => !isGlobalAcceptanceCriterion(ac));
}

/**
 * F1-4（发现⑤）：全局性 AC —— 需要完整交付产物或工程文档收尾后才能验证的验收标准。
 * 任务书口径：「验证方式为 Deploy 或 Doc 的 AC」（E1 实例：AC-24/25/26/29=容器运行/容器检查/日志扫描，
 * AC-30=命令执行+测试名解析）。规则由代码判定、不依赖 LLM 自觉；随该口径扩展模式表。
 */
const GLOBAL_VERIFICATION_PATTERNS: RegExp[] = [
  /^deploy/i,
  /^doc/i,
  /容器/,
  /日志扫描/,
  /命令执行/
];

export function isGlobalAcceptanceCriterion(ac: { verification?: string | null }): boolean {
  const verification = (ac.verification ?? "").trim();
  if (verification === "") {
    return false;
  }
  return GLOBAL_VERIFICATION_PATTERNS.some((pattern) => pattern.test(verification));
}
