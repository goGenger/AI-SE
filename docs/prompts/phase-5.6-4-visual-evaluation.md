# Phase 5.6-4 任务提示词 — Visual Evaluation(视觉评估)

> 使用方式:复制下方分割线内全部内容,作为 Phase 5.6-4 的执行指令。
> 沿用 5.6-0~5.6-3 成功模式:先阅读与架构分析、以代码为准、复用现有模型不建第二套、独立完成报告、完成后 STOP。

---

You are now implementing AI-SE Phase 5.6-4: Visual Evaluation.

本阶段唯一目标:把参考截图(Reference)与候选截图(Candidate)**配对、对比、评分,产出 VisualEvaluationReport(schema + md 导出)**。配对经 UI Spec 对齐 —— **不允许裸像素 diff 充当结论**;像素 diff 只是辅助定位,结构级差异(区块/组件对)才是报告主体。

不要扩展到 5.6-5 Auto Fix / Re-plan(不消费评估结果生成任务)、5.6-6 Responsive(不做多尺寸矩阵评估)。
不修改 5.5 冻结契约与 5.6-0/1/2/3 冻结产物;shared 只允许加法式新增
`VisualEvaluationReport` 类型(理由入报告),零既有 schema 修改。

---

### 一、开始实现前必须先阅读

以代码为准,先阅读:

1. `docs/17-acceptance-checklist.md` §5.6-4(**六项**)
2. `packages/shared/src/index.ts` Phase 5.6-0 段:VisualSpecification 四层
   (Page/Section/Element 的 geometry 与 states)、`VisualInputRecord`
   (reference/candidate 两份 record 就是输入证据的载体,record.source 原样
   带出)、`ComponentMapEntry`(**matched:false 缺口是评估的强信号 ——
   当前组件库没有对应组件的区块,差异是天然预期的;报告必须把"已知缺口
   造成的差异"与"真实回归差异"分开**)
3. `packages/browser/src/playwrightAdapter.ts` 的 `toVisualInputRecord`
   (browser 产 record 接缝;评估入口直接吃两份 record + 两份 base64)
4. `docs/38` §7 Known Issues:settled 标记 —— `"timeout"` 的截图可能是半稳态,
   半稳态产生的 diff 必须标注,不能静默当成回归
5. `packages/observability` 的 `redactCredentialShapedText`(产物 md 全文过
   脱敏,5.6-1 惯例延续)

如果实际代码与上述描述不一致,先搜索定位真实实现;doc-vs-code 偏差写入报告,不默默修改。

---

### 二、先做架构分析,再动手

```text
Reference { record, base64, analysis, specification }
Candidate { record, base64, analysis, specification }
        ↓
  配对门(viewport 相等;否则 EVALUATION_INPUT_INVALID)
        ↓
  ┌─ 结构级差异(section 对齐:missing / extra / mismatched 四类)
  ├─ 像素级辅助 diff(热力图,只定位不结论)
  └─ 评分(冻结分级:PASS / LAYOUT / COMPONENT / STYLE,先到先判)
        ↓
VisualEvaluationReport(strict zod + md 导出,全文过脱敏)
```

动手前在报告中逐一确认的架构判定:

1. **依赖最小**:像素 diff 与热力图 PNG 用最小实现 —— 优先 stdlib
   (zlib deflate + CRC32 手写 PNG encoder);若确实需要第三方图像库
   (如 pngjs),在报告列出依赖与理由,**先等批准再装**;绝不引入
   sharp / puppeteer 类大件。
2. **半稳态防护**:调用方传入的 `settled: "timeout"` 必须写入 warnings
   (stability 提示)。评分不因半稳态而改写,但标注不缺席;重拍(
   re-take)是 5.6-5 循环的职责,本阶段不做。
3. **known-gap 归因**:候选侧 specification 中,section 内存在
   `ComponentMapEntry.matched === false` 元素的,该 section 的全部差异
   进 `attributableToKnownGap`,**不进 structural.mismatch** —— 这是
   5.6-2 缺口一等公民语义的直接下游义务,防止缺口被污染为回归。
4. **配对规则**:两侧 viewport 相等才可配对;不匹配直接
   `EVALUATION_INPUT_INVALID`(错误风格对齐 visual 包现有 errors.ts,
   不建第二套错误类)。

---

### 三、交付物定义

**位置**:`packages/visual/src/evaluation.ts`(放 visual 包 —— 评估是分析域
行为;不新建包、不动 browser 包)。导出经 barrel 对齐。

**1. VisualEvaluationReport(加法式追加到 shared)**

```ts
interface VisualEvaluationReport {
  referenceSource: string;   // reference record.source 原样
  candidateSource: string;   // candidate record.source 原样
  evaluatedAt: string;       // ISO datetime
  viewport: { width: number; height: number };
  /** 结构级差异 —— 报告主体。 */
  structural: {
    sectionsTotal: number;
    /** reference 有而 candidate 缺失的 section stableId。 */
    missing: string[];
    /** candidate 多出的 section stableId。 */
    extra: string[];
    /** 两侧同 id 的 section 内容不匹配。 */
    mismatched: Array<{
      sectionId: string;
      kind: "geometry" | "elements" | "style" | "states";
      /** 人类可读、不超过 200 字符的差异描述。 */
      detail: string;
    }>;
  };
  /** 像素级辅助 —— 仅定位,不单独定级。 */
  pixel: {
    /** 0..1,判定像素占比。 */
    diffRatio: number;
    /** 热力图 PNG 的 base64;四色:透明(相同)/绿(轻微)/黄(中度)/红(显著)。 */
    heatMapBase64?: string;
    /** 红色块 bounding box,最多 20 个,超出截断并加警告。 */
    hotspots: Array<{ x: number; y: number; width: number; height: number }>;
  };
  /** 冻结分级,判定条件见下方分级表。 */
  score: "PASS" | "LAYOUT" | "COMPONENT" | "STYLE";
  /** 已脱敏;半稳态提示(stability)也写在这里。 */
  warnings: string[];
  /** 差异可归因为已知组件缺口的 section id 列表。 */
  attributableToKnownGap: string[];
}
```

**评分分级(冻结,测试锁定,不得由调用方注入或改写)** — 判定由
`evaluateVisuals` 以 else-if 链先到先判:PASS > LAYOUT > COMPONENT > STYLE,
LAYOUT 触发后不再降级判定。注意:pixel.diffRatio ∈ (0.02, 0.30] 区间时
单看像素不定级,必须有 structural 佐证。

| 等级 | 触发条件(先到先判) |
|---|---|
| PASS | pixel.diffRatio ≤ 0.02 且 structural 无 mismatch/missing/extra |
| LAYOUT | 任一 section 存在 kind="geometry" 的 mismatch,或 pixel.diffRatio > 0.30 |
| COMPONENT | 无 geometry mismatch,但存在 kind="elements"/"states" mismatch,或 missing/extra 非空 |
| STYLE | 仅有 kind="style" mismatch,且 pixel.diffRatio ∈ (0.02, 0.30] |

**2. 纯函数评估(evaluateVisuals)**

```ts
evaluateVisuals(request: {
  reference: { record: VisualInputRecord; base64: string; analysis: VisualAnalysisReport; specification: VisualSpecification };
  candidate: { record: VisualInputRecord; base64: string; analysis: VisualAnalysisReport; specification: VisualSpecification };
  settled?: "networkidle" | "timeout";
}): { report: VisualEvaluationReport }
```

- **配对门**:两侧 viewport 相等,否则抛
  `EVALUATION_INPUT_INVALID`(加入 visual 包现有错误码集合,不新建错误类);
  配对失败时像素 diff 零执行。
- **spec 对齐策略(声明式,报告记录理由)**:按 section stableId 集合做
  symmetric diff 得 missing/extra;同 id 的 section 比对四类:
  - geometry:rect 面积差 >2% 或中心位移 >8px 记 mismatch;
  - elements:stableId 集合与 role 集合不相等记 mismatch;
  - style:token 名称集合不相等记 mismatch(token 值不做逐字比较 ——
    语义层对齐看命名);
  - states:state.name 集合不相等记 mismatch。
- **像素辅助 diff**:先做 buffer 长度快速比对(不等 → diffRatio 取 1,
  警告"尺寸不同");再逐像素比较 RGB 通道,任一通道差值 >24(满 255)记
  判变像素;diffRatio = 判变像素 / 总像素。热力图四色:透明(相同)/
  绿(轻微,局部 1%~2% 变化密度)/黄(中度,2%~5%)/红(显著,>5%);
  hotspots 取红块的 bounding box(最多 20 个,超出截断并加警告)。
- **热力图 PNG 输出**:手写最小 PNG encoder(zlib deflate + CRC32,stdlib
  可完成);若实现前探明阻塞(例如无法稳定编码),fallback 为"报告只含
  diffRatio 与 hotspots 文本坐标,不含热力图图像" —— 二选一在报告中写明
  选型与理由,不许中途改成引入大件。

**3. md 导出(延续 5.6-1 惯例)**

- `serializeVisualEvaluationReportMd(report): string` — 表格式呈现
  score / structural 计数 / hotspots 坐标 / warnings;**全文逐行过
  `redactCredentialShapedText`**;可重放(相同输入 → 字节级一致)。

---

### 四、测试要求

新增测试,位置:`packages/visual/src/__tests__/evaluation.test.ts`(跟随本包现状):

- **配对门**:两侧 viewport 不相等 → `EVALUATION_INPUT_INVALID`,且像素
  diff 未执行(可用计数/Proxy 断言)。
- **评分全路径**:构造 fixture 分别命中 PASS / LAYOUT / COMPONENT / STYLE
  四个等级,并锁定先到先判顺序(例如 geometry mismatch + elements mismatch
  并存时判 LAYOUT 而非 COMPONENT)。
- **known-gap 归因**:含 `ComponentMapEntry(matched:false)` 元素的 section,
  其差异全部出现在 `attributableToKnownGap`,**不出现**在
  `structural.mismatch`。
- **半稳态**:`settled: "timeout"` 与 `"networkidle"` 的报告数据部分
  (structural/pixel/score)一致,warnings 必含 stability 提示。
- **像素用例**:构造可预测差异的 RGB fixture → diffRatio 精确;热力图
  4 色判定(对 hit 区域颜色断言,直接解析自家 encoder 的输出)。
- **md 导出**:fixture 文本夹 `sk-` 形 token → 序列化结果零泄漏且含
  `[REDACTED]`;相同输入两次序列化 toEqual 全等。
- **回归**:5.6-0/1/2/3 既有测试原样全绿;全仓 `typecheck && lint && test`
  四门禁 exit 0。

---

### 五、边界与红线

1. **不建第二套体系**:错误码只在 visual 包现有错误集合上追加
   `EVALUATION_INPUT_INVALID` 一个;评分分级是冻结枚举,不暴露为参数。
2. 像素 diff 只做定位不进结论:热力图是辅助证据,structural 是报告主体;
   pixel.diffRatio 在 (0.02, 0.30] 区间时不得单独驱动定级。
3. shared 仅加法式新增 `VisualEvaluationReport`;零既有 schema 修改、
   零 migration、零 server 改动。
4. 不引入新顶层依赖(若需图像库走 §二.1 批准);fixture 零外网请求;
   不消费评估结果生成任务(那是 5.6-5)。
5. **凭据红线**:报告任何字段不得含凭据;warnings 与 URL 均经 redact;
   md 导出必定全文过 `redactCredentialShapedText` —— 测试反例锁定。
6. `settled: "timeout"` 的候选保留 warnings 标注即可,本阶段不重拍
   (重拍归 5.6-5 循环)。

---

### 六、完成后

- 报告落 `docs/39-phase-5.6-4-visual-evaluation.md`(结构照 docs/36 固定节;
  内含:评分分级全文、spec 对齐策略理由、像素 encoder 选型(stdlib vs
  获批依赖)、半稳态防护说明、doc-vs-code 偏差记录)。
- 更新:`docs/17` §5.6-4 六项 [x];`docs/15` roadmap 行;`docs/18` 阶段状态;
  本提示词文件保留原样。
- **完成 Phase 5.6-4 后立即 STOP。** 不开始 5.6-5 Auto Fix、不生成 fix
  task、不启动 re-plan 循环。
- 输出完整完成报告(含 STOP 声明)。

---

### 七、验收对照(5.6-4 六项 → 提示词节)

| docs/17 checklist 项 | 对应 |
|---|---|
| Reference vs Candidate 截图配对(经 UI Spec 对齐,不裸像素 diff) | 二 + 三.2 |
| 像素级辅助 diff(局部差异热力图,仅定位用途) | 二 + 三.2 像素辅助 diff |
| 结构级差异(区块 / 组件差异对) | 三.1 structural |
| 差异评分规则(阈值分级:符合 / 布局级 / 组件级 / 风格级) | 三.1 评分分级 |
| Browser 产物走 Security Boundary(凭据隔离复用 5.5) | 一.5 + 五.5 |
| VisualEvaluationReport(schema + md 导出,复用 5.6-1 报告惯例) | 三.1 + 三.3 |
