# Phase 5.7-1 Repair — Browser Observation Security(敏感输入隔离)

> 任务书:用户提供的 "Phase 5.7-1 Repair — Browser Observation Security"
> 状态:**PASS** — 凭据语义输入的两个通道(结构化)隔离完成,真实 Chromium E2E 锁定
> 完成日期:2026-09-13
> 开发模式:ponytail(结构化屏蔽 + 单脚本双通道,零新系统)+ 以代码为准

---

## 1. Status

**PASS** — 修复目标全数达成:

```text
credential-semantic field (type=password / autocomplete=password|one-time-code)
        → 值永不离开页面(结构化,不依赖 regex)
        → Observation/ActionResult/audit 均无原文(真实 Chromium E2E 锁定)

ordinary input → 值照常可观察
```

- browser **34/34**(33 基线 + 1 安全 E2E);server **51/51**;全仓四门禁 exit 0(见 §8);
- 5.7-0 契约 / ToolRuntime / AgentRuntime / Workflow Engine / 5.7-2~5.7-5 零触碰。

## 2. 修改 / 新增文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `packages/browser/src/browserSession.ts` | 修改 | 观察脚本重写为双通道单脚本:敏感字段结构化屏蔽(value 永不入节点/树);无障碍树改为**受控派生**(不再消费会泄漏的 `page.ariaSnapshot()`);`observe()` 单次评估 |
| `packages/browser/src/session.ts` | 修改 | `PageLike` 移除 `ariaSnapshot()`(泄漏面退出接口) |
| `packages/browser/src/__tests__/browserSession.test.ts` | 修改 | harness 同步(移除 ariaSnapshot 假件) |
| `packages/browser/src/__tests__/computerUse.e2e.test.ts` | 修改 | +1 安全 E2E(真实 Chromium + 本地 http fixture:值不经过 URL) |

**未触碰**:`computerUseTools.ts`(适配层映射不变)、5.7-0 契约、observability 脱敏单源、
ToolRuntime、AgentRuntime、Workflow Engine、5.6 Browser Tool 注册表、docs/52(历史报告)。

## 3. 问题与实证(先探针,后修复)

修复前真实 Chromium 探针(packages/browser 一次性脚本,已删)证明**双通道泄漏**:

1. **DOM 通道**:`input.value → Observation.text/name` —— password 值
   `ArbitraryP@ss-007` 原样进入观察;
2. **Accessibility 通道(更严重)**:Playwright `page.ariaSnapshot()` 将 textbox
   **值明文渲染**,password 值同样明文;且长值被**缩写**(`sk-liv...cdef`),
   导致凭据形状 regex 也无法命中 —— 属"regex 之外的泄漏",仅靠脱敏不可解。

结论:必须**结构性**修复(任务书"不要只靠 regex")。

## 4. 修复实现

### 4.1 结构化敏感判定(页面内,非 regex)

```text
sensitive := (INPUT 且 type=password)
          或 (INPUT/TEXTAREA/SELECT 且 autocomplete ∈ {*password*, one-time-code})
```

命中时:**值永不离开页面**;节点携带 `type/role/name/hasValue` 语义 +
显式掩码标记,而不是真实值:

- `name` = aria-label / placeholder(页面自述,非值);无则 `"password input"`
  / `"credential-like input"`;
- `text` = `[value hidden: password input; hasValue: true|false]`
  (`credential-like …` 同理)—— `hasValue` 语义经标记承载(5.7-0 节点为
  strict schema,不新增字段,见 §7)。

### 4.2 无障碍通道 = 受控派生树(结构只读)

- 观察脚本一次遍历同时产出 `nodes` 与 `tree`(role + accessible-name + DOM 深度缩进);
- **树完全不携带任何表单值**(普通字段也不带)——从构造上保证该通道
  不可能泄漏"结构性无法识别"的任意秘密(如 textarea 任意内容);
- 普通字段的值仍可经 **DOM 通道**观察(满足"普通 input value 可正常观察");
- 敏感字段在树中带 `[value hidden]` / `[value absent]` 标记;
- 既有 regex 脱敏(docs/52 层)继续作用于所有出站字符串(两通道通用)。

### 4.3 其余

- `PageLike.ariaSnapshot()` 移除(泄漏面退出接口,无其他消费者);
- `observe()` 单次 `evaluate`(两通道同源,确定性不变);树照旧 200k 截断 +
  脱敏 + `interactiveCount` 行计数。

## 5. 真实 Chromium E2E(新增,本地 http fixture)

fixture `PAGE_SENSITIVE_HTML`(经 `127.0.0.1` http 服务;值只在 HTML body,
不经过 URL——见 §7 迭代记录):

| 场景 | 断言 |
|---|---|
| password `value="ArbitraryP@ss-007"`(任意值,regex 不可见) | Observation / ToolResult(+audit)/ a11y 树 **均不含原文**;节点 = `[value hidden: password input; hasValue: true]`,role=textbox,clickable=true |
| `autocomplete=one-time-code` `"918273"` | 同上(credential-like 掩码) |
| `autocomplete=new-password` `"hunter2-arbitrary"` | 同上 |
| 普通输入 `"visible-ok"` | **照常可观察**(`text === "visible-ok"`;树中 `textbox "plain field"` 但无值) |
| `<textarea>` 凭据形状内容 | 两通道均无原文,`[REDACTED]`(regex 层) |
| `<textarea>` 普通内容 | 可观察(边界:无凭据信号的内容按普通内容处理) |
| Observation Schema | `ObservationSchema.parse(observation)` 严格通过(5.7-0 未改) |
| 导航结果(含其观察) | 亦无原文(URL 无秘密即可逐字节断言) |
| screenshotRef | 不受影响(`screenshot://browser:cu:sec/1.png`) |

既有回归用例(DOM/Accessibility/click/type/navigate/screenshot/ToolRuntime/
timeout/cancellation)全部保留并通过。

## 6. Regression

- browser 34/34;server 51/51;全仓四门禁与总数见 §8;
- 既有 5.7-1 全链路 E2E、治理封套 E2E、server 权限/Agent 路径 E2E 全部保持通过;
- 5.6 系(visual/web/mcp/database/agent-core/...)数值不变。

## 7. 迭代记录 / 设计决策

1. **data:URL fixture 使"URL 含密"**——首版安全 fixture 把密值嵌在 data:URL 中,
   `actionRef.target` 原样承载 URL 导致断言失败;改用本地 http 服务后值只存在于
   HTML body,**真实场景中值也不经过 URL**,断言因此可以覆盖"导航结果无原文"。
   (URL 中任意非凭据形状的秘密无法被结构性识别——同类边界见 §9。)
2. **5.7-0 strict 节点无法新增 `type` 字段**——用 `text` 掩码标记承载
   `type/hasValue` 语义(契约零修改的强制结果);报告如实记录该取舍。
3. **树为何"一律不带值"**——若普通值进入树,则"任意秘密"在树中同样结构化
   不可识别;去掉值使该通道绝对安全,而"普通值可观察"由 DOM 通道满足。

## 8. 全仓回归

批次 proc_9829802208f9(根脚本):`TYPECHECK_EXIT=0 LINT_EXIT=0 TEST_EXIT=0
BUILD_EXIT=0`,**TOTAL 558/558,0 failed**(557 基线 + 1 新安全 E2E;分包见最终报告)。

## 9. 已知限制

1. **任意秘密的语义边界**:credential 语义(type/autocomplete)结构性隔离;
   凭据**形状**经 regex 脱敏单源;二者皆无信号的内容(如普通输入/文本区的
   任意字符串)按普通内容观察——与既有 5.7-1 政策一致,是"可观察性"与
   "不可知秘密"的固有边界。
2. 无障碍通道为**受控派生树**(role+name+缩进),不是 Chromium 原生 aria 树
   (原生树含值渲染,已因泄漏被替换);iframe/aria-labelledby 等高级语义
   降级为近似——换取"该通道构造上零值泄漏"。
3. 掩码标记为英文形态(`[value hidden: …]`),消费方按约定解析;5.7-0 节点
   无独立字段可承载 type/hasValue。
