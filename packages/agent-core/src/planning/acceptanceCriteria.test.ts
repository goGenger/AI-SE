import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashAcceptanceText,
  parseAcceptanceCriteriaFromPrd,
  selectAcceptanceCriteriaForSlice,
  verifyAcceptanceCriteriaIntegrity
} from "./acceptanceCriteria";

/** 夹具路径（vitest 以包目录为 cwd；兜底仓库根）。缺失时仅本文件失败。 */
function readFixturePrd(fixture: "E1" | "F1"): string {
  const candidates = [
    resolve(process.cwd(), `../eval/fixtures/${fixture}/prd.md`),
    resolve(process.cwd(), `packages/eval/fixtures/${fixture}/prd.md`)
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8");
    }
  }
  throw new Error(`${fixture} fixture PRD not found (cwd=${process.cwd()})`);
}

function readE1Prd(): string {
  return readFixturePrd("E1");
}

const e1Prd = readE1Prd();

describe("parseAcceptanceCriteriaFromPrd（N3 / E1 形态确定性解析）", () => {
  it("解析 E1 PRD：9 FR / 30 AC，编号、优先级、验证方式、smoke、FR 关联齐全", () => {
    const parsed = parseAcceptanceCriteriaFromPrd(e1Prd);

    expect(parsed.duplicates).toEqual([]);
    expect(parsed.frs.map((fr) => fr.id)).toEqual([
      "FR-1",
      "FR-2",
      "FR-3",
      "FR-4",
      "FR-5",
      "FR-6",
      "FR-7",
      "FR-8",
      "FR-9"
    ]);
    expect(parsed.acs).toHaveLength(30);

    const keys = parsed.acs.map((ac) => ac.acKey);
    expect(new Set(keys).size).toBe(30);
    expect(keys).toContain("AC-01");
    expect(keys).toContain("AC-30");

    const ac22 = parsed.acs.find((ac) => ac.acKey === "AC-22");
    expect(ac22).toMatchObject({
      priority: "Should",
      smoke: false,
      verification: "浏览器（可选）",
      frKeys: ["FR-8"]
    });
    const ac30 = parsed.acs.find((ac) => ac.acKey === "AC-30");
    expect(ac30).toMatchObject({ priority: "Must", frKeys: ["FR-9"] });

    // smoke 标记只出现在表明态的行上；非 smoke 行不得误标。
    const smokeKeys = parsed.acs.filter((ac) => ac.smoke).map((ac) => ac.acKey);
    expect(smokeKeys.length).toBeGreaterThan(0);
    expect(smokeKeys).not.toContain("AC-22");

    // 每个 AC 都必须关联到 FR（E1 形态）。
    for (const ac of parsed.acs) {
      expect(ac.frKeys).toHaveLength(1);
    }
  });

  it("无编号形态（无 FR 分节表格）→ 解析为空", () => {
    const parsed = parseAcceptanceCriteriaFromPrd("# 需求\n\n没有编号验收标准。\n");
    expect(parsed.frs).toEqual([]);
    expect(parsed.acs).toEqual([]);
  });

  it("速查表（FR↔AC）不参与解析；重复编号取首次并记录", () => {
    const markdown = [
      "| FR | AC |",
      "| --- | --- |",
      "| FR-1 用户注册 | AC-01、AC-02 |",
      "",
      "### FR-1 用户注册",
      "",
      "| 编号 | 验收标准 | 优先级 | 验证方式 | smoke |",
      "| --- | --- | --- | --- | --- |",
      "| AC-01 | 注册成功返回 201 | Must | HTTP 断言 | ✅ |",
      "| AC-01 | 重复编号 | Must | HTTP 断言 | |",
      "| AC-02 | 重复用户名返回 409 | Must | HTTP 断言 | |"
    ].join("\n");

    const parsed = parseAcceptanceCriteriaFromPrd(markdown);
    expect(parsed.frs).toEqual([{ id: "FR-1", title: "用户注册" }]);
    expect(parsed.acs.map((ac) => ac.acKey)).toEqual(["AC-01", "AC-02"]);
    expect(parsed.acs[0]).toMatchObject({ text: "注册成功返回 201", smoke: true });
    expect(parsed.duplicates).toEqual(["AC-01"]);
  });

  /**
   * N-68（`docs/232` §10）：**3 列表也要解析**。
   *
   * 此前只认 5 列，而 F1 的 PRD 是「编号 | 验收标准 | 优先级」三列 ⇒ 解析恒为 0 条 ⇒ 规划回落到
   * 库里 `fr_keys` 为空的记录 ⇒ 每个切片都被要求覆盖全部 AC（切片分解失效）。
   */
  describe("N-68：3 列表形态", () => {
    it("解析 F1 PRD：5 FR / 24 AC，每条都带自己小节的 frKeys", () => {
      const parsed = parseAcceptanceCriteriaFromPrd(readFixturePrd("F1"));

      expect(parsed.duplicates).toEqual([]);
      expect(parsed.frs.map((fr) => fr.id)).toEqual(["FR-1", "FR-2", "FR-3", "FR-4", "FR-5"]);
      expect(parsed.acs).toHaveLength(24);
      expect(parsed.acs.map((ac) => ac.acKey)).toContain("AC-24");

      expect(parsed.acs.find((ac) => ac.acKey === "AC-08")).toMatchObject({
        priority: "Must",
        verification: null,
        smoke: false,
        frKeys: ["FR-2"]
      });
      expect(parsed.acs.find((ac) => ac.acKey === "AC-18")).toMatchObject({
        priority: "Must",
        frKeys: ["FR-4"]
      });
      expect(parsed.acs.find((ac) => ac.acKey === "AC-21")).toMatchObject({
        priority: "Should",
        frKeys: ["FR-5"]
      });

      // 缺列不等于失联：每条 AC 都必须落在自己的 FR 上。
      for (const ac of parsed.acs) {
        expect(ac.frKeys, ac.acKey).toHaveLength(1);
      }
    });

    it("4 列表：第 4 列按验证方式解析，smoke 缺省 false", () => {
      const markdown = [
        "### FR-1 注册",
        "",
        "| 编号 | 验收标准 | 优先级 | 验证方式 |",
        "| --- | --- | --- | --- |",
        "| AC-01 | 注册成功返回 201 | Must | HTTP 断言 |"
      ].join("\n");

      const parsed = parseAcceptanceCriteriaFromPrd(markdown);
      expect(parsed.acs).toEqual([
        {
          acKey: "AC-01",
          text: "注册成功返回 201",
          priority: "Must",
          verification: "HTTP 断言",
          smoke: false,
          frKeys: ["FR-1"]
        }
      ]);
    });

    it("少于 3 列不解析（编号+文本不足以判定优先级）", () => {
      const markdown = [
        "### FR-1 注册",
        "",
        "| 编号 | 验收标准 |",
        "| --- | --- |",
        "| AC-01 | 注册成功返回 201 |"
      ].join("\n");

      expect(parseAcceptanceCriteriaFromPrd(markdown).acs).toEqual([]);
    });
  });
});

describe("verifyAcceptanceCriteriaIntegrity（N3 哈希完整性）", () => {
  it("入库记录与 PRD 原文一致（归一化空白后哈希比对通过）", () => {
    const parsed = parseAcceptanceCriteriaFromPrd(e1Prd);
    const records = parsed.acs.map((ac) => ({
      acKey: ac.acKey,
      text: ac.text,
      textHash: hashAcceptanceText(ac.text)
    }));

    expect(verifyAcceptanceCriteriaIntegrity(records, e1Prd)).toEqual([]);
  });

  it("文本被改写 → 失败；丢失一条 → 失败", () => {
    const parsed = parseAcceptanceCriteriaFromPrd(e1Prd);
    const records = parsed.acs.map((ac) => ({
      acKey: ac.acKey,
      text: ac.text,
      textHash: hashAcceptanceText(ac.text)
    }));

    const tampered = records.map((record, index) =>
      index === 0
        ? { ...record, text: `${record.text}（被改写）`, textHash: hashAcceptanceText("被改写") }
        : record
    );
    expect(verifyAcceptanceCriteriaIntegrity(tampered, e1Prd)).toContain(
      `Stored AC text differs from source document: ${records[0]?.acKey}`
    );

    const dropped = records.slice(1);
    expect(verifyAcceptanceCriteriaIntegrity(dropped, e1Prd)).toContain(
      `Source AC missing from stored records: ${records[0]?.acKey}`
    );
  });
});

describe("selectAcceptanceCriteriaForSlice（N3 切片范围过滤）", () => {
  const acs = [
    { acKey: "AC-01", frKeys: ["FR-1"] },
    { acKey: "AC-21", frKeys: ["FR-8"] },
    { acKey: "AC-30", frKeys: ["FR-9"] }
  ];

  it("按 FR 子集过滤；缺省时返回全部", () => {
    expect(selectAcceptanceCriteriaForSlice(acs, ["FR-1", "FR-9"]).map((ac) => ac.acKey)).toEqual([
      "AC-01",
      "AC-30"
    ]);
    expect(selectAcceptanceCriteriaForSlice(acs, undefined)).toHaveLength(3);
  });
});
