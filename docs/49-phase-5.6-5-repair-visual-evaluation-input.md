# Phase 5.6-5 Repair #2 — Visual Evaluation Input Fix(截图驱动重评估)

> 任务书:用户提供的 "Phase 5.6-5 Repair — Visual Evaluation Input Fix"
> 状态:**PASS** — Candidate 侧改为真实截图字节驱动,双截图进入 5.6-4 冻结评估
> 完成日期:2026-09-13
> 开发模式:ponytail(改注入点 + 测试替身,零新运行时)+ 以代码为准

---

## 1. Status

**PASS** — 修复目标全数达成:

```text
Reference Screenshot + Candidate Screenshot
        ↓
5.6-4 Visual Evaluation(冻结的 evaluateVisuals,零算法改动)
        ↓
Visual Issues → Fix Loop → RESOLVED / NEW_ISSUE / REGRESSED
```

- Candidate Screenshot 本身进入 `evaluateVisuals`(不再是 URL/HTML 结构替代);
- Reference 与 Candidate 双侧均为真实 Chromium 截图,配对关系逐轮记录;
- Visual score 与 Visual Issues 均来自该次真实截图评估;
- 三态判定只来自截图比较,从未使用 Agent 自报结果;
- 5.6-4 评估算法与 browser 运行时零改动。

## 2. 修改 / 新增文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `apps/server/src/services/visualFixLoop.ts` | 修改 | 候选侧注入点改为 `analyzeCandidateScreenshot(input)`:`{round, assetRef, base64, viewport}` —— **base64 为真实截图字节**,在截图后立即交给分析器;evaluation 记录新增 `candidateSource`/`referenceSource`(配对可查);头注释更新为截图驱动语义 |
| `packages/visual/src/index.ts` | 修改(1 行) | barrel 追加 `buildSpecification`(截图分析替身复用 5.6-1 归一化管线;`decodeMinimalPng` 此前已导出) |
| `examples/visual-fix-test-project/**` | 修改 | 页面改为**分色带渲染**(#112233 Header / #445566 Body / #778899 Footer,满宽定高),共享壳加 `body{margin:0}`;design.body.html = Header+Body 带;初始页只有 Header 带;fixture sanity 测试与 README 同步 |
| `apps/server/src/__tests__/visualFixLoop.e2e.test.ts` | 重写 | 删除 URL 分析链;新增**确定性截图分析替身**(解码真实 PNG 字节 → 逐行扫描中心列 → 色带 → 5.6-1 buildSpecification 归一化 → frozen schema);Reference 侧同样由参考截图生成;断言新增 `candidateSource == browser.assetRef`、`referenceSource` 配对、真实截图字节量(>1000) |
| 13 处 postgres 测试容器启动点 | 修改 | `packages/database` 5 处 + `apps/server/src/__tests__` 8 处:统一加 `--tmpfs /var/lib/postgresql/data`(见 §6 根因修复) |
| `package.json`(根)、`apps/server/vitest.config.mjs` | 曾修改后**回退** | 基于误判的串行化已回退为原始配置(见 §6.5) |
| `docs/17` / `docs/18` / `docs/23` / `docs/44` | 修改 | 状态与注记 |

**未触碰**:5.6-4 评估算法(0 行)、5.6-3 browser 运行时(0 行)、5.6-2/5.6-6 产物、
workflow-engine、shared 契约、历史报告 docs/41、docs/48(上一版修复记录保持)。

## 3. 截图驱动设计(核心修正)

旧路径(被替换):

```text
Candidate 页面 HTML ──(URL 分析)──► candidate specification ─┐
Candidate 截图(仅 base64)───────────────────────────────┼─► evaluateVisuals
Reference spec(截图为辅)────────────────────────────────┘
```

新路径(本修复):

```text
Browser 截图(真实 Chromium,PNG)──► analyzeCandidateScreenshot
   {round, assetRef, base64, viewport}         │
                                               ▼
                        候选 specification + analysis(截图字节唯一来源)
Reference Screenshot(同样截图分析链)──► reference side
                                   │
                                   ▼
        evaluateVisuals(reference, candidate)   ← 5.6-4 冻结入口,零改动
                                   │
                    Visual Issues(来自本次截图评估)
                                   ▼
                    Fix Loop(三态判定 → 下一轮 / STALLED / MAX_ROUNDS)
```

- 生产接线:注入点内用 5.6-1 截图分析链(`analyzeUnifiedInput(fromVLMProvider(realVlm))`)
  与真实 VLM;本 runner 不依赖任何 HTML/DOM 解析(仅允许的辅助结构信息
  `knownGapSections` 仍保留在 `CandidateAnalysis` 契约中,本轮未使用)。
- 截图字节校验:分析替身在解码后校验尺寸 == viewport(不一致即报错),
  防止截图/配对错位静默通过。
- 每轮证据:`evaluation.candidateSource` 等于该轮 `browser.assetRef`
  (`screenshot://<sessionId>/<seq>.png`),`referenceSource` 为参考截图资产,
  audit trail 同侧引用 —— 「Candidate Screenshot 与 Reference Screenshot
  正确关联」可直接从记录核验。

## 4. 测试替身(确定性,替代真实 VLM)

E2E 中 VLM 用**像素级确定性替身**(真实截图字节 → 解码 → 中心列逐行扫描):

1. `decodeMinimalPng`(既有 stdlib 实现)解码真实 Chromium PNG;
2. 逐行取中心像素颜色;连续同色非背景行 = 一个 section 色带;
3. 色带颜色映射 fixture 调色板 → section 名(#112233→Header / #445566→Body /
   #778899→Footer;未知色回落 `Color-<hex>`);
4. 走**既有** 5.6-1 `buildSpecification` 归一化(确定性 id/排序/clamp)→ frozen schema;
5. `buildAnalysisReport` 生成 side 的 analysis。

这保证:score 与 issues 完全由**真实渲染像素**决定(页面画什么色带,评估就
看什么色带);页面改动(增/删/改色带)一定会改变评估结果。事前已用一次性探针
验证真实 Chromium 截图可被 `decodeMinimalPng` 无损解码(400x300 → #112233/
#445566/白逐行正确)。

## 5. 三态/循环结果(四场景,截图驱动,真实证据)

| 场景 | 轮次(页面改动) | 结果 | 关键断言 |
|---|---|---|---|
| A resolved | 实现设计正文(补齐 Body 带) | `RESOLVED` → `DONE` | 初始截图评估 issue `issue:desktop:section:body:2`;round1 **score PASS**(逐像素一致 → diff 0)、resolvedIssues 含该 issue;`candidateSource == browser.assetRef` 且 `screenshot://`;`referenceSource` 配对;磁盘文件 == 设计正文;audit 含 RESOLVED + autoSubmitted:true |
| B new issue | 错误修复(Footer 带) → 正确实现 | `NEW_ISSUE` → `RESOLVED` → `DONE` | round1 截图评估 newIssues 含 `issue:desktop:section:footer:2`、score COMPONENT(≠PASS)、candidateSource 为截图;round2 score PASS 且两类 issue 全部 resolved |
| D no progress | 同一错误修复 ×2 | `STALLED`(2 轮,未达上限) | round2 unchangedIssues=body+footer、newIssues=[]、resolvedIssues=[];handoff WAITING_APPROVAL/REPLAN("no visual progress") |
| E regression | 错误修复 → 巨块加深 → 不变 | `NEW_ISSUE` → `REGRESSED` → `NEW_ISSUE` → `MAX_ROUNDS` | round1 COMPONENT → round2 **LAYOUT**(score 严格变差、newIssues=[]、candidateSource 为截图)→ round3 无进展;3 轮达上限;handoff reason 含 maxRounds;audits=3 |

场景 A 另断言:参考侧截图为真实字节(>1000)、会话截图字节 >1000、
networkErrors=0(loopback 零外网)。

## 6. 测试基础设施:全量门禁 flake 的根因修复(本次一并收口)

此前多轮全量批次偶发失败(命中过 deliveryApi 404、agentRunPersistence 时序、
deliveryLifecycle 360s 超时;单跑全部通过),本轮完成**根因定位与修复**:

1. **误判阶段**:最初归因跨包并发争用,曾加 `fileParallelism: false`
   (server)与 `--workspace-concurrency=1`(根),单包串行连续通过,但全量
   批次仍复现 —— 说明并非争用。
2. **根因**:`docker system df` 显示 **793 个匿名卷 ≈ 39.56GB**(postgres
   测试容器 `--rm` 只删容器,不删镜像 VOLUME 声明的匿名卷)→ Docker VM
   磁盘压力 → 容器启动超时/"No such container" → 任意 docker-heavy 文件
   失败(哪个先跑哪个先挂,故每次症状不同)。
3. **环境清理**:`docker volume prune` 回收 39.35GB;database 包立即全绿。
4. **真修复**:全部 13 处 postgres 测试容器启动点(5 处 packages/database +
   8 处 apps/server)加 `--tmpfs /var/lib/postgresql/data` —— PGDATA 落
   tmpfs,不再产生匿名卷。受控实测:database 包(7 容器)9→9、deliveryApi
   9→9、server 全包(13 文件 46 用例)9→9,**每轮零泄漏**。
5. **回退误判性措施**:根 `test` 脚本与 `apps/server/vitest.config.mjs` 恢复
   原始并行配置(docs/48 §7.5 记录的两项串行化已由本根因修复替代)。
   并行配置下 database 33/33、server 46/46 全绿。

属测试基础设施修复,不改任何产品语义。

## 7. 测试结果 / Regression

- server:**46/46**(42 基线 + 4 场景 E2E,截图驱动版本);
- 全仓四门禁(根脚本,原始并行配置):`TYPECHECK_EXIT=0 LINT_EXIT=0
  TEST_EXIT=0 BUILD_EXIT=0`,**TOTAL 532/532 passed,0 failed**;
  分包:observability 2 | shared 39 | workflow-engine 14 | web 51 | visual 78 |
  sandbox 2 | tool-runtime 11 | browser 18 | agent-core 37 | mcp 201 |
  database 33 | server 46。
- 确定性复验:全量 `pnpm test` 连续两轮 532/532、0 failed;两轮前后
  `docker volume ls` 计数稳定(9→9,零新增匿名卷)。
- 5.6-0~5.6-4 产物零触碰;5.6-3 browser 运行时零触碰;5.6-4 冻结算法零改动。

## 8. 已知限制

1. E2E 的截图分析替身是确定性像素带识别(色带调色板为 fixture 约定);
   生产用真实 VLM 时同一注入点无需代码改动。
2. 结构辅助信息(`knownGapSections`)契约保留但本 runner 未使用。
3. 像素带识别忽略 8px 以下色带(抗噪);真实页面分析由 VLM 承担,不受此限。
4. handoff 仍为信号(WAITING_APPROVAL/REPLAN),人审动作由既有 workflow 链执行。
5. `--tmpfs` PGDATA 使 postgres 测试容器数据不落盘(测试场景下无影响);
   历史遗留匿名卷已通过 `docker volume prune` 清理(环境级操作,非仓库变更)。

## 9. 全仓回归

- 批次 proc_3646838680e5(根脚本 `pnpm typecheck / lint / test / build`,
  原始并行配置):四门禁全部 exit 0,TOTAL **532/532**,0 failed。
- 批次 proc_06d6dd92c4f6(全量 `pnpm test` 复验):exit 0,**532/532**,0 failed。
- 两批次前后 docker 匿名卷计数稳定(9→9);database / server 受控泄漏测试
  均为 0 增量(见 §6.4)。

