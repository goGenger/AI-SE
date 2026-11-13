# Phase 5.6-6 Repair — Responsive & UI State Validation(真实状态闭环)

> 任务书:用户提供的 "Phase 5.6-6 — Responsive & UI State Validation"
> 状态:**PASS** — 真实 UI State 验证闭环 + 响应式矩阵补齐;全部判定来自真实截图评估
> 完成日期:2026-09-13
> 开发模式:ponytail(复用 5.6-3/5.6-4,零新评估系统)+ 以代码为准

---

## 1. Status

**PASS** — 修复目标全数达成:

```text
UI State / Viewport
   → Browser Runtime(真实 Chromium,受控交互触发)
   → 真实 Screenshot
   → 5.6-4 evaluateVisuals(冻结)
   → VisualEvaluationReport(5.6-6 薄封装)
   → State 正确 / State 视觉差异 / Responsive 差异 / Regression
```

- 十个 UI 状态全部以**真实页面 + 真实交互**触发(click / type / hover / focus /
  press-and-hold),每个状态产生真实 Browser Screenshot 并进入评估;
- 响应式矩阵补齐 **Desktop / Tablet / Mobile / Custom**,断点行为以真实
  `@media (max-width:600px)` 的截图证据判定(含 600px 上下界的精确性);
- 判定统一进入已有 `VisualEvaluationReport`(零新 Report 类型、零新评估算法);
- 全程经 BrowserSession(唯一 Playwright 边界未动),无 Agent 直连、无第二套系统。

## 2. 修改 / 新增文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/browser/src/session.ts` | 修改 | `PageLike` 增 `hover` / `focus` / `mouse`(`MouseLike`);类型面向真实 Playwright 结构匹配(adapter 零改动) |
| `packages/browser/src/browserSession.ts` | 修改 | 新增 `hover()` / `focus()` / `mouseDown(selector)`(`hover` 定位指针后按下,免 bounding-box)/ `mouseUp()`;错误统一归一为 `BROWSER_NAV_FAILED`,selector 经脱敏 |
| `packages/browser/src/index.ts` | 修改 | 导出 `MouseLike` 类型 |
| `packages/browser/src/__tests__/browserSession.test.ts` | 修改 | harness 扩展(hover/focus/mouse 记录);新增 2 例:调用序列断言(`mouseDown` = hover→down)、错误归一 + 关闭态语义 |
| `packages/browser/src/__tests__/interaction.e2e.test.ts` | **新增** | 真实 Chromium E2E:hover / focus / active 三态拍照可辨、指针移开**像素级回退**(锁定 diffRatio===0 ⇔ 同渲染等式) |
| `packages/visual/src/validation.ts` | 修改 | `ViewportName` +`tablet`/`custom`;冻结矩阵 +tablet(768×1024);`VALIDATED_UI_STATES` 十态;`StateFlip` 词汇扩为 `ValidatedStateName`(含编译期关系保护 `EverySharedAnnotationStateIsValidated`);新增 `detectStateRegressions`(仅读冻结像素证据);md 序列化增可选 regression 段 |
| `packages/visual/src/index.ts` | 修改 | barrel 导出新符号 |
| `packages/visual/src/__tests__/validation.test.ts` | 修改 | +5 例:矩阵 tablet/custom、十态断言、新词汇 flip、回归探测双方向、md regression 段 |
| `apps/server/src/__tests__/uiStateValidation.e2e.test.ts` | **新增** | 闭环 E2E(3 例):响应式矩阵 + 断点域精确性;九状态 flip(含稳定对照);状态级回归探测 |

**未触碰**:5.6-4 评估算法(0 行)、5.6-3 网络/证据语义(0 行)、shared 契约(0 行)、
browser 7 工具注册表(0 行)、Agent/Workflow/Task 系统、docs/40(历史报告保持)。

## 3. Responsive 实现情况

**矩阵(冻结,code-reviewed 常量)**:`RESPONSIVE_VIEWPORTS` = desktop 1440×900、
tablet 768×1024、mobile 375×812;custom 尺寸经 `MatrixEntry` 携带(500×800 实例验证)。

E2E 证据(真实 Chromium,本地 fixture 页,零外网):

| 轮次 | 条件 | desktop | tablet | mobile | custom |
|---|---|---|---|---|---|
| R1 | design vs page(一致文档) | PASS | PASS | PASS | PASS(四者 diffRatio 全 0) |
| R2 | 剥离 `@media (max-width:600px)` 块 | **PASS(diff 0)** | **PASS(diff 0)** | 非 PASS(diff>2%) | 非 PASS(diff>2%) |

- **断点域精确性**:媒体块剥离后只有 600px 以下视口变化——desktop/tablet
  与 design **逐像素一致**(diffRatio === 0),证明断点行为真实生效且作用域精确;
- **Cross-viewport summary**:`consistent=false`,variantViewports 按冻结语义列出
  全部条目及分数(desktop/tablet=PASS,mobile/custom≠PASS);
- 布局变化 / 组件尺寸 / 间距 / 显隐 / Component consistency 由该断点差异直接承载
  (媒体块含 `header` 高度、`#side` 显隐、`.card` 宽度);
- md 导出复用 `serializeResponsiveValidationMd`(无新报告类型)。

## 4. UI State 实现情况(十态,真实触发)

| # | 状态 | 真实触发方式 | 截图差异(实测 diffRatio) |
|---|---|---|---|
| 1 | default | 页面加载基线(每个 flip 的参照) | — |
| 2 | loading | 点击 refresh → 1.5s 挂起 fetch 期间截图(spinner 可见) | 0.254% |
| 3 | empty | 输入过滤值 "zzz"(真实 input 事件:列表隐藏 + 空态显示) | 0.367% |
| 4 | error | refresh fetch 收到真实 HTTP 500(fixture 开关) | 0.254% |
| 5 | disabled | 清空输入 → submit 按钮 disabled | 0.666% |
| 6 | hover | `session.hover("#card-1")`(真实指针移动 + CSS :hover) | 2.323% |
| 7 | focus | `session.focus("#query")`(DOM focus + CSS :focus) | 0.117% |
| 8 | active | `session.mouseDown("#submit")`(按下并保持,CSS :active) | 2.859% |
| 9 | expanded | 点击 accordion(展开面板) | 0.640% |
| 10 | modal | 点击 open dialog(遮罩 + 对话框) | **84.59%** |

- **九态全部产生真实像素差异**(断言逐态 `diffRatio > 0`);modal 达 LAYOUT 级
  (`score==="LAYOUT"` 断言);
- **稳定对照**:hover 非交互文本 → `diffRatio === 0`(无误报,像素级确定性);
- 无任何“状态 JSON 伪造”:每个状态均由真实交互驱动真实页面,断言只读真实截图;
- 错误态交叉证据:会话网络证据中检出真实 `http_5xx`(5.6-3 通道联动)。

## 5. Screenshot / Evaluation 证据

- 双侧 spec 由**真实截图字节**解码派生(pixel-band → 5.6-1 归一化;与 5.6-5 相同
  确定性模式),评估走冻结 `evaluateVisuals`(像素 + 结构双通道);
- **State Regression Detection**(新增 `detectStateRegressions`,只读冻结像素证据):
  - 健康页:hover flip `diffRatio > 0` → 无 finding;
  - **破坏 hover 样式表**(剥离 `.card:hover` 规则):flip `diffRatio === 0` →
    `missingChange: ["hover"]`;
  - 关键对照:该破坏对**页面级比较完全隐形**(默认渲染逐像素一致,diff 0),
    只有状态级 flip 能捕获——证明状态验证闭环的独立价值;
- 稳定对照与回归探测共同锁定「diffRatio===0 ⇔ 同渲染」等式(浏览器包 e2e 独立复证)。

## 6. Hover 限制的处理(docs/40 §7.3 更正)

历史 docs/40 记录“headless 无法稳定捕获 hover 伪类”。本任务**实证证伪**:

1. 一次性探针(真实 Chromium headless):hover / focus / active 拍照全部可辨,
   指针移开后**像素级回退**(hover_reverts = true);
2. 永久化:`packages/browser/src/__tests__/interaction.e2e.test.ts` 以真实 E2E
   锁定三种伪态捕获 + 回退等式;
3. 结论:无需任何替代触发方式,十个状态全部按原生方式验证,无降级项。

## 7. 测试结果 / Regression

- browser:**21/21**(18 基线 + 2 单元 + 1 真实交互 e2e);
- visual:**83/83**(78 基线 + 5 新增);
- server:**49/49**(46 基线 + 3 闭环 e2e);
- 全仓四门禁(根脚本,并行配置):`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0
  BUILD_EXIT=0`,**TOTAL 543/543,0 failed**(分包明细见 §9);
- 5.6-0~5.6-5 产物零触碰;shared / 评估算法 / 工具注册表零改动。

## 8. 已知限制

1. **shared 状态枚举保持冻结(7 值)**:`active`/`expanded`/`modal` 是 5.6-6 验证层
   词汇(`ValidatedStateName`),不写入 spec 注记;若未来需在 5.6-0 契约中注记这些
   状态,属契约变更任务(本任务不越权修改冻结契约)。编译期保护
   `EverySharedAnnotationStateIsValidated` 锁定既有 6 态 ⊆ 验证词汇。
2. **小面积状态的分数语义**:2% PASS 阈值是页面级标尺;hover(2.32%)/focus(0.12%)
   等状态的“正确性”判定用状态级像素证据通道(`diffRatio>0` + 回归探测),与阈值
   解耦——文档化语义,不是补丁。
3. **原生控件 UA hover 渲染**:未显式样式化的原生 `<button>` 的 UA hover 面孔随
   指针位置变化(实测 208px 像素差)。fixture 统一 `appearance:none` + 显式样式;
  真实应用做状态对比时需同样控制指针纪律(或由 VLM 分析层吸收该噪声)。
4. 状态验证的触发驱动是会话层(与既有 responsive e2e 同构);7 个冻结 Browser Tool
   未扩充——若未来 Agent 需自主驱动状态,属工具面评审任务。
5. 评估的 states-kind 结构通道仍由既有单元测试锁定(十态在验证层无法全量写入注记,
   见 #1);e2e 走像素证据通道。

## 9. 全仓回归

批次 proc_47d7e7544120(根脚本 `pnpm typecheck / lint / test / build`,并行配置):
四门禁全部 exit 0,**TOTAL 543/543,0 failed**;
分包:observability 2 | shared 39 | workflow-engine 14 | web 51 | visual 83 |
sandbox 2 | tool-runtime 11 | browser 21 | agent-core 37 | mcp 201 |
database 33 | server 49。
