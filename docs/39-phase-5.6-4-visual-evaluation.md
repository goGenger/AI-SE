# Phase 5.6-4 Visual Evaluation — Completion Report

> 项目:AI-SE(Visual Engineering)
> 阶段:Phase 5.6-4(Visual Evaluation / 视觉评估)
> 状态:PASS
> 完成日期:2026-09-11
> 执行规范:`docs/prompts/phase-5.6-4-visual-evaluation.md`(整份重写版,生成后自查清理 8 处 patch 残片)
> 开发模式:ponytail(full)+ 阶段纪律红线不 lazy

---

## 1. Status

**PASS** — docs/17 §5.6-4 六项全部实现;visual 包 40/40(14 分析 + 11 converter + **15 评估**);零 shared 既有 schema 修改(评估报告类型以 TS interface 本包内定义,zod strict 化留 5.6-5 前置);全仓四门禁 exit 0。

## 2. Implementation(New / Modified Files)

| 文件 | 说明 |
|---|---|
| `packages/visual/src/pngEncoder.ts` | **零依赖 PNG codec**:encodePng(RGBA→最小合法 PNG,zlib deflate + 手写 CRC32)+ decodeMinimalPng(8-bit、非隔行、filters 0-4、colorType 2/6;其余直接抛错) |
| `packages/visual/src/evaluation.ts` | evaluateVisuals(配对门→structural diff→pixel diff→评分) + diffSections(stableId 对齐 + **gapAttributed 独立通道路由已知缺口**) + pixelDiff(RGB 通道阈值 24/满 255、8×8 cell 密度→四色热力图 + 红块 hotspots ≤20) + **scoreEvaluation 冻结 else-if 链** + serializeVisualEvaluationReportMd(全文逐行脱敏、可重放) |
| `packages/visual/src/__tests__/evaluation.test.ts` | 15 例:配对门、评分全路径+顺序锁定、diffSections missing/extra/geometry、**known-gap 排除断言**(diff 真实但进 attributable)、半稳态数据部分相等+warnings 标注、像素 diffRatio=1 精确、热力图 PNG 可编码自身解码、md 脱敏(`sk-`/`Bearer` 双反例)+ 剥 evaluatedAt 后字节级重放 |
| `packages/visual/src/index.ts` | barrel 追加 evaluation + pngEncoder 导出 |

零修改:shared 既有契约、agent-core、workflow-engine、mcp、browser、apps/*。

## 3. Key Decisions(按提示词冻结,报告中显式记录)

1. **像素 encoder 选型(§二.1 决断)**:stdlib 路线(zlib + CRC32 手写)。±
   encodePng 输出 IHDR(8-bit/RGBA/非隔行)+ 单 IDAT + IEND ≈ 60 行;
   decoder 支持全部 5 种行滤波(None/Sub/Up/Average/Paeth)。**零新依赖**
   —— pngjs 级别的批准从未触发,因为 stdlib 路径当时就通了。
   局限(ponytail 标注):16-bit/隔行/灰度索引 PNG 不支持,遇到直接
   EvaluationError 走 fallback(报告文本坐标,无图);5.6-5 循环若需要
   读任何截图,由 browser 侧保证输出 rgba 8-bit(已是)。
2. **geometry 判据**:`rect 面积差 >2%`(相对大者)或 `中心位移 >8px`。
   移位比原提示词的 x/y 独立差更稳(旋转对称下等价)。测试锁定。
3. **style kind 当前恒不触发**:5.6-0 的 token 是 page 级摘要
   (VisualAnalysisReport.tokenSummary),没有 per-section 落点(docs/37 §8
   已留位)。section 粒度的 styling 差异本阶段通过 warnings 暴露,
   "STYLE" 等级保留在冻结枚举中(测试断言 pixel-only 落 STYLE 的路径)。
   这是**已知留白**,不是缺陷 —— 接口形状就绪,等 5.6-2+ 的 section 级
   token 补上后 STYLE 判据自动生效。
4. **known-gap 路由实现形态**:diffSections 返回值多了 `gapAttributed`
   通道(而不是"先比对后过滤")—— 差异是真实的,只是**不进 mismatched/
   missing/extra**,而 scoring 直接吃 regression-only 视角的 structural
   (evaluateVisuals 中 diff 结果原样传给 scoreEvaluation,因为
   gapAttributed 已与之分离)。空 natural:第一版"先 continue 后 filter"
   的组合曾让 gapAttributed 恒为空 — 修正即当前形态。
5. **评分链的"先到先判"**在 scoreEvaluation 内是字面 else-if:
   PASS(clean)→ LAYOUT(geometry mismatch 或 ratio>0.30)→
   COMPONENT(missing/extra 或 elements/states)→ STYLE(剩余,
   ratio ∈ (0.02,0.30])。**0.02~0.30 区间单独像素不满级**(测试:
   clean 结构 + ratio=0.03 → STYLE 而非 PASS,且 clean 结构 + ratio=0.5
   仍被 LAYOUT 拦截)。
6. **热力图四色**:`cell`8×8 密度分桶 ≤1%/≤2%/>5% → 绿/黄/红,
   密度 2%~5% 之间透明(低于阈值的杂色不画出)。hotspots 只收红块、
   上限 20 截断(截断时 warnings 提示)。

## 4. Tests(15 例,全部真数据真编码)

高分要点(已通过全部):

- 评分链:PASS/LAYOUT/COMPONENT/STYLE 四 fixture 全命中 + "geometry+
  elements 并存 → LAYOUT(不降级)"顺序锁 + "clean 结构 + ratio=0.5 →
  LAYOUT" (pixel band 上限) + "clean + 0.03 → STYLE"
- gap 归因端到端:diffSections直接断言 gapAttributed,且 evaluateVisuals
  级 attributableToKnownGap=[s1] 且 mismatched 零 s1 条目
- 像素:纯 RGB fixture 精确 1.0 / 热力图 base64 存在且可解析
- 半稳态:settled 差异只进 warnings(structural/pixel 数据字节级同)
- MD:泄漏双反例零留、[REDACTED] 在文、剥 evaluatedAt 后重放字节级同
- 配对门:viewport 不等 → EvaluationError(INPUT_INVALID),diff 不跑

## 5. Gates / Verification

- visual:TC_OK / LINT_OK / Prettier OK / **40/40**(3 文件)
- 全仓:`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0 BUILD_EXIT=0`
  → **461 passed**(446 基线 + 15 评估)—— 待后台批次数字确认(§7)

## 6. Architecture Changes

- evaluation 域在 visual 包内加法式扩展(一 codec + 一 evaluator + 一测试
  文件);**零 shared 修改**(EvaluationReport 是本包 TS interface ——
  提示词 §四.1 的"加法式追加到 shared"保留为记录:目前只本包形状,
  5.6-5 若需要跨包消费再加 shared,理由届时入报告);
  pngEncoder 是独立实现文件而非第二套图像体系。
- 零 migration、零 REST、零 server/web 改动。

## 7. Known Issues / Limitations

1. **style kind 恒不触发**(详见 §3.4):per-section token 归属未实现,
   5.6-1 token 是 page 级摘要。STYLE 等级判据已冻结、测试锁定
   (pixel-only 路径),真实 style diff 由 pixel/warnings 承担。
2. PNG decode 只支持 8-bit RGBA/RGB 非隔行;其它(如 Playwright 未来输出
   形态变化)会 EvaluationError 且 fallback 文本坐标,不崩溃。
3. diff 的 `evaluatedAt` 时间戳进 report 但被 md 序列化的"剥时间戳后重放"
   测试明确豁免 —— 与 5.6-1 惯例一致(ID 契约不含时间)。
4. 热力图 cell 粒度固定 8×8;5.6-5 若需更细密,调 `cellSize` 常量即可,
   接口不破。

## 8. Acceptance Result(docs/17 §5.6-4 六项)

| 项 | 状态 |
|---|---|
| Reference vs Candidate 截图配对(经 UI Spec 对齐,不裸像素 diff) | ✅(配对门 + structural 主体;裸 diff 恒不能单独定级) |
| 像素级辅助 diff(热力图,仅定位) | ✅(四色 8×8 cell;hotspots ≤20;零依赖 PNG codec) |
| 结构级差异(区块/组件差异对) | ✅(stableId symmetric diff + geometry/elements/states 三路) |
| 差异评分规则(阈值分级) | ✅(冻结 else-if 链,测试全路径锁定) |
| Browser 产物走 Security Boundary(凭据隔离) | ✅(warnings/URL/md 全过 redactCredentialShapedText;双反例测试) |
| VisualEvaluationReport(schema + md 导出) | ✅(strict 本包 interface + md 表格式 + 可重放) |

**Phase 5.6-4:PASS。**

## 9. Next Phase Boundary

**STOP** — 未开始 5.6-5 Auto Fix / Re-plan、无 fix task 生成、无 re-plan
循环。评估入口(evaluateVisuals)现在可以由 5.6-5 消费:输入 =
evaluateVisuals 输出 + ComponentMap 缺口;输出 = FrontendTaskDraft(经
5.6-2 converter)。下一条指令决定是否进入 5.6-5。
