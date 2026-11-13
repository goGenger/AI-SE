# Phase 5.6-0 Visual Contract — Completion Report

> 项目:AI-SE(Visual Engineering)
> 阶段:Phase 5.6-0(Visual Contract / 契约冻结)
> 状态:PASS
> 完成日期:2026-09-11
> 验证环境:Node 22.22.2(nvm)+ corepack pnpm 12.3.4

---

## 1. Status

**PASS** — 7/7 验收目标实现,契约测试 16 例全绿,全仓零回归,零实现性代码。

## 2. Current Architecture Analysis

以代码为准的现状(执行前核实):

- shared 层为单文件 `packages/shared/src/index.ts`(~920 行,zod 4.5.4),Requirement /
  Specification / Task / TaskStatus 等 DTO 与 schema 均追加于此;测试为平级
  `src/*.test.ts`(如 `planningSchemas.test.ts`)。→ 5.6-0 落点:**ollow 现有组织方式,
  追加到 `index.ts`**,不新建子目录/子包。
- `tsconfig.base.json` `lib: ["ES2022"]` —— **无 DOM lib**,shared 不得使用 `URL` 全局。
  → allowlist 校验用手写 `parseHttpOrigin`(正则 + authority 解析),零 DOM 依赖,
  未放宽任何 tsconfig。
- Phase 5.5 冻结物(MCPClientPort 9 方法、MCPErrorCategory 9 类、RuntimeErrorCode 8 类、
  ToolDefinition 模型)原样未动。

## 3. Contract Definitions(全部追加进 `@ai-se/shared`)

### 3.1 Visual 输入契约

- `VisualInputTypeSchema`(zod):`screenshot` / `figma` / `url` / `code`
- `VISUAL_INPUT_URI_PREFIXES`:每类型固定前缀表(`screenshot://` 等)
- `VisualViewportSchema`:`{ width: int(1..20000), height: int(1..20000) }`.strict
- `validateVisualInput(input, allowlist)`:纯函数校验器(无网络/无文件系统):
  1. zod strict 校验(未知字段、类型、边界);
  2. URI 前缀必须与 `inputType` 匹配;
  3. `url://` 走受控来源 allowlist(host:port 精确匹配;entry 决定生效协议;
     空 allowlist = 全部拒绝)。
- `VisualInputRecordSchema`:`inputType`、`source`、`viewport`、可选 `assetRef`
  (外部资源引用)、可选 `agentRunRef`(既有 agent run 引用)。

### 3.2 allowlist 设计要点(来自实测修正)

`url://` 是"指向受控页面的虚拟 URI":其 protocol 字面量是 `url:`,而 allowlist
entry(`http://localhost:4173`)的 protocol 是 `http:`。若按字符串 origin 严格
比较会永久 deny(首版测试实证)。冻结语义:**entry 的协议生效,host:port 匹配
即命中**——不含 userinfo(`@` 剥离),显式端口参与比较,默认端口(80/443)归一。

### 3.3 UI Specification(四层)

- `VisualPage`(id/name/viewport/sections)→ `VisualSection`
  (**geometry 必填**:`VisualRect {x,y,width,height}` + 可选 anchor)→
  `VisualElement`(role 枚举 text/button/input/image/icon/link/list/table/
  container/other,geometry 可选)→ `VisualState`
- `VisualStateNameSchema`:`default/hover/focus/disabled/loading/empty/error`
  (5.6-1 填充、5.6-6 验证的统一词汇表)
- `VisualSpecificationSchema` = `{ input, page, generatedAt }`,全部 strict
- `deterministicVisualId(level, name, index)`:`"<level>:<slug>:<index>"`;
  冻结契约:**同输入两次解析必须产生相同稳定 ID**(slug 归一化 + 层级前缀 +
  1-based 序号消歧;slug 为空回退 `unnamed`)

### 3.4 Design Tokens

- `DesignTokensSchema` 六命名空间:`colors / typography / spacing / radii /
  shadows / motion`(strict,未知命名空间拒绝)
- `VisualTokenValueSchema` = string | number
- `isTokenRef(value)`:`@ref:<token-path>` 判定 —— 引用优先于内联的机制入口。
  5.6-0 只提供判定 helper + 词法约定;引用闭环校验(悬空 @ref 检测)留给
  5.6-1 分析实现(在其 own tests 锁定),契约阶段不实现校验器。

### 3.5 Component Map

- `ComponentMapEntrySchema`:`id`、可选 `componentName`、`matched`、可选
  `confidence(0..1)`、`unmatchedReason`
- **refine 不变量(gap 是一等公民)**:`matched: false` ⇒ `unmatchedReason` 必填、
  `confidence` 必须缺省 —— 缺口信息必须显式,不允许调用方自行推断
- `VisualComponentMapSchema`:`{ sourceInput, entries[] }`

## 4. Design Decisions(5 处决策点)

| # | 决策 | 理由 |
|---|---|---|
| 1 | 全部契约落 `@ai-se/shared` 单文件追加,不建 `shared/src/visual/` | 仓库既有组织方式是单文件 + 平级测试(import "./index");建子目录会与 zod/dto 混排风格漂移,且 shared 无消费方冲突 |
| 2 | allowlist 解析不用 DOM `URL` | `lib` 无 DOM;放宽 tsconfig 违反"不改 strictness"红线。手写 authority 解析(~30 行,带测试) |
| 3 | `url://` 白名单按 host:port 匹配(entry 决定协议) | 虚拟 scheme 的 protocol 字面量不是真实协议;实测修正 |
| 4 | `matched: false` 在 schema 层强制 `unmatchedReason` | "缺口显式"是 docs/17 5.6-0 原文要求;靠约定会被静默丢弃 |
| 5 | `@ref` 校验器推迟到 5.6-1 | 5.6-0 只冻结词法/结构;校验器属于分析实现 |

## 5. Tests(16 例,全部真实断言)

`packages/shared/src/visualContract.test.ts`:

- 四种 inputType 合法 URI + 前缀匹配
- 前缀不匹配拒绝(含类型专属错误消息)
- `url://` 默认 deny(空 allowlist)+ 非 allowlist 主机 deny + allowlist 命中
  (exact + loopback)+ 显式端口
- viewport 非整数 / 越界 / 空 source 拒绝
- strict 全层:未知字段(含凭据形 `accessToken` / `credentialRef`)拒绝
- Section geometry 必填
- `deterministicVisualId`:同输入同 ID、跨层/跨序号互异、空 slug 稳定回退
- DesignTokens:六命名空间接受 + 未知拒绝;`@ref:` 判定
- ComponentMap:`matched:false` + reason 合法;gap 缺 reason / 带 confidence 拒绝

结果:shared 包 **27/27**(原 11 + 新 16)。

## 6. 全仓回归

`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0 BUILD_EXIT=0`,**405/405**
(shared +16)。生产构建含 shared Uint 白名单新增导出全 OK。

## 7. Known Limitations

1. `validateVisualInput` 不做文件存在性 / 真实可访问性检查(纯字符串语义;
   url:// 可达性留给 5.6-3 Browser Runtime)。
2. `@ref` 悬空检测推迟到 5.6-1(契约阶段只定词法)。
3. figma 协议本阶段仅定义 URI 形态;Figma API 访问(凭据管理)属 5.6-1+ 且
   必须走 5.5 credentialRef 红线。
4. `deterministicVisualId` 假定 5.6-1 分析器按"层级顺序遍历 + name"调用;
   序号回退规则(空 slug → unnamed)已锁死,分析器不得旁路。

## 8. Next Phase Recommendation

下一阶段 **5.6-1 Visual Analysis**(结构化视觉分析):消费本契约的
`VisualSpecification` 载体;`VLMProvider` 接口在此定义;`parseHttpOrigin`
已可复用于 URL 白名单之外的场景。**禁止**:开始任何 Browser Runtime /
Playwright(5.6-3)、任何 Fix Task 转换(5.6-2)。

---

## 附:验收对照(docs/17 §5.6-0 七项)

| Checklist 项 | 实现位置 |
|---|---|
| Visual 输入 URI 契约 | `VisualInputTypeSchema` + `VISUAL_INPUT_URI_PREFIXES` + validateVisualInput allowlist |
| VisualInputRecord 数据 + 校验 | `VisualInputRecordSchema` / `validateVisualInput` |
| UI Specification 结构 | `VisualPage/Section/Element/State/Specification` + 稳定 ID 契约 |
| Design Tokens 结构 | `DesignTokensSchema` / `isTokenRef` |
| Component Map | `ComponentMapEntrySchema`(gap 不变量)+ `VisualComponentMapSchema` |
| 契约测试 | `visualContract.test.ts`(16 例) |
| 边界冻结 | 零实现代码:无 Playwright / 解析器 / 网络调用 / migration;shared 只追加未改 |
