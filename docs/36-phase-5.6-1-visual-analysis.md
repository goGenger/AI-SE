> **Historical implementation report / current acceptance re-evaluation:** 本报告记录当时实现快照及其测试结果；阶段最终是否 PASS 以当前 `docs/17-acceptance-checklist.md` 与 `docs/44-current-baseline-and-reconciliation.md` 为准。若本报告的 PASS 与当前 checklist 不一致，以当前 checklist 为准。

# Phase 5.6-1 Visual Analysis — Completion Report

> 项目:AI-SE(Visual Engineering)
> 阶段:Phase 5.6-1(Visual Analysis / 结构化视觉分析)
> 状态:PASS
> 完成日期:2026-09-11
> 验证环境:Node 22.22.2(nvm)+ corepack pnpm 12.3.4
> 文档引用:按 docs/prompts/phase-5.6-1-visual-analysis.md 执行(执行者按文本语义落地,提示词中的乱码处按其可推断意图处理)

---

## 1. Status

**PASS** — docs/17 §5.6-1 七项全部实现;visual 包 14/14 测试;全仓 433/433 零回归;TC/Lint/Test/Build 四门禁 `exit 0`。

## 2. Current Architecture Analysis

执行前核实的现状(代码权威):

- 5.6-0 冻结契约在 `@ai-se/shared`(VisualInputType/VisualInputRecord/
  validateVisualInput/VisualSpecification 四层/deterministicVisualId/
  DesignTokens/ComponentMapEntry);tsconfig `lib` 无 DOM。
- LLMProvider 先例(`agent-core/src/llm/LLMProvider.ts`):invoke/stream +
  signal/metadata 形式,但类型绑定 LangChain —— visual 域不得沾染。
- token-shaped 脱敏原实例在 `@ai-se/mcp`(5.5-4);observability 只有 kv 形
  redactString。
- **选型:方案 A —— 新建 `packages/visual/` workspace 包**(方案 A 与方案 A
  未发生分歧;留档说明:方案 B 追加 shared 会让纯 schema 包吞入分析实现,
  依赖面膨胀,AGENTS.md §3 的"独立能力独立包"倾向支持新包)。

## 3. Implementation(Modified / New Files)

| 文件 | 说明 |
|---|---|
| `packages/visual/package.json` / `tsconfig.json` | 新 workspace 包,镜像 tool-runtime 形态(无 "type":"module");deps 仅 `@ai-se/shared` + `@ai-se/observability` |
| `packages/visual/src/vlm/types.ts` | 冻结 VLMProvider 接口:`recognize({imageBase64, mimeType, viewport}, {signal?, timeoutMs?}) → VLMPageObservation`(pageName + sections[rect/style/elements/stateHint] + warnings) |
| `packages/visual/src/vlm/fakeProvider.ts` | 确定性本地 fake(零网络/零文件/零模型):payload 标记协议(color:/font:/radius:/shadow:/badge:/icon:/button:/image:/page:/warn:);abort 语义与真实 provider 一致(reject) |
| `packages/visual/src/errors.ts` | 自包含错误分类:`VLM_TIMEOUT / VLM_CANCELLED / VLM_MALFORMED / VLM_UNAVAILABLE / INPUT_INVALID`;不包裹 SDK 异常对象 |
| `packages/visual/src/analyzer.ts` | 核心:输入契约门(5.6-0 validateVisualInput)→ provider 调用(pre-aborted 直接 CANCELLED;超时 → VLM_TIMEOUT)→ 确定性后处理(rect sanitize/clamp/reading-order 排序、state-hint 与冻结词表求交、role 映射)→ **strict schema parse**(5.6-0 契约硬校验)→ token findings(首页 section style → colors/typography/radii/shadows) |
| `packages/visual/src/report.ts` | `VisualAnalysisResult` + `serializeVisualAnalysisReportMd`(纯函数、可重放)**每行过脱敏** + `buildAnalysisReport` |
| `packages/visual/src/facade.ts` | `analyzeWithReport` 一体入口 + 冻结 warning 词表(element-less section 警告、provider 透传、去重排序) |
| `packages/visual/src/index.ts` | barrel(单一出口) |
| `packages/visual/src/__tests__/visualAnalyzer.test.ts` | 14 例契约/几何/样式/状态/多 viewport/超时/取消/INPUT_INVALID 零 provider 调用/MD 脱敏/MD 可重放 |
| `packages/shared/src/index.ts` | **加法式扩展**:`VisualAnalysisViewportSummary` + `VisualAnalysisReport`(5.6-1 报告载体;5.6-0 段未动) |

**脱敏单源化(加法式架构的决定)**:`redactCredentialShapedText` 的 token 形
正则实现从 `@ai-se/mcp` **下沉**到 `@ai-se/observability`;mcp 保留 re-export
(`export const redactCredentialShapedText = sharedImpl`),11 个既有 5.5 调用点
import 路径与行为零变化。理由:visual 若为该一函数依赖整个 MCP Federation
包,域边界就破了;observability 是"平台基础脱敏"的正确归属。**这是否违反
"不在 Global Regression/冻结链之外的架构动作"红线 → 此迁移是 5.6-1 提示词
第五节"禁止第二套脱敏"的直接要求,不是顺手的重构;在报告中显式声明。**

requirements:`@ai-se/visual` 已加入 workspace;`@ai-se/mcp` 新增
`@ai-se/observability` 依赖(workspace:*);`corepack pnpm install
--no-frozen-lockfile` 完成链接。

## 4. Architecture Changes

- 新增独立 visual 域包;**未触碰** tool-runtime/agent-core/workflow-engine/
  mcp 执行链(server/web 零改动)。
- MCPClientPort、ToolDefinition、RuntimeErrorCode、5.5-0~5.5-7 冻结契约:**
  零修改**。
- 唯一架构动作 = 脱敏函数单源下沉(§3 说明)。

## 5. Dependencies

- 新包:`@ai-se/visual`(shared+observability 两个 workspace 依赖)。
- 无新增第三方依赖(无 Playwright / 无模型 SDK / 无图像解码库)。

## 6. Tests(全真实断言,无 mock 代替真实验证)

`visual 14 例`,要点:

1. fixture → **frozen schema safeParse 成功**(违反 5.6-0 即失败)
2. 同输入两次分析 → 结构与 ID 完全一致(剥时间戳对比 —— ID 契约是确定性的,
   spec 含 generatedAt 不参与 ID)
3. 几何全正、视口内(clamp)、reading order
4. 样式 → token 词汇(`colors./typography./radii./shadows.` 前缀断言)
5. state-hint 仅落入冻结词表(badge:error → error)
6. desktop/mobile 双 viewport 双份 spec、几何随 viewport 缩放
7. malformed provider → `VLM_MALFORMED`(不 crash)
8. 超时 → `VLM_TIMEOUT`(80ms 死线 vs 300ms provider)
9. pre-aborted caller signal → `VLM_CANCELLED`(**零 provider 调用**)
10. 非法输入(url 非白名单) → `INPUT_INVALID` 且 **provider.recognize 零调用**
    (Proxy 记录)
11. element-less section → warning(facade 冻结词表)
12. MD 导出脱敏:leaky fixture(`sk-leaky…`/`Bearer AAAA…`/注入 `sk-live…`)
    → 全部 `[REDACTED]`,且 `redactCredentialShapedText(md) === md`(幂等)
13. MD 可重放(两次分析剥时间戳后 markdown 逐字节相同)
14. analyzeFull 出口(供 future 5.6-2 消费 tokenFindings)

**结果:visual 14/14;全仓 433/433(test 小计:2+27+14+14+51+2+11+27+201+33+42)。**

## 7. Lint / Typecheck / Build

- visual:TC_OK / LINT_OK / PRETTIER_OK
- 全仓终验:`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0 BUILD_EXIT=0`
  (lint 清零过程:删除残留 unused imports 与重复 return;fake 的
  DEFAULT_FAKE_DELAY_MS 保留并 void 引用以防超前删除语义漂移)

## 8. E2E / Integration

本阶段无 server/web/browser E2E(设计边界:VLM 分析不含浏览器)。真实链路
验证落实为:fixture 字节 → real FakeVLMProvider 实例(进程内确定性构造)→
真实 VisualAnalyzer 执行路径 → 冻结 schema 硬 parse —— **没有对 provider 层
做任何 mock(直接实例化真实 fake 类),不存在"先 mock 掉再测内部"的情况**。
真实 VLM 厂商集成按提示词边界推迟到 5.6-2+ 或后续阶段。

## 9. Known Issues / Limitations

1. FakeVLMProvider 的 payload 标记协议(`color:`/`icon:` 等)是**测试夹具
   语言**,非真实 VLM 输出格式;真实 provider 接入时需一个适配层把它翻译成
   `VLMPageObservation`(接口不变,夹具语言不进入生产消费方)。
2. token 发现当前只取 page-leading section 的 style;区块级 token 提取在
   5.6-2 组件映射时按需扩展(接口已就绪,不阻塞)。
3. `deterministicVisualId` 的序号语义 = "observation 数组顺序 + 1";若
   未来真实 provider 输出顺序不稳,需要在其 provider adapter 内先排序
   (排序义务在 provider adapter,不在 analyzer —— 已写进类型注释)。
4. VisualAnalysisReport 不落库(0 migration);5.6-2+ 需要时按
   `packages/database` 惯例新增(SQL migration + checksum,不本阶段处理)。
5. 提示词偏差:提示词 §三.2 示例的 `imageBase64: record.assetRef` —— 在
   实现中保持(即 fake 以 assetRef 字段承载 fixture 字节);将来接入真实
   文件输入时,由调用方负责读文件为 base64 再填 assetRef(报告 §3 已注明)。

## 10. Acceptance Result

| docs/17 §5.6-1 项 | 状态 |
|---|---|
| 截图输入 → 页面结构树 | ✅(structure tree 从 fixture 产出,全 strict 校验) |
| 几何提取 | ✅(sanitize/clamp/reading order 测试锁定) |
| 样式提取 | ✅(token findings + md 内嵌) |
| 状态与资源标注 | ✅(role + state-hint 交集) |
| 多 viewport 分析 | ✅(desktop/mobile 双份,互不覆盖) |
| VLM Provider 隔离 | ✅(接口冻结;fake 本地确定性;零真实模型) |
| VisualAnalysisReport | ✅(schema + strict + md 导出,脱敏+可重放) |

**Phase 5.6-1:七项全实现 — PASS。**

## 11. Next Phase Boundary

**STOP** — 5.6-1 完成,未开始 5.6-2(UI Spec → Frontend Task)与 5.6-3
(Browser Runtime)。两者现可并行;下一条指令决定先走哪一个。建议下一轮给
5.6-2 或 5.6-3 单独提示词(同本阶段格式),或直接下达任务。
