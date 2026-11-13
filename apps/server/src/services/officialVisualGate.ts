/**
 * docs/265 第 2 步：切片末官方视觉审查（设计意图门禁，不是像素级还原）。
 *
 * 纯规则与命令构造都在本文件，便于单测、不依赖外网或本机已装浏览器。
 * 时机与官方 E2E 对齐，只在切片末 / 同一套官方验证里跑。
 * 必须在跑起来的应用（start / preview / dev）上打开关键态，禁止 `file://`。
 */
import type { CapabilityProfile, Task } from "@ai-se/shared";

export const VISUAL_STATE_KINDS = [
  "page",
  "dialog",
  "date-panel",
  "dropdown",
  "empty"
] as const;

export type VisualStateKind = (typeof VISUAL_STATE_KINDS)[number];

export const OFFICIAL_VISUAL_CHECK_NAME = "visual" as const;
export const OFFICIAL_VISUAL_GATE_MARKER = "OFFICIAL_VISUAL_GATE";

export type OfficialVisualFailureCode =
  | "VISUAL_BASELINE_MISSING"
  | "VISUAL_STATE_UNREACHABLE"
  | "VISUAL_DEFAULT_SKIN"
  | "VISUAL_INTENT_MISMATCH"
  | "VISUAL_CAPTURE_FAILED"
  | "VISUAL_JUDGE_UNAVAILABLE";

export const OFFICIAL_VISUAL_FAILURE_CODES: readonly OfficialVisualFailureCode[] = [
  "VISUAL_BASELINE_MISSING",
  "VISUAL_STATE_UNREACHABLE",
  "VISUAL_DEFAULT_SKIN",
  "VISUAL_INTENT_MISMATCH",
  "VISUAL_CAPTURE_FAILED",
  "VISUAL_JUDGE_UNAVAILABLE"
];

export function isOfficialVisualFailureCode(
  value: string | undefined
): value is OfficialVisualFailureCode {
  return (
    typeof value === "string" &&
    (OFFICIAL_VISUAL_FAILURE_CODES as readonly string[]).includes(value)
  );
}

/** 需求侧已挂的 UI 图，升级为官方视觉基线（不是像素级规格）。 */
export interface OfficialVisualBaseline {
  fileName: string;
  mimeType: string;
  note: string;
}

export interface VisualInventoryEntry {
  kind: VisualStateKind;
  status: "required" | "not-in-scope";
  /** 不含 / 必选 的判定说明。inferred = 平台根据文本推断，不是智能体口头声明。 */
  source: "baseline" | "requirement-text" | "explicit-out-of-scope" | "inferred-not-in-scope";
  reason: string;
  baselineFileName?: string;
  hints: string[];
}

export interface VisualDomFeatures {
  url?: string;
  defaultPickerPanel?: boolean;
  pickerIllustration?: boolean;
  oversizedPickerArrows?: boolean;
  unwrappedElDateEditor?: boolean;
  unwrappedElDialog?: boolean;
  unwrappedElSelect?: boolean;
  wrapperContractPresent?: boolean;
  /**
   * 允许携带辅助信号，但不得单独作为失败条件：
   * 间距几像素、颜色略偏、像素差分比等。
   */
  minorSpacingDrift?: boolean;
  minorColorDrift?: boolean;
  pixelDiffRatio?: number;
}

export interface VisualStateCapture {
  kind: VisualStateKind;
  opened: boolean;
  detail?: string;
  features?: VisualDomFeatures;
  screenshotRef?: string;
}

export interface OfficialVisualCapture {
  booted: boolean;
  usedFileProtocol: boolean;
  pageStatus: number | null;
  browser: "playwright" | "unavailable";
  browserError?: string;
  protocol?: string;
  appUrl?: string;
  states: VisualStateCapture[];
  stderrTail?: string;
  detectedPort?: number;
}

/**
 * 可选的设计意图对照（VLM 等）。通过条件必须是意图清单，不得是像素差分阈值。
 * 平台未配置时不要假装已经对照通过——确定性层仍须跑完。
 */
export interface VisualIntentJudgeResult {
  available: boolean;
  intentMismatch?: boolean;
  detail?: string;
}

export interface OfficialVisualEvaluation {
  passed: boolean;
  skipped?: boolean;
  skipReason?: string;
  failureCode?: OfficialVisualFailureCode;
  reason: string;
  inventory: VisualInventoryEntry[];
  judged: "deterministic" | "deterministic+intent-judge" | "none";
}

const PAGE_HINTS =
  /页面|列表|工作台|主界面|首页|看板|dashboard|\blist\b|\bpage\b|\bhome\b/i;
const DIALOG_HINTS = /对话框|弹窗|抽屉|dialog|modal|drawer/i;
const DATE_HINTS = /日期面板|日期选择|日期|日历|datepicker|date-picker|date_picker|date panel/i;
const DROPDOWN_HINTS = /下拉(?:框|菜单|列表)?|dropdown|combobox|\bselect\b(?!-?date)/i;
const EMPTY_HINTS = /空状态|暂无数据|暂无|empty state|\bempty\b|no-data|no data/i;
const OUT_OF_SCOPE_HINTS = /本需求不含|不含该态|不包含此态|not[- ]in[- ]scope|\bn\/a\b|explicitly absent/i;

const KIND_PATTERNS: Record<VisualStateKind, RegExp> = {
  page: PAGE_HINTS,
  dialog: DIALOG_HINTS,
  "date-panel": DATE_HINTS,
  dropdown: DROPDOWN_HINTS,
  empty: EMPTY_HINTS
};

const VISUAL_APP_SCRIPTS = ["start", "preview", "dev"] as const;

export function resolveVisualAppScriptName(
  scripts: Record<string, unknown>
): (typeof VISUAL_APP_SCRIPTS)[number] | undefined {
  for (const name of VISUAL_APP_SCRIPTS) {
    if (typeof scripts[name] === "string" && scripts[name]) return name;
  }
  return undefined;
}

export function isUiFacingVisualWork(input: {
  profile?: CapabilityProfile;
  sliceTasks?: readonly Task[];
}): boolean {
  const profile = input.profile;
  if (profile?.id.startsWith("frontend-")) return true;
  if (profile?.boundaryCheck === "ui") return true;
  return (input.sliceTasks ?? []).some((task) => task.type === "FRONTEND");
}

function textOfBaselines(baselines: readonly OfficialVisualBaseline[]): string {
  return baselines.map((item) => `${item.fileName}\n${item.note}`).join("\n");
}

function firstMatchingBaseline(
  baselines: readonly OfficialVisualBaseline[],
  kind: VisualStateKind
): OfficialVisualBaseline | undefined {
  const pattern = KIND_PATTERNS[kind];
  return baselines.find((item) => {
    const blob = `${item.fileName} ${item.note}`;
    if (!pattern.test(blob)) return false;
    // 「日期面板本需求不含」这类说明不是该态的对照基线。
    return !OUT_OF_SCOPE_HINTS.test(blob);
  });
}

function hintsFor(kind: VisualStateKind, baseline?: OfficialVisualBaseline): string[] {
  const fromNote = baseline?.note
    ? baseline.note
        .split(/[,\n;]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .slice(0, 6)
    : [];
  const defaults: Record<VisualStateKind, string[]> = {
    page: ["/"],
    dialog: ["[role=dialog]", ".el-dialog", "button:has-text(编辑)", "button:has-text(新增)"],
    "date-panel": [".el-date-editor", "input[placeholder*=日期]", "[data-testid*=date]"],
    dropdown: [".el-select", "[role=combobox]", "[data-testid*=select]"],
    empty: ["[data-testid*=empty]", ".el-empty", "text=暂无"]
  };
  return [...fromNote, ...defaults[kind]];
}

/**
 * 为五个关键态各给出「必选基线」或「本需求不含」。
 * 不含必须由平台根据基线文件名/说明和需求正文判定，不能由智能体口头跳过。
 */
export function buildVisualInventory(input: {
  baselines: readonly OfficialVisualBaseline[];
  requirementText?: string;
}): VisualInventoryEntry[] {
  const requirementText = input.requirementText ?? "";
  const combinedReq = `${requirementText}\n${textOfBaselines(input.baselines)}`;
  return VISUAL_STATE_KINDS.map((kind) => {
    const pattern = KIND_PATTERNS[kind];
    const explicitOut =
      input.baselines.some((item) => {
        const blob = `${item.fileName} ${item.note}`;
        return OUT_OF_SCOPE_HINTS.test(blob) && (pattern.test(blob) || /全部关键态|all states/i.test(blob));
      }) || (OUT_OF_SCOPE_HINTS.test(requirementText) && pattern.test(requirementText));

    const baseline = firstMatchingBaseline(input.baselines, kind);
    const mentionedInReq = pattern.test(requirementText);
    // 未特别标注的主页面：只要挂了任意 UI 图，主页面就是必选对照。
    const pageDefault = kind === "page" && input.baselines.length > 0 && !explicitOut;

    if (explicitOut && !baseline) {
      return {
        kind,
        status: "not-in-scope" as const,
        source: "explicit-out-of-scope" as const,
        reason: "基线或需求正文显式标注本需求不含该关键态",
        hints: []
      };
    }
    if (baseline) {
      return {
        kind,
        status: "required" as const,
        source: "baseline" as const,
        reason: `已挂视觉基线 ${baseline.fileName}`,
        baselineFileName: baseline.fileName,
        hints: hintsFor(kind, baseline)
      };
    }
    if (mentionedInReq || pageDefault) {
      return {
        kind,
        status: "required" as const,
        source: mentionedInReq ? ("requirement-text" as const) : ("baseline" as const),
        reason: mentionedInReq
          ? "需求正文声明了该关键态，但没有对应视觉基线"
          : "UI 向需求已挂基线，主页面必须对照",
        hints: hintsFor(kind)
      };
    }
    return {
      kind,
      status: "not-in-scope" as const,
      source: "inferred-not-in-scope" as const,
      reason: "需求正文与已挂基线均未声明该关键态，平台记为本需求不含",
      hints: []
    };
  });
}

function requiredEntries(inventory: readonly VisualInventoryEntry[]): VisualInventoryEntry[] {
  return inventory.filter((entry) => entry.status === "required");
}

function defaultSkinReasons(features: VisualDomFeatures | undefined): string[] {
  if (!features) return [];
  const reasons: string[] = [];
  if (features.pickerIllustration) {
    reasons.push("日期面板含默认大日历插画/装饰图");
  }
  if (features.oversizedPickerArrows) {
    reasons.push("日期面板翻页箭头明显是组件库默认超大样式");
  }
  if (
    features.defaultPickerPanel &&
    features.unwrappedElDateEditor &&
    !features.wrapperContractPresent
  ) {
    reasons.push("业务页直接使用组件库默认 DatePicker 外观，未走封装层");
  }
  return reasons;
}

/**
 * 设计意图验收。像素差分、轻微间距/颜色偏差不得单独判红。
 * 现有 packages/visual 的 PASS_DIFF_RATIO_MAX / 几何 8px 不得作为通过条件。
 */
export function evaluateOfficialVisualIntent(input: {
  uiFacing: boolean;
  baselines: readonly OfficialVisualBaseline[];
  inventory: readonly VisualInventoryEntry[];
  capture?: OfficialVisualCapture;
  judge?: VisualIntentJudgeResult;
  /** 仅用于单测：声明对照尚未发生。 */
  captureAttempted?: boolean;
}): OfficialVisualEvaluation {
  const inventory = [...input.inventory];
  if (!input.uiFacing) {
    return {
      passed: true,
      skipped: true,
      skipReason: "not-ui-facing",
      reason: "非 UI 向需求，允许没有视觉基线；由平台按能力面/任务类型判定，不由智能体口头跳过",
      inventory,
      judged: "none"
    };
  }

  const required = requiredEntries(inventory);
  const missingBaseline = required.filter((entry) => !entry.baselineFileName);
  if (input.baselines.length === 0 || missingBaseline.length > 0) {
    const detail =
      input.baselines.length === 0
        ? "UI 向需求没有可用视觉基线，不得静默跳过"
        : `下列关键态缺少视觉基线：${missingBaseline.map((entry) => entry.kind).join(", ")}`;
    return {
      passed: false,
      failureCode: "VISUAL_BASELINE_MISSING",
      reason: detail,
      inventory,
      judged: "deterministic"
    };
  }

  if (!input.capture) {
    return {
      passed: false,
      failureCode: "VISUAL_JUDGE_UNAVAILABLE",
      reason: "尚未在运行中的应用里打开关键态并留下官方截图，不能把视觉项标绿",
      inventory,
      judged: "none"
    };
  }

  const capture = input.capture;
  if (capture.usedFileProtocol || capture.protocol === "file:") {
    return {
      passed: false,
      failureCode: "VISUAL_CAPTURE_FAILED",
      reason: "官方视觉审查禁止用 file:// 打开孤立 HTML 充当应用验收",
      inventory,
      judged: "deterministic"
    };
  }
  if (!capture.booted) {
    return {
      passed: false,
      failureCode: "VISUAL_CAPTURE_FAILED",
      reason: "未能在跑起来的应用（开发服务器或预览）里打开页面",
      inventory,
      judged: "deterministic"
    };
  }
  if (capture.browser !== "playwright") {
    return {
      passed: false,
      failureCode: "VISUAL_CAPTURE_FAILED",
      reason: capture.browserError
        ? `官方视觉截图失败：${capture.browserError}`
        : "官方视觉审查未能使用平台 Playwright 打开运行中的应用",
      inventory,
      judged: "deterministic"
    };
  }

  const captured = new Map(capture.states.map((state) => [state.kind, state]));
  const unreachable = required.filter((entry) => {
    const state = captured.get(entry.kind);
    return !state || !state.opened;
  });
  if (unreachable.length > 0) {
    const detail = unreachable
      .map((entry) => {
        const state = captured.get(entry.kind);
        return state?.detail ? `${entry.kind}（${state.detail}）` : entry.kind;
      })
      .join(", ");
    return {
      passed: false,
      failureCode: "VISUAL_STATE_UNREACHABLE",
      reason: `规定关键态未能在运行中的应用里打开：${detail}`,
      inventory,
      judged: "deterministic"
    };
  }

  const skinReasons: string[] = [];
  for (const entry of required) {
    const state = captured.get(entry.kind);
    skinReasons.push(...defaultSkinReasons(state?.features));
  }
  if (skinReasons.length > 0) {
    return {
      passed: false,
      failureCode: "VISUAL_DEFAULT_SKIN",
      reason: [...new Set(skinReasons)].join("；"),
      inventory,
      judged: "deterministic"
    };
  }

  if (input.judge && input.judge.available && input.judge.intentMismatch) {
    return {
      passed: false,
      failureCode: "VISUAL_INTENT_MISMATCH",
      reason: input.judge.detail ?? "官方对照判定与已挂视觉基线的设计意图明显不符",
      inventory,
      judged: "deterministic+intent-judge"
    };
  }

  // 轻微偏差 / 像素差只作辅助，不得判红（即使调用方传了这些字段）。
  const minorOnly = required.some((entry) => {
    const features = captured.get(entry.kind)?.features;
    return Boolean(
      features &&
        (features.minorSpacingDrift ||
          features.minorColorDrift ||
          (typeof features.pixelDiffRatio === "number" && features.pixelDiffRatio > 0))
    );
  });

  if (input.judge && !input.judge.available) {
    // 确定性层已经完成：基线存在、关键态打开、无默认皮肤。未配置 VLM 不得据此标红，
    // 也不得声称「模型已对照通过」；判定来源记为 deterministic。
    return {
      passed: true,
      reason:
        "确定性设计意图检查通过（关键态已打开、基线可对照、未见默认组件库皮肤）。未配置视觉判断器，未做像素级还原" +
        (minorOnly ? "；已忽略轻微间距/颜色/像素差" : ""),
      inventory,
      judged: "deterministic"
    };
  }

  return {
    passed: true,
    reason:
      (input.judge?.available
        ? "官方设计意图对照通过（非像素级还原）"
        : "确定性设计意图检查通过（关键态已打开、基线可对照、未见默认组件库皮肤）") +
      (minorOnly ? "；轻微间距/颜色/像素差不作为失败条件" : ""),
    inventory,
    judged: input.judge?.available ? "deterministic+intent-judge" : "deterministic"
  };
}

export const OFFICIAL_VISUAL_BOOT_TIMEOUT_MS = 30_000;
export const OFFICIAL_VISUAL_PROBE_TIMEOUT_MS = 15_000;
export const OFFICIAL_VISUAL_SETTLE_MS = 1_500;
export const OFFICIAL_VISUAL_COMMAND_TIMEOUT_MS = 110_000;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 探测程序约束与 UI 冒烟相同：单引号 JS、不含 `"` / `$` / 反引号，整段包进 shell 双引号。
 * 启动应用后按清单打开关键态，采集 DOM 特征并截图到工作区，最后打印一行 JSON。
 */
const OFFICIAL_VISUAL_PROGRAM =
  "const{spawn}=require('node:child_process');" +
  "const net=require('node:net');" +
  "const fs=require('node:fs');" +
  "const path=require('node:path');" +
  "const a=process.argv;" +
  "const mark=a.indexOf('OFFICIAL_VISUAL_GATE');" +
  "const startCmd=a[mark+1];const port=Number(a[mark+2]);" +
  "const inventory=JSON.parse(a[mark+3]);" +
  "const bootTimeoutMs=Number(a[mark+4]);const probeTimeoutMs=Number(a[mark+5]);" +
  "const settleMs=Number(a[mark+6]);const mockCmd=a[mark+7]||'';const mockPort=Number(a[mark+8]||0);" +
  "const buildCmd=a[mark+9]||'';" +
  "const out={booted:false,usedFileProtocol:false,exited:false,exitCode:null,signal:null," +
  "pageStatus:null,browser:'unavailable',browserError:null,protocol:null,appUrl:null," +
  "states:[],stderrTail:'',detectedPort:null,mockBooted:false,buildExitCode:null};" +
  "const children=[];let stderr='';let stdout='';let mockErr='';" +
  "const wait=ms=>new Promise(r=>setTimeout(r,ms));" +
  "const connectTo=p=>new Promise(res=>{const s=net.connect({port:p,host:'127.0.0.1'});let done=false;" +
  "const fin=v=>{if(done)return;done=true;try{s.destroy()}catch(e){}res(v)};" +
  "s.on('connect',()=>fin(true));s.on('error',()=>fin(false));s.setTimeout(500,()=>fin(false))});" +
  "const loadBrowser=()=>{const tries=[" +
  "()=>require.resolve('playwright',{paths:[process.cwd()]})," +
  "()=>require.resolve('playwright')];" +
  "for(const pick of tries){try{const mod=require(pick());if(mod&&mod.chromium)return mod}catch(e){}}return null};" +
  "const killAll=()=>{for(const c of children){try{process.kill(-c.pid,'SIGKILL')}catch(e){}" +
  "try{c.kill('SIGKILL')}catch(e){}}};" +
  "const runBuild=async()=>{const b=spawn(buildCmd,{shell:true,cwd:process.cwd()," +
  "env:Object.assign({},process.env,{VITE_API_BASE:'http://127.0.0.1:'+mockPort})," +
  "stdio:['ignore','pipe','pipe']});children.push(b);let err='';b.stderr.on('data',c=>{err+=c});" +
  "const budget=Math.min(bootTimeoutMs,30000);" +
  "out.buildExitCode=await new Promise(res=>{const t=setTimeout(()=>{" +
  "try{process.kill(-b.pid,'SIGKILL')}catch(e){}res(null)},budget);" +
  "b.on('exit',code=>{clearTimeout(t);res(code)})});if(err)mockErr+=err.slice(-500)};" +
  "const runMock=async()=>{const m=spawn(mockCmd,{shell:true,detached:true,cwd:process.cwd()," +
  "env:Object.assign({},process.env,{PORT:String(mockPort)}),stdio:['ignore','pipe','pipe']});" +
  "children.push(m);m.stderr.on('data',c=>{mockErr+=c});" +
  "const d=Date.now()+Math.min(bootTimeoutMs,20000);" +
  "while(Date.now()<d){if(await connectTo(mockPort)){out.mockBooted=true;break}await wait(250)}};" +
  "const collectFeatures=async(page)=>page.evaluate(()=>{" +
  "const q=s=>document.querySelector(s);" +
  "const hasWrap=el=>{let n=el;while(n){const cls=typeof n.className==='string'?n.className:'';" +
  "if((n.getAttribute&&n.getAttribute('data-ui-contract'))||/(?:^|\\s)(?:tf|app|ui)-/.test(cls))return true;" +
  "n=n.parentElement;}return false;};" +
  "const panel=q('.el-picker-panel, .el-date-picker');" +
  "let pickerIllustration=false;let oversizedPickerArrows=false;" +
  "if(panel){const media=Array.from(panel.querySelectorAll('img, svg, canvas'));" +
  "pickerIllustration=media.some(m=>{const r=m.getBoundingClientRect();return r.width>=80||r.height>=80;});" +
  "const buttons=Array.from(panel.querySelectorAll('.el-picker-panel__icon-btn, button'));" +
  "oversizedPickerArrows=buttons.some(b=>{const st=window.getComputedStyle(b);const r=b.getBoundingClientRect();" +
  "const fs=parseFloat(st.fontSize)||0;return r.width>=36||r.height>=36||fs>=20;});}" +
  "const dateEditor=q('.el-date-editor');const dialog=q('.el-dialog, [role=dialog]');" +
  "const select=q('.el-select, .el-select-dropdown');" +
  "return{url:location.href,defaultPickerPanel:!!panel,pickerIllustration:pickerIllustration," +
  "oversizedPickerArrows:oversizedPickerArrows,unwrappedElDateEditor:!!(dateEditor&&!hasWrap(dateEditor))," +
  "unwrappedElDialog:!!(dialog&&!hasWrap(dialog)),unwrappedElSelect:!!(select&&!hasWrap(select))," +
  "wrapperContractPresent:!!(q('[data-ui-contract]')||q('[class*=tf-date]')||q('[class*=tf-dialog]'))};});" +
  "const shotDir=path.join(process.cwd(),'.ai-se-official-visual');" +
  "const saveShot=async(page,kind)=>{try{fs.mkdirSync(shotDir,{recursive:true});" +
  "const rel=path.join('.ai-se-official-visual',kind+'.png');" +
  "await page.screenshot({path:path.join(process.cwd(),rel),fullPage:true});return rel;}catch(e){return null}};" +
  "const clickFirst=async(page,sels)=>{for(const sel of sels){try{const loc=page.locator(sel).first();" +
  "if(await loc.count()){await loc.click({timeout:2000});return true}}catch(e){}}return false};" +
  "const openState=async(page,entry)=>{" +
  "const kind=entry.kind;const hints=Array.isArray(entry.hints)?entry.hints:[];" +
  "const state={kind:kind,opened:false,detail:null,features:null,screenshotRef:null};" +
  "try{" +
  "if(kind==='page'){state.opened=true;}" +
  "else if(kind==='dialog'){const clicked=await clickFirst(page,hints.concat([" +
  "'.el-button', 'button']));" +
  "try{await page.waitForSelector('.el-dialog, [role=dialog]',{timeout:3000});state.opened=true;}" +
  "catch(e){state.opened=false;state.detail=clicked?'dialog selector not visible':'no dialog trigger'};}" +
  "else if(kind==='date-panel'){const clicked=await clickFirst(page,hints.concat([" +
  "'.el-date-editor', 'input[placeholder*=日期]']));" +
  "try{await page.waitForSelector('.el-picker-panel, .el-date-picker',{timeout:3000});state.opened=true;}" +
  "catch(e){state.opened=false;state.detail=clicked?'date panel not visible':'no date trigger'};}" +
  "else if(kind==='dropdown'){const clicked=await clickFirst(page,hints.concat([" +
  "'.el-select', '[role=combobox]']));" +
  "try{await page.waitForSelector('.el-select-dropdown, [role=listbox]',{timeout:3000});state.opened=true;}" +
  "catch(e){state.opened=false;state.detail=clicked?'dropdown not visible':'no dropdown trigger'};}" +
  "else if(kind==='empty'){const found=await page.locator('.el-empty, [data-testid*=empty]').count();" +
  "state.opened=found>0;if(!state.opened)state.detail='empty state not visible';}" +
  "state.features=await collectFeatures(page);" +
  "state.screenshotRef=await saveShot(page,kind);" +
  "}catch(e){state.opened=false;state.detail=String((e&&e.message)||e).slice(0,300);}" +
  "return state};" +
  "(async()=>{" +
  "if(buildCmd&&mockPort>0){await runBuild()}" +
  "if(mockCmd&&mockPort>0){await runMock()}" +
  "const child=spawn(startCmd,{shell:true,detached:true,cwd:process.cwd()," +
  "env:Object.assign({},process.env,{PORT:String(port),NODE_ENV:'test'})," +
  "stdio:['ignore','pipe','pipe']});children.push(child);" +
  "child.stdout.on('data',c=>{stdout+=c});child.stderr.on('data',c=>{stderr+=c});" +
  "child.on('exit',(code,signal)=>{out.exited=true;out.exitCode=code;out.signal=signal});" +
  "const deadline=Date.now()+bootTimeoutMs;let live=null;" +
  "while(Date.now()<deadline){if(await connectTo(port)){live=port;break}if(out.exited)break;await wait(250)}" +
  "if(live===null){const m=/(?:listening[^0-9]{0,40}|http:\\/\\/(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):)([0-9]{2,5})/i.exec(stdout+stderr);" +
  "if(m){const declared=Number(m[1]);if(declared!==port&&await connectTo(declared)){live=declared;out.detectedPort=declared}}}" +
  "if(live!==null){out.booted=true;out.protocol='http:';out.appUrl='http://127.0.0.1:'+live+'/';" +
  "try{const r=await fetch(out.appUrl,{signal:AbortSignal.timeout(probeTimeoutMs)});out.pageStatus=r.status}" +
  "catch(e){out.pageStatus=null}" +
  "const pw=loadBrowser();" +
  "if(pw){try{const browser=await pw.chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});" +
  "try{const page=await browser.newPage();" +
  "try{await page.goto(out.appUrl,{waitUntil:'load',timeout:probeTimeoutMs})}catch(e){}" +
  "await wait(settleMs);" +
  "out.browser='playwright';" +
  "const required=(Array.isArray(inventory)?inventory:[]).filter(e=>e&&e.status==='required');" +
  "for(const entry of required){out.states.push(await openState(page,entry));}" +
  "}finally{await browser.close()}}catch(e){out.browserError=String((e&&e.message)||e).slice(0,500)}}}" +
  "out.stderrTail=(stderr+(mockErr||'')).slice(-2000);killAll();" +
  "process.stdout.write(JSON.stringify(out));process.exit(0)})()";

export interface OfficialVisualCommandInput {
  startCommand: string;
  port: number;
  inventory: readonly VisualInventoryEntry[];
  bootTimeoutMs?: number;
  probeTimeoutMs?: number;
  settleMs?: number;
  mockCommand?: string;
  mockPort?: number;
  buildCommand?: string;
}

export function buildOfficialVisualCommand(input: OfficialVisualCommandInput): string {
  const inventory = JSON.stringify(
    requiredEntries(input.inventory).map((entry) => ({
      kind: entry.kind,
      status: entry.status,
      hints: entry.hints
    }))
  );
  return [
    "node -e",
    `"${OFFICIAL_VISUAL_PROGRAM}"`,
    OFFICIAL_VISUAL_GATE_MARKER,
    shellSingleQuote(input.startCommand),
    shellSingleQuote(String(input.port)),
    shellSingleQuote(inventory),
    shellSingleQuote(String(input.bootTimeoutMs ?? OFFICIAL_VISUAL_BOOT_TIMEOUT_MS)),
    shellSingleQuote(String(input.probeTimeoutMs ?? OFFICIAL_VISUAL_PROBE_TIMEOUT_MS)),
    shellSingleQuote(String(input.settleMs ?? OFFICIAL_VISUAL_SETTLE_MS)),
    shellSingleQuote(input.mockCommand ?? ""),
    shellSingleQuote(String(input.mockPort ?? 0)),
    shellSingleQuote(input.buildCommand ?? "")
  ].join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFeatures(value: unknown): VisualDomFeatures | undefined {
  if (!isRecord(value)) return undefined;
  const num = (key: string): number | undefined =>
    typeof value[key] === "number" ? (value[key] as number) : undefined;
  const flag = (key: string): boolean | undefined =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : undefined;
  return {
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(flag("defaultPickerPanel") !== undefined
      ? { defaultPickerPanel: flag("defaultPickerPanel") }
      : {}),
    ...(flag("pickerIllustration") !== undefined
      ? { pickerIllustration: flag("pickerIllustration") }
      : {}),
    ...(flag("oversizedPickerArrows") !== undefined
      ? { oversizedPickerArrows: flag("oversizedPickerArrows") }
      : {}),
    ...(flag("unwrappedElDateEditor") !== undefined
      ? { unwrappedElDateEditor: flag("unwrappedElDateEditor") }
      : {}),
    ...(flag("unwrappedElDialog") !== undefined
      ? { unwrappedElDialog: flag("unwrappedElDialog") }
      : {}),
    ...(flag("unwrappedElSelect") !== undefined
      ? { unwrappedElSelect: flag("unwrappedElSelect") }
      : {}),
    ...(flag("wrapperContractPresent") !== undefined
      ? { wrapperContractPresent: flag("wrapperContractPresent") }
      : {}),
    ...(flag("minorSpacingDrift") !== undefined
      ? { minorSpacingDrift: flag("minorSpacingDrift") }
      : {}),
    ...(flag("minorColorDrift") !== undefined ? { minorColorDrift: flag("minorColorDrift") } : {}),
    ...(num("pixelDiffRatio") !== undefined ? { pixelDiffRatio: num("pixelDiffRatio") } : {})
  };
}

function asState(value: unknown): VisualStateCapture | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (typeof kind !== "string" || !(VISUAL_STATE_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  return {
    kind: kind as VisualStateKind,
    opened: value.opened === true,
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    ...(asFeatures(value.features) ? { features: asFeatures(value.features) } : {}),
    ...(typeof value.screenshotRef === "string" ? { screenshotRef: value.screenshotRef } : {})
  };
}

export function parseOfficialVisualOutput(stdout: string): OfficialVisualCapture | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.booted !== "boolean") continue;
    const states = Array.isArray(parsed.states)
      ? parsed.states.map(asState).filter((entry): entry is VisualStateCapture => Boolean(entry))
      : [];
    return {
      booted: parsed.booted,
      usedFileProtocol: parsed.usedFileProtocol === true || parsed.protocol === "file:",
      pageStatus: typeof parsed.pageStatus === "number" ? parsed.pageStatus : null,
      browser: parsed.browser === "playwright" ? "playwright" : "unavailable",
      ...(typeof parsed.browserError === "string" ? { browserError: parsed.browserError } : {}),
      ...(typeof parsed.protocol === "string" ? { protocol: parsed.protocol } : {}),
      ...(typeof parsed.appUrl === "string" ? { appUrl: parsed.appUrl } : {}),
      states,
      ...(typeof parsed.stderrTail === "string" ? { stderrTail: parsed.stderrTail } : {}),
      ...(typeof parsed.detectedPort === "number" ? { detectedPort: parsed.detectedPort } : {})
    };
  }
  return null;
}

export function officialVisualProjection(input: {
  passed: boolean;
  failureCode?: OfficialVisualFailureCode;
  reason: string;
  inventory: readonly VisualInventoryEntry[];
  capture?: OfficialVisualCapture;
  judged: OfficialVisualEvaluation["judged"];
}): Record<string, unknown> {
  return {
    passed: input.passed,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    reason: input.reason,
    judged: input.judged,
    inventory: input.inventory.map((entry) => ({
      kind: entry.kind,
      status: entry.status,
      source: entry.source,
      ...(entry.baselineFileName ? { baselineFileName: entry.baselineFileName } : {})
    })),
    states: (input.capture?.states ?? []).map((state) => ({
      kind: state.kind,
      opened: state.opened,
      ...(state.screenshotRef ? { screenshotRef: state.screenshotRef } : {}),
      ...(state.detail ? { detail: state.detail } : {})
    })),
    ...(input.capture?.appUrl ? { appUrl: input.capture.appUrl } : {})
  };
}

/** 从验证记录里抽出官方视觉结论，供审查/修复任务读取（不以智能体自报为准）。 */
export function officialVisualFromVerification(verification: unknown): Record<string, unknown> | undefined {
  if (!verification || typeof verification !== "object") return undefined;
  const checks = (verification as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return undefined;
  for (const raw of checks) {
    if (!raw || typeof raw !== "object") continue;
    const check = raw as Record<string, unknown>;
    if (check.name !== OFFICIAL_VISUAL_CHECK_NAME) continue;
    if (check.visual && typeof check.visual === "object") {
      return check.visual as Record<string, unknown>;
    }
    return {
      passed: check.passed === true,
      ...(typeof check.failureCode === "string" ? { failureCode: check.failureCode } : {}),
      ...(typeof check.stderrTail === "string" && check.stderrTail
        ? { reason: check.stderrTail }
        : {})
    };
  }
  return undefined;
}
