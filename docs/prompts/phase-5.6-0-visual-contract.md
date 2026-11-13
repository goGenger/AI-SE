# Phase 5.6-0 任务提示词 — Visual Contract(契约冻结)

> 使用方式:复制下方分割线内的全部内容,作为 Phase 5.6-0 的执行指令。
> 检查要点已融合 5.5-0 的成功经验:先阅读与架构分析、以代码为准、契约冻结不实现、真实测试不做 mock 替代、完成后 STOP。

---

You are now implementing AI-SE Phase 5.6-0: Visual Contract (Contract Freeze).

本阶段唯一目标:为 Visual Engineering 冻结输入契约、数据结构与边界,不实现任何解析、采集或浏览器行为。参照 Phase 5.5-0 的成功模式:契约先行、实现为零、测试锁型。

不要扩展到 5.6-1 Visual Analysis、5.6-2 Spec→Frontend、5.6-3 Browser Runtime 或任何 Playwright / 截图 / VLM 能力。
不要修改或重构 Phase 5.5 已冻结的 MCP Contract(docs/25),也不要触碰 Phase 0~5.7 的既有架构。

---

### 一、开始实现前必须先阅读

先阅读并理解当前仓库中的以下内容:

1. Phase 5.6 规划与验收
- `docs/15-development-roadmap.md` §Phase 5.6(注意:5.6-2 与 5.6-3 顺序对调已确认,5.6-2 与 5.6-3 可并行)
- `docs/17-acceptance-checklist.md` §Phase 5.6(5.6-0 七项)
- `docs/18-phase-engineering-goals.md` §Phase 5.6(核心不变量)

2. Phase 5.6-0 必须复用或对齐的现有结构(以代码为准)
- `packages/shared/src/index.ts`:Requirement / Specification / Task / TaskStatusSchema
  —— 理解 5.6-0 的 VisualInputRecord / UI Spec / Design Tokens / Component Map 应放在 shared 层,
  与既有 DTO/schemas 组织方式保持一致
- `packages/tool-runtime/src/types.ts`:ToolDefinition —— 确认 5.6 不修改它
- `packages/database/migrations/*`:确认 5.6-0 不新增任何表(契约阶段零持久化)
- `docs/25-mcp-contract-freeze.md`:5.5-0 契约冻结的格式先例(§7 边界清单写法)

3. 5.5-0 完成报告
- `docs/26-phase-5.5-0-contract-freeze-report.md` —— 本阶段报告结构与"以代码为准的现状分析"写法照此执行

如果实际代码结构与上述假设不一致,先搜索定位真实实现,不要基于文档假设创建重复模块。

---

### 二、严格范围:5.6-0 唯一交付物

只有以下 7 项验收目标:

- [ ] Visual 输入 URI 契约(screenshot:// / figma:// / url:// / code://,url:// 限受控地址白名单)
- [ ] VisualInputRecord 数据结构 + 校验(来源、格式、尺寸、viewport)
- [ ] UI Specification 结构(页面 / 区块 / 元素 / 状态四层,含稳定 ID 与几何归属)
- [ ] Design Tokens 结构(颜色 / 字体 / 间距 / 圆角 / 阴影 / 动效,引用优先于内联值)
- [ ] Component Map(项目现有组件库优先,缺失组件显式报缺口)
- [ ] 契约测试(fixture 输入 → 规范化输出,未实现解析)
- [ ] 边界冻结:不实现任何解析 / 采集 / 浏览器行为

不得新增:

- 截图能力、Playwright / Chromium 依赖、Browser Runtime
- VLM 调用或模型绑定
- Visual Analysis / Evaluation 实现
- 数据库表 / migration(5.6-0 零持久化)
- Console 页面、REST 端点
- 对 shared 既有 type/schema 的任何修改(只允许追加)

如果发现 docs/15 或 docs/25 与当前代码有出入,以代码为准并在报告中说明,不擅自改文档假设的实现。

---

### 三、交付物定义(phases 位置在 packages/shared/src/visual/,或经搜索确认后放 shared 的现有组织方式内)

1. 输入契约

- `VisualInputType`:4 种 —— `screenshot` / `figma` / `url` / `code`
- `VisualInputUri`:格式统一为 `<type>://<path 或引用>`,所有 4 种 schema 的一组 static factory
- 对 `url://` 只接受受控地址白名单(localhost、127.0.0.1 段与未来可能部署样机的 allowed domains 前缀列表,以显式数组机制呈现,默认空列表 = 拒绝);
  禁止任意公网 URL(注入风险由调用方自担)
- 禁止:File/远程/凭据引用不做校验(冻结范围外,零凭据语义延续 5.5)

2. VisualInputRecord

```ts
interface VisualInputRecord {
  inputType: VisualInputType;
  source: string;          // URI(不含 credential)
  viewport: { width: number; height: number };
  inputRef?: string;       // 引用型 asset 的外部 ID 或本地路径
  runId?: string;          // 若描述属于真实 agent run, 引用, 不内嵌凭据
}
```

- 不含明文凭据/密钥/文件内容(引用语义同 5.5-0 credentialRef 只为引用)
- 校验规则:URI 前缀必须与 inputType 匹配;viewport 为正整数;不合法即拒绝

3. UI Specification

- 四层:`VisualPage`(页面) / `VisualSection`(区块) / `VisualElement`(元素) /
  `VisualState`(状态:default / hover / focus / disabled / loading / empty / error)
- 每层含 `stableId`(确定性生成,基于层级+序号或显式 name;同输入两次解析必须同 ID)
- 几何归属必填于 Section 层:`{ x, y, width, height }`,Element 层 PARE 可选
- `VisualSpecification` 为一个完整页面级 spec;导入侧可多页面在一起并 PRD 可
  rejection anonymous 422(无效嵌套等 schema 校验)

4. Design Tokens

- 命名空间分组:`colors` / `typography` / `spacing` / `radii` / `shadows` / `motion`
- 语叉一致性:token 之间只引用 `@ref` 语义,不内联重复值(breakages check 测试锁定)

5. Component Map

- `ComponentMapEntry`: { stableId, componentName, matched: boolean, confidence? }
- `matched: false` 即"缺口",schema 必显式这个信息,不能靠由调用方推断
- 5.6-0 只定结构,不做真实组件匹配算法

6. 禁止歧义的边界

- `VisualPage / Analysis / Evaluation` 等词属于 5.6-1/5.6-4 的产物,5.6-0 只冻结类型定义
- 不做 image decoder、不做 DOM 解析、不做 HTTP 抓取

---

### 四、测试要求

- 契约测试 `packages/shared/src/__tests__/visualContract.test.ts`(或现有 shared 测试组织一致):
  - 4 种 inputType 的合法 URI 建构
  - 非法前缀 / 空 viewport / 负 integer viewport / url 非白名单 → 校验拒绝
  - VisualInputRecord schema 化(用与 5.5 相同的 zod,不另起炉灶)
  - VisualSpecification 四层 demonstrate stale-id 生成同输入必相同
  - Design Tokens 引用优先/内联值探测的 Redaction 边界情形
  - ComponentMapEntry 达 `matched: false` 也是合法数据(不丢弃)
  - 禁止性测试:确认本阶段**不新增任何 runtime import**(shared 内功能性零 import impact)
- 所有测试 `pnpm --filter @ai-se/shared test` 通过
- 全仓 `pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test` 必须全绿(确认零回归)

---

### 五、边界与红线

1. 禁止修改 `MCPClientPort` / `MCPErrorCategory` / `RuntimeErrorCode` / `ToolDefinition` / `AgentPermissions`(全部 5.5 已冻结)。
2. 禁止引入 Playwright / Puppeteer / 模型 SDK(vlm provider 接口也只允许在 5.6-1 定义,不在本阶段)。
3. 本阶段不新建任何子包 `packages/browser` / `packages/visual`(那是 5.6-1/5.6-3 的事)。
4. 凭据规则延续:VisualInputRecord 等 schema 内不得出现 `accessToken` / `password` / `apiKey` / `clientSecret` / `privateKey` 字段等;引用一律 `*Ref` 只指向外部存储位置。
5. 本阶段出现任何架构冲突或 doc 与代码不一致:停止并在报告里说明,不擅自扩大 Scope。

---

### 六、完成后

- 写完成报告到 `docs/35-phase-5.6-0-visual-contract.md`,照 docs/26 结构:
  Status / Current Architecture Analysis / Contract Definitions / Design Decisions /
  Tests / Known Limitations / Next Phase Recommendation(冻结条件行)。
- 更新 `docs/17` 5.6-0 七项 [x]、`docs/15` roadmap、`docs/18` Progress、`docs/34` 后回归门的 5.6-0 行。
- **完成 Phase 5.6-0 后立即 STOP。** 不开始 5.6-1,不实现任何 Visual Analysis。
- 输出完整完成报告(记得包括:契约字段解法、5 处决策点、发现的 doc-vs-code 偏差)。

---

### 七、验收对照(5.6-0 七项 → 提示词节)

| docs/17 checklist 项 | 本提示词对应节 |
|---|---|
| Visual 输入 URI 契约 | 三.1 |
| VisualInputRecord 数据结构 + 校验 | 三.2 |
| UI Specification 结构 | 三.3 |
| Design Tokens 结构 | 三.4 |
| Component Map | 三.5 |
| 契约测试 | 四 |
| 边界冻结 | 三.6 + 五 |
