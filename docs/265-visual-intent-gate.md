# 265 · 设计意图视觉门禁

> 状态：**第 1 步 skills 已落地；第 2 步官方视觉门禁已落地**（2026-11-11 Asia/Shanghai）。通用视觉契约 skill 与 frontend-vue 落地 skill 已由 `resolveSkills` 声明式注入。切片末官方视觉审查会在跑起来的应用里打开关键态，对照已挂 UI 图做设计意图验收，缺基线或默认皮肤会失败。完整基线上传产品（关键态清单表单）、Figma MCP、封装层脚手架与 ESLint 禁 import **尚未做**（现有 `UI_REFERENCE` 上传已作为最小基线入口接上门禁）。本轮未改 taskflow-vue、`.env` 或沙箱镜像。
> 动机：需求 `d92d5d58-…` 工作流 v11 `2af73768-…` 已于 17:42:37 成功结束，官方 `test` / `e2e` / `slice-boundary` 全绿。用户随后审查产品，认为问题较大：TRD 要求不能直接搬用组件库默认外观，但产品未基于 Element Plus 封装；整体样式距离 UI 图有很大区别，细节更离谱（编辑任务对话框的日期面板仍是默认超大翻页箭头和底部大日历插画）。功能门禁拦不住这类问题，现有「视觉取证」也没有走到会红灯的审查。

相关前文：[docs/20](./20-ui-visual-engineering.md)、[docs/35](./35-phase-5.6-0-visual-contract.md)、[docs/232](./232-feature-triage-execution.md) T3、[docs/264](./264-platform-playwright-browser-contract.md)。讨论口径见 2026-11-11 会话（t216u–t218u）。

---

## 1. 要挡住的是什么

这次漏掉的不是功能错误，是视觉和组件约束从未进入官方验收。

平台其实已经有视觉合同（`VisualSpecification`）、取证（`visualEvidenceService`）和修复闭环（`runVisualFixLoop`），但三条路径都没有成为会失败的门禁：

- 任务级视觉取证只在成功任务碰巧写出可打开的入口页时拍一张静默截图，失败也不挡任务。入口只认 `.html`，Vue SPA 常见 `no-entry-page`；用 `file://` 打开，不会启动应用，也不会打开对话框或日期面板。对照的不是 UI 图，只是「比本项目第一张截图更糟了没」（控制台/网络错误、空图、settle 超时）。
- `runVisualFixLoop` 需要「候选截图 vs 参照截图」。产品没有设计稿上传入口，`VisualSpecification` 在生产代码里零产出，只由测试构造。硬接这条路径会每次都卡在比较。
- 规划侧已有 `providedUiReferences`，但当前条款把它当成可选的「大概长什么样」的草稿：**不做像素级还原、不做 OCR、不进 visualFixLoop**。即使将来挂上 UI 图，也不会变成官方验收。

TRD 第 16 条允许使用 Element Plus 的 Dialog、Form、Input、Select、DatePicker 等，但禁止整页套默认后台模板，视觉必须按 TaskFlow 规范、用 Tailwind 定制。封装是落实这条的正确做法，可它只写在文档里，没有收成可检查规则。这次挂进需求的正文主要是功能向 PRD，智能体为了过测试，直接把默认组件摆上页面就结束了。

因此，问题不在「再提醒一次模型」，而在系统层把基线、规则和官方对照收成门禁。

---

## 2. 严谨度：设计意图门禁，不是像素级还原

成功标准不是像素级还原 100%，也先不等 Figma MCP。Figma MCP 只是日后自动送入同一套基线的入口，不提高严谨度；现在没有接入时，挂上关键 UI 图就能先把门禁立起来。

审查该卡住的是「整体跑偏、细节离谱、直接搬默认组件」，不是 2 像素的偏差。

### 2.1 必须失败

1. **组件契约被打破**：业务页直接引入 Element Plus（或同类库）默认组件并使用默认外观，而不是走项目封装层；或封装层存在，但关键控件仍露出组件库默认皮肤（如默认日期面板的大日历插画、超大箭头）。
2. **与视觉基线的设计意图明显不符**：关键页或关键态的信息层级、布局骨架、色彩与字体体系、主控件外观，和 UI 图差距过大，或细节明显不像设计。
3. **UI 向需求缺少视觉基线却被静默跳过**：该拍的关键页/关键态没有对照图，官方视觉门禁因此没跑，却仍按成功收口。
4. **只靠智能体自报视觉通过**：没有官方截图对照记录，或官方对照未跑/被跳过，不得标为视觉验收通过。

### 2.2 不得失败

- 间距差几像素、颜色略偏、字重或圆角差一点、对齐有轻微偏差。
- 响应式下的合理重排，只要层级和主控件意图还在。
- 仅有像素差分、没有「意图不符」或「默认组件」证据。现有 `packages/visual` 里冻结的像素阈值（如 `PASS_DIFF_RATIO_MAX = 0.02`、几何位移 8px）**不得**作为本门禁的通过条件；像素热力图只作辅助证据，不单独判红。

### 2.3 怎么判

分两层，都不把「智能体说通过了」当作证据：

- **确定性层**（不依赖视觉模型）：封装与 token 规则、业务页禁止直接引用组件库、关键控件走封装选择器。这一层就能拦住「直接搬默认组件」。
- **对照层**（官方截图 vs 基线）：在跑起来的应用里打开规定状态再拍，用设计意图清单判断，而不是像素差分。清单只问：层级对不对、是不是设计体系、主控件是不是默认皮肤、有没有明显离谱的细节。若平台当时没有可用的视觉判断器，仍须留下官方截图，并跑确定性检测（例如默认 Element Plus 面板特征）；不得假装已经对照通过。缺少判断器是平台能力问题，应记为配置/能力缺口，而不是把视觉门禁标绿。

修复成功的唯一标准，同样是官方视觉门禁再跑并通过，而不是智能体结论。同一证据、同一任务类型、同一写权限只修一次，再失败则收工，避免为了追像素空烧。

---

## 3. 系统要做的四件事

### 3.1 新建需求必须挂视觉基线，且不可静默跳过

UI 向需求在进入规划前，必须挂上关键页面和关键态的 UI 图，作为官方视觉基线。至少覆盖该需求实际出现的：主列表/主工作台、对话框、日期面板、下拉、空状态。没有对应态的，在基线清单里显式标「本需求不含」，而不是漏项。

这就是 [docs/232](./232-feature-triage-execution.md) T3 指出的缺失参照侧：把上传入口补进需求接入，生产路径要能从这些图生成（或绑定）`VisualSpecification` / `VisualInputRecord`，不再只由测试构造。

缺少必选基线时，不得静默跳过视觉审查。应在接入或规划前挡住，或在切片末以 `VISUAL_BASELINE_MISSING` 失败。不要把「没有图」解释成「没有视觉要求」。

非 UI 向需求（纯文档、纯脚本等）可以没有基线，但判定必须是平台根据任务/能力面做出的，不能由智能体口头声明后跳过。

Figma MCP 接入后，只作为同一基线的自动来源（已有 figma URI 形态可复用），不另搞一套更严的还原标准。

规划条款 `PROVIDED_UI_REFERENCES_CLAUSE` 需要改语义：有基线时，它们是官方对照对象，而不再只是「可选的大概样子」。仍然明确：**不是像素级规格**。

### 3.2 切片末增加官方视觉门禁

时机与官方 E2E 对齐：只在切片末和 CI 跑，中间实现任务不跑全量视觉对照，以免把交付卡在反复截图上。

门禁必须在**跑起来的应用**里执行（开发服务器或预览），禁止再用 `file://` 打开孤立 HTML 充当 Vue SPA 的验收。按基线清单打开关键态——包括对话框、日期面板、下拉展开、空状态——各拍一张，与对应 UI 图对照。

官方结果写入 `TASK_VERIFICATION`（或并列的视觉检查项）。对照不过、关键态打不开、或基线缺失被跳过，门禁失败。智能体自报「已按 UI 图实现」不能把这项改绿。

浏览器与运行时走 [docs/264](./264-platform-playwright-browser-contract.md) 的平台契约（当前钉 Playwright 1.64.1 / Chromium 1248），禁止在沙箱里现装浏览器。视觉失败分流到 `VISUAL` / `FRONTEND`，不得收成 `ENV_GAP` 或 `BUILD` 去装环境。官方反空烧指纹同样生效。

### 3.3 把组件和视觉约束收成可检查规则

TRD 里的视觉/组件约束要变成平台可执行的架构规则，而不是只出现在提示词里。

约束分两层，避免把某一套框架写进通用规则：

1. **通用契约 skill**（`visual-intent-contract`，框架无关）：业务界面必须走项目封装层；颜色/字体/间距/圆角只引用设计 token；关键页和关键态对照已挂视觉基线，达到设计意图而不是像素还原；官方视觉门禁通过才算视觉验收通过。正文不得出现具体框架或组件库名称。
2. **能力面落地 skill**：只写契约到该技术栈的映射。当前仅有 `frontend-vue` 的 `vue-visual-contract`（封装目录约定、业务页禁止直接 `from 'element-plus'`、Dialog/Form/Input/Select/DatePicker 等走包装组件、token 怎么引用）。以后若有 React 等能力面，另建对应 skill，由 `resolveSkills` 按 `capabilityProfile` 注入；Vue 落地 skill 不得进入非 Vue 任务。

平台在建任务或 REPLAN 时由 `resolveSkills` 声明式注入，模型不自选。会改 UI 的前端实现/修复类任务（`FRONTEND`，以及 `frontend-*` 画像上的 `DEBUG`）注入通用契约；`capabilityProfile === frontend-vue` 时再加 `vue-visual-contract`。纯 TEST / BACKEND / 文档类任务，以及 `SPEC_CONFLICT`，不注入这两份。

脚手架和静态检查仍要补上（**本轮未做**）：

1. **封装层脚手架**：对 Dialog、Form、Input、Select、DatePicker、Pagination、Message 等允许使用的组件做项目包装，默认皮肤和设计 token 在包装层消化。
2. **设计 token 与 ESLint / 架构规则**：页面和封装层只引用 token；禁止业务视图直接 `from 'element-plus'`（测试夹具与封装层本身除外）。

即便 TRD 允许使用 Element Plus 原语，平台仍应要求走封装——否则「用 Tailwind 定制、禁止默认后台模板」无法检查，这次的默认日期面板还会再出现。Skills 负责把正确写法产出来，静态检查和日后的官方视觉门禁负责拦住没按这个写的结果。

### 3.4 视觉审查必须是真正的审查任务

视觉审查不能再停留在「取证事件」或智能体叙述。切片末的审查/复核任务，其视觉结论必须以官方截图对照为准：官方通过才是通过，官方失败就是失败。

不把旧的 `runVisualFixLoop` 按像素差分直接接进生产工作流（[docs/232](./232-feature-triage-execution.md) T3-7 已裁定当时不要为视觉回归自动开 FIX）。本方案若开修复，只针对官方视觉门禁的失败证据，类型为 FRONTEND（或专门的 VISUAL 修复），目标是设计意图通过，并受轮次和反空烧限制。不要为 2% 像素差循环改下去。

---

## 4. 建议落地顺序

不一次铺开。推荐分三步，每步都可单独验收：

1. **先立规则和基线入口**（收益最大、也最不依赖视觉模型）：需求接入可上传/挂载关键 UI 图与关键态清单；缺基线不可静默跳过；脚手架 + skills + 静态检查落地封装层和 token；业务页禁止直接引用组件库。仅这一步，就应能拦住本次「直接搬默认 DatePicker」这类问题。**本轮已做其中的 skills 分层与声明式注入**（见 §8）；基线上传入口、封装层脚手架、ESLint 禁 import 仍待做。
2. **再上官方视觉门禁**：**已落地**（见 §9）。切片末在运行中的应用打开关键态，对照基线做设计意图验收，写入官方验证，失败则按 VISUAL → FRONTEND 修一次。审查任务的视觉结论绑定该结果。
3. **最后接 Figma MCP**（可选）：只把 Figma 文件自动转成第 1 步的同一套基线。不改严谨度，不把像素还原当作新标准。

---

## 5. 拟接线（落地时再改，本轮不动）

1. 需求接入：UI 基线上传与关键态清单；缺基线的失败码 `VISUAL_BASELINE_MISSING`。**最小路径已接**：现有 `UI_REFERENCE` / `providedUiReferences` 升级为官方基线；结构化「关键态清单」表单未做，清单由平台按文件名、说明和需求正文推断，未声明的态记为「本需求不含」。
2. 生产路径生成或绑定 `VisualSpecification` / `VisualInputRecord`，不再仅由测试构造。**本轮未生成完整 VisualSpecification**；门禁直接读取已挂 UI 图作为对照基线。
3. 规划条款：更新 `PROVIDED_UI_REFERENCES_CLAUSE`。**已落地**（有图即官方设计意图对照对象，仍不是像素级规格）。
4. 官方门禁：切片末 / CI 增加视觉检查；在运行中的应用打开关键态；结果写入官方验证。**切片末已落地**（`visual` 检查，与官方 E2E 同一锚点）。专用 CI 交付链视觉探针未另建，走同一套官方验证即可。
5. 分流与反空烧：`VISUAL` / `FRONTEND`，不得误判为 `ENV_GAP`；同一官方视觉证据只修一次。**已落地**。
6. frontend-vue 模板与 skills：封装层、token、业务页引用限制、声明式注入。**Skills 文本与注入已落地**（§8）；模板封装层与静态检查未做。
7. 评审任务：视觉结论读取官方对照，而不是智能体自报。**已落地**（`verification.officialVisual` 压缩投影）。

---

## 6. 刻意不做

- 不以像素级还原、像素差分阈值或热力图作为通过条件。
- 不等待 Figma MCP 才开始第 1、2 步。
- 不在每个中间任务上跑全量视觉对照。
- 不把官方视觉门禁标成非阻塞来换收口。
- 不把旧视觉修复闭环按像素差直接接到生产工作流，也不为轻微偏差循环空烧。
- 本轮不改 taskflow-vue 产品代码，不改 `.env`，不切换 LLM 提供方，不重建沙箱镜像。
- 官方 E2E 功能门禁保持阻塞，本方案是补视觉层，不是替换它。
- 本轮 **不** 实现 Figma MCP、产品封装层脚手架、ESLint 禁 import，也不做完整的关键态清单上传表单或 VisualSpecification 生产生成器。

---

## 7. 落地后怎样算成功

用这次已经漏过的例子验收，而不是用「看起来更严了」验收：

- 业务页直接使用未封装的默认 DatePicker（超大箭头、默认日历插画），确定性层或官方对照必须失败。
- 整体样式与已挂 UI 图差距过大，官方对照必须失败。
- 间距或颜色只有轻微偏差，不得失败。
- 没有 Figma、只挂了关键 UI 图时，门禁仍能跑。
- 缺基线不得静默通过。
- 智能体自报视觉通过、官方对照未过时，任务不得标成功；修复必须以官方再跑通过为成功。

---

---

## 8. 本轮已落地：视觉/组件契约 skills（2026-11-11 Asia/Shanghai）

按「通用契约 + 按能力面落地」写入平台，由现有 `resolveSkills` → `AgentRegistry.resolveTask` 声明式注入（建任务 / REPLAN 时写入 `## Injected skills`，模型不自选）。

### 8.1 Skill 名称与路径

| Skill | 路径 | 作用 |
| --- | --- | --- |
| `visual-intent-contract` | `packages/agent-core/skills/common/visual-intent-contract/SKILL.md` | 框架无关的四条契约：走封装层、只用设计 token、对照已挂基线达到设计意图（非像素还原）、官方视觉门禁才算通过。正文不含具体框架/组件库名称。 |
| `vue-visual-contract` | `packages/agent-core/skills/frontend-vue/vue-visual-contract/SKILL.md` | 只做契约到 Vue 栈的映射：封装目录、业务页禁止直接 `from 'element-plus'`（封装层和测试夹具除外）、Dialog/Form/Input/Select/DatePicker 等走包装组件、token 引用方式。不重复抄写通用契约。 |

解析与注入：`packages/agent-core/src/professional/skillResolver.ts`。未新建 `frontend-react` skill。

### 8.2 注入条件

| 条件 | 注入 |
| --- | --- |
| `FRONTEND`（任意 capabilityProfile，且不是 `SPEC_CONFLICT`） | `visual-intent-contract`；若 profile 为 `frontend-vue`，再加 `vue-visual-contract`（以及既有的 `vue-implement` / `vue-test-fixture`） |
| `DEBUG` + `frontend-*` profile（不是 `SPEC_CONFLICT`） | `visual-intent-contract`；`frontend-vue` 再加 `vue-visual-contract`（以及既有的 `vue-test-fixture` / `vue-debug-repair`） |
| `TEST` / `BACKEND` / `REVIEW` / `BUILD` / `DATABASE` / `ANALYSIS` / `DESIGN` 等非 UI 实现任务 | 不注入这两份视觉 skill |
| `failureClass=SPEC_CONFLICT` | 不注入这两份（frontend-vue 仍只注入 `vue-test-fixture`） |
| 非 `frontend-vue` profile（如已有测试中的 `backend-node`，或占位的 `frontend-react`） | 不得注入 `vue-visual-contract` 或其它 Vue pack skill；`FRONTEND` 可以只有通用契约 |

### 8.3 本轮已做 / 未做

**已做**

- 通用契约 skill 与 Vue 落地 skill 入库。
- `resolveSkills` 按任务类型 / 失败类 / 能力面声明式注入；单测覆盖：通用文本不含框架名、frontend-vue 实现/修复同时注入两份、非 Vue profile 不得注入 Vue 落地 skill、非 UI 任务类型不注入这两份。

**未做（第 1 步结束时；第 2 步见 §9）**

- 官方视觉门禁（切片末在运行中的应用打开关键态对照基线）。→ **第 2 步已做**
- 需求侧视觉基线上传入口与 `VISUAL_BASELINE_MISSING`。→ **最小路径已接**（现有 UI 图上传 + 缺基线失败码）；结构化清单表单未做。
- Figma MCP。
- 产品/模板封装层脚手架，以及 ESLint / 架构规则禁止业务页直接引用组件库。
- 不改 taskflow-vue 产品代码。


---

## 9. 本轮已落地：官方视觉审查门禁（2026-11-11 Asia/Shanghai）

按「设计意图门禁」落地切片末官方审查，不把像素级还原当作通过条件，也未接 Figma MCP。

### 9.1 何时跑

与官方 E2E 同一锚点：只在切片最后一个经验证门的任务上跑（`TaskVerifier.maybeSliceBoundaryCheck` → `sliceEndVisualCheck`）。中间实现任务不跑全量视觉对照。非 UI 向工作（`backend-node` 且切片没有 FRONTEND 任务）记 `visualSkipped: not-ui-facing`，允许没有基线。UI 向工作由平台按能力面（`frontend-*` / `boundaryCheck: ui`）或切片内 FRONTEND 任务判定，不能由智能体口头跳过。

### 9.2 基线从哪里读

生产路径读取需求文档里已有的 `UI_REFERENCE`（规划侧的 `providedUiReferences`），升级为官方视觉基线。`PROVIDED_UI_REFERENCES_CLAUSE` 已改为：有图时它们是官方设计意图对照对象，仍然不是像素级规格。

关键态清单（主页面、对话框、日期面板、下拉、空状态）由平台根据基线文件名/说明和需求正文推断。已声明但没有对应图 → `VISUAL_BASELINE_MISSING`。未声明的态记为「本需求不含」（推断或显式「不含」）。本轮没有新增独立的关键态清单上传表单。

### 9.3 怎么跑、怎么对照

门禁在工作区用 `start` / `preview` / `dev` 拉起应用（可附带既有 mock/build 路径），用平台契约内的 Playwright 打开 `http://127.0.0.1`，按清单打开关键态并截图。禁止 `file://`。

判断口径分两层，都不把智能体自报当作证据：

1. **确定性层**（不依赖 VLM，是默认判断器）：基线是否存在、关键态是否打开、能否对照到清单项；以及可稳定识别的默认组件库皮肤（例如未封装的日期面板、默认大日历插画、超大翻页箭头）。
2. **可选意图判断器**：若配置了 `visualIntentJudge` 且回报明显不符，记 `VISUAL_INTENT_MISMATCH`。通过条件是设计意图清单，不是 `PASS_DIFF_RATIO_MAX` 或 2% 像素差。轻微间距/颜色/像素差不得单独判红。未配置 VLM 时，只要确定性层跑完且通过，可以过门禁，但记录为 `judged: deterministic`，不得声称模型已对照通过。若还没有官方截图或对照未发生，记 `VISUAL_JUDGE_UNAVAILABLE` / `VISUAL_CAPTURE_FAILED`，视觉项不能标绿。

官方结果写入 `TASK_VERIFICATION.checks[]` 中名为 `visual` 的检查。审查/修复任务通过压缩投影 `verification.officialVisual` 读取该结论。

### 9.4 失败码与分流

| 失败码 | 含义 |
| --- | --- |
| `VISUAL_BASELINE_MISSING` | UI 向需求没有可用基线，或已声明关键态没有对应图 |
| `VISUAL_STATE_UNREACHABLE` | 规定关键态在运行中的应用里打不开 |
| `VISUAL_DEFAULT_SKIN` | 露出组件库默认皮肤 |
| `VISUAL_INTENT_MISMATCH` | 可选判断器认定与基线设计意图明显不符 |
| `VISUAL_CAPTURE_FAILED` | 应用起不来、探针无记录、或使用了 `file://` |
| `VISUAL_JUDGE_UNAVAILABLE` | 对照尚未发生，不能把视觉项标绿 |

分类为 `VISUAL`，修复任务类型为 `FRONTEND`（或能力面 `fixFallback`）。不得收成 `ENV_GAP`，不得开 BUILD 去装浏览器。同一官方视觉证据指纹 + 同一类型 + 同一写权限只修一次（复用既有 `priorOfficialEvidence`）。未把旧的 `runVisualFixLoop` 像素差分接到生产工作流。

### 9.5 本轮仍未做

- Figma MCP。
- 封装层脚手架与 ESLint 禁止业务页直接 `from 'element-plus'`。
- 完整的关键态清单上传 UI / 设计稿管理产品；缺图时门禁会红，但上传仍走既有 UI 参照入口。
- 生产路径生成完整 `VisualSpecification`。
- 未配置视觉模型时，不做自动的「整体样式是否与 UI 图差太远」VLM 判定（确定性层仍拦默认皮肤、缺基线、关键态打不开）。
