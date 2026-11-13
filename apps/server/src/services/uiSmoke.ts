/**
 * `docs/233` §5.2 / `docs/235` §6 第 3 步：**UI 边界冒烟**——`serverSmoke` 的 UI 版，同一套教义。
 *
 * 它回答一个问题：**页面真的起得来、AC 点名的元素真的挂上了吗**。不做业务断言（那是逐任务检查与
 * oracle 的事），也不猜（只认 AC 文本里点名的 `data-testid`）。
 *
 * 为什么需要它：`serverSmoke` 的判据是「业务路由挂没挂」，前端项目没有路由探测面；一个 Vite SPA
 * 可以 `build` 过、`lint` 过、单测全绿，而页面白屏（组件没挂载、入口报错），逐任务门看不见。
 *
 * **与 `serverSmoke` 的三条对称性**（避免长出第二种门）：
 * 1. 探测在**一条命令内**完成——沙箱每条命令是新容器（`packages/sandbox/src/index.ts`），起进程与
 *    打开页面必须在同一条命令里；
 * 2. 起点是项目自己声明的 `start` 脚本；
 * 3. 跳过必须留痕（`smokeSkipped`），不静默。
 *
 * **浏览器从哪来**：DOM 断言必须真的执行页面脚本，所以在同一条命令里打开页面。解析顺序两级——
 * 先找**工作区**自己的 `playwright`（项目锁定的版本优先），再找**镜像内置**的全局安装
 * （`docs/235` §6.7：沙箱镜像含 Chromium 与 playwright，`NODE_PATH` 已指向它）。两级都没有时
 * **跳过并留痕** `BROWSER_UNAVAILABLE`——不猜、不降级成「扫构建产物里的字符串」，那种做法会把
 * 「元素没渲染」读成「元素在」。
 * 沙箱镜像是否预装浏览器是 `docs/234` 的待决项，不在本模块里决定。
 */

import { isEnvironmentBootFailure } from "./serverSmoke";

/** AC 文本里点名的一个 testid。 */
export interface UiTestId {
  name: string;
  /** 含 `:` / `{` / `}` / `$`（如 `todo-${id}`）——运行期才知道具体值，不能当静态元素判定。 */
  dynamic: boolean;
}

export interface UiSmokeResult {
  booted: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  /** 首页 HTTP 状态（浏览器是否可用都会采）。`null` = 连不上。 */
  pageStatus: number | null;
  /** `playwright` = DOM 真的断言过；`unavailable` = 工作区里没有可用的浏览器。 */
  browser: "playwright" | "unavailable";
  browserError: string | null;
  /** 页面上**实际存在**的 `data-testid` 值。 */
  present: string[];
  consoleErrors: string[];
  stderrTail: string;
  detectedPort?: number | null;
  /** N-71：mock 是否起来了（没有 mock 时页面首屏必然是错误态）。 */
  mockBooted?: boolean;
  /** N-71：按 mock 端口重建的退出码（`null` = 超时被中止）。 */
  buildExitCode?: number | null;
  /** N-71：mock 进程的 stderr 尾部（起不来时用于定位）。 */
  mockStderrTail?: string;
}

export type UiSmokeFailureCode = "PAGE_UNREACHABLE" | "SURFACE_MISSING" | "CONSOLE_ERROR";

export type UiSmokeVerdict =
  | { kind: "passed"; present: string[] }
  | { kind: "failed"; failureCode: UiSmokeFailureCode; detail: string }
  | {
      kind: "skipped";
      reason:
        | "NO_TESTIDS"
        | "ONLY_DYNAMIC_TESTIDS"
        | "BOOT_ENV_UNRESOLVED"
        | "BROWSER_UNAVAILABLE"
        | "PROBE_ERROR";
    };

/**
 * 只认 `data-testid`。三种写法都收（属性、CSS 选择器、无引号）：
 * `data-testid="todo-list"`、`[data-testid='todo-list']`、`data-testid=todo-list`。
 *
 * 与 `extractHttpRoutes` 同一条规则：**只认文本点名的东西，不猜**。文本里没写 testid 时返回空数组，
 * 由调用方记 `NO_TESTIDS` 跳过，不静默。
 */
const TEST_ID_ATTRIBUTE =
  /data-testid\s*=\s*(?:"([^"<>\s]{1,100})"|'([^'<>\s]{1,100})'|([A-Za-z0-9_\-.:{}$]{1,100}))/g;

/** 动态 testid 的判据：值是运行期拼出来的，页面上不会以这个名字出现。 */
const DYNAMIC_TEST_ID = /[:{}$]/;

/**
 * 合法的 testid 形状：**ASCII 字母开头**，其余是字母/数字/`_ . : - $ { }`。
 *
 * 这条边界校验挡的是散文里的示例串（实测：需求文档写「写成 `data-testid="名字"` 的形式」，
 * 提取器就把 `名字` 当成了一个必须存在的元素）。挡错的代价是一次 `NO_TESTIDS` 跳过（留痕），
 * 放进来的代价是一次**假的 `SURFACE_MISSING`**——把一个做得对的应用判死。
 */
const VALID_TEST_ID = /^[A-Za-z][A-Za-z0-9_.:${}-]{0,99}$/;

export function extractTestIds(
  texts: readonly string[],
  limit = UI_SMOKE_TESTID_LIMIT
): UiTestId[] {
  const found: UiTestId[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (typeof text !== "string" || text === "") continue;
    for (const match of text.matchAll(TEST_ID_ATTRIBUTE)) {
      if (found.length >= limit) return found;
      const name = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (name === "" || !VALID_TEST_ID.test(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      found.push({ name, dynamic: DYNAMIC_TEST_ID.test(name) });
    }
  }
  return found;
}

/** 静态 testid（去重、保序）。 */
export function staticTestIds(ids: readonly UiTestId[]): string[] {
  return [...new Set(ids.filter((entry) => !entry.dynamic).map((entry) => entry.name))];
}

/**
 * N-64（`docs/232` §10）：**需求里声明的 testid 命名契约**。
 *
 * 为什么需要它：`extractTestIds` 只认 `data-testid="x"` 这种写法，而 PRD 的命名表写的是
 * **表格首列的反引号名字**——F1 的 `task-title-input` 只出现在那张表里，任何一条 AC 都没提过它。
 * 于是「AC 点名的 testid 在不在页面上」这条冒烟判据对它视而不见，agent 把它写成
 * `new-task-title` 也不会有人拦（实测 2026-10-29 F1 第四轮，4 条 Must AC 全部栽在这一个名字上）。
 *
 * 两个来源取并集，任一为空都不影响另一个：
 * 1. **markdown 表格首列的反引号名字**（PRD 自述「取值只能是下表里的名字」）；
 * 2. **正文里以 `data-testid=` 形式点名的名字**（`extractTestIds` 的既得口径）。
 *
 * 首列必须是反引号包着的：AC 表格的首列是裸的 `AC-06`，不该被当成 testid。
 * 一个没有命名表、也没在正文点名 testid 的需求得到空集——调用方据此**跳过并留痕**，不判缺陷。
 */
export function extractContractTestIds(markdown: string, limit = 200): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed === "" || found.length >= limit) return;
    if (!CONTRACT_TEST_ID.test(trimmed) || seen.has(trimmed)) return;
    seen.add(trimmed);
    found.push(trimmed);
  };
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    // `| a | b |` → ["", " a ", " b ", ""]；首列是第 1 项。
    const first = cells[1];
    if (first === undefined) continue;
    for (const part of first.split("/")) {
      // 只收**完整**被反引号包住的那一段，`data-testid="x"` 这种形态交给来源 2。
      const match = /^\s*`([^`]+)`\s*$/.exec(part);
      if (match) push(match[1]);
    }
  }
  for (const id of staticTestIds(extractTestIds([markdown], limit))) push(id);
  return found;
}

/** 契约名的形状：ASCII 字母开头，其余字母/数字/`_ . -`（kebab-case 为主，允许点号命名空间）。 */
const CONTRACT_TEST_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;

/**
 * 值不值得跑。放在这里而不是调用方，是因为「跳过原因」与 `evaluateUiSmoke` 的判定必须同源——
 * 两处各写一遍就会漂移（`docs/160` 的成因类型）。
 */
export function uiTestIdSkipReason(
  ids: readonly UiTestId[]
): "NO_TESTIDS" | "ONLY_DYNAMIC_TESTIDS" | null {
  if (ids.length === 0) return "NO_TESTIDS";
  return staticTestIds(ids).length === 0 ? "ONLY_DYNAMIC_TESTIDS" : null;
}

/**
 * 探测程序。**单引号 JS 字符串、不含 `"`/`$`/反引号**——整段会被包进 shell 的双引号里
 * （与 `SMOKE_PROGRAM` 同一约束）。
 *
 * 控制台只收**应用自身**的 error：`Failed to load resource` 是浏览器对网络失败的日志，
 * 与 oracle 的 AC-20 同一口径（接口 4xx/5xx 该由业务断言抓，不由冒烟抓）。不排除的话，
 * 一个「列表请求失败但页面正常降级」的应用会被这道门误判成缺陷。
 *
 * 进程用 `detached` 起、结束时按进程组杀（`vite preview` 会派生孙进程）。
 */
const UI_SMOKE_PROGRAM =
  "const{spawn}=require('node:child_process');" +
  "const net=require('node:net');" +
  "const a=process.argv.slice(1);const startCmd=a[0];const port=Number(a[1]);" +
  "const ids=JSON.parse(a[2]);const bootTimeoutMs=Number(a[3]);const probeTimeoutMs=Number(a[4]);" +
  "const settleMs=Number(a[5]);const mockCmd=a[6]||'';const mockPort=Number(a[7]||0);" +
  "const buildCmd=a[8]||'';" +
  "const out={booted:false,exited:false,exitCode:null,signal:null,pageStatus:null," +
  "browser:'unavailable',browserError:null,present:[],consoleErrors:[],stderrTail:'',detectedPort:null," +
  "mockBooted:false,buildExitCode:null,mockStderrTail:''};" +
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
  // N-71：先按 mock 端口重建（VITE_API_BASE 是构建期内联），再起 mock，最后起应用。
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
  "if(live!==null){out.booted=true;" +
  "try{const r=await fetch('http://127.0.0.1:'+live+'/',{signal:AbortSignal.timeout(probeTimeoutMs)});" +
  "out.pageStatus=r.status}catch(e){out.pageStatus=null}" +
  "const pw=loadBrowser();" +
  "if(pw){try{const browser=await pw.chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});" +
  "try{const page=await browser.newPage();" +
  "page.on('console',m=>{if(m.type()==='error'){const t=String(m.text());" +
  "if(!/Failed to load resource/i.test(t))out.consoleErrors.push(t.slice(0,300))}});" +
  "page.on('pageerror',e=>out.consoleErrors.push(String((e&&e.message)||e).slice(0,300)));" +
  "try{await page.goto('http://127.0.0.1:'+live+'/',{waitUntil:'load',timeout:probeTimeoutMs})}catch(e){}" +
  "await wait(settleMs);" +
  "const seen=await page.evaluate(()=>Array.from(document.querySelectorAll('[data-testid]'))" +
  ".map(e=>e.getAttribute('data-testid')));" +
  "out.present=(Array.isArray(seen)?seen:[]).map(String);out.browser='playwright';" +
  "}finally{await browser.close()}}catch(e){out.browserError=String((e&&e.message)||e).slice(0,500)}}}" +
  "out.stderrTail=stderr.slice(-2000);if(mockErr)out.mockStderrTail=mockErr.slice(-1000);killAll();" +
  "process.stdout.write(JSON.stringify(out));process.exit(0)})()";

/**
 * N-73（`docs/232` §10）：**探一个已经起着的 URL**——交付链的 staging VERIFY 用它。
 *
 * 与 `UI_SMOKE_PROGRAM` 的浏览器段同源（同一套 testid 采集与控制台口径），区别只在于
 * **不自己起服务**：staging 预览由 DEPLOY 那一步拉起并常驻。输出形状与 `parseUiSmokeOutput`
 * 完全一致，调用方可以复用同一个解析器与判据。
 */
const URL_PROBE_PROGRAM =
  "const a=process.argv.slice(1);const url=a[0];const probeTimeoutMs=Number(a[1]);" +
  "const settleMs=Number(a[2]);" +
  "const out={booted:false,exited:false,exitCode:null,signal:null,pageStatus:null," +
  "browser:'unavailable',browserError:null,present:[],consoleErrors:[],stderrTail:'',detectedPort:null};" +
  "const wait=ms=>new Promise(r=>setTimeout(r,ms));" +
  "const loadBrowser=()=>{const tries=[" +
  "()=>require.resolve('playwright',{paths:[process.cwd()]})," +
  "()=>require.resolve('playwright')];" +
  "for(const pick of tries){try{const mod=require(pick());if(mod&&mod.chromium)return mod}catch(e){}}return null};" +
  "(async()=>{" +
  "try{const r=await fetch(url,{signal:AbortSignal.timeout(probeTimeoutMs)});out.pageStatus=r.status}" +
  "catch(e){out.pageStatus=null}" +
  "out.booted=out.pageStatus!==null;" +
  "const pw=loadBrowser();" +
  "if(pw){try{const browser=await pw.chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});" +
  "try{const page=await browser.newPage();" +
  "page.on('console',m=>{if(m.type()==='error'){const t=String(m.text());" +
  "if(!/Failed to load resource/i.test(t))out.consoleErrors.push(t.slice(0,300))}});" +
  "page.on('pageerror',e=>out.consoleErrors.push(String((e&&e.message)||e).slice(0,300)));" +
  "try{await page.goto(url,{waitUntil:'load',timeout:probeTimeoutMs})}catch(e){}" +
  "await wait(settleMs);" +
  "const seen=await page.evaluate(()=>Array.from(document.querySelectorAll('[data-testid]'))" +
  ".map(e=>e.getAttribute('data-testid')));" +
  "out.present=(Array.isArray(seen)?seen:[]).map(String);out.browser='playwright';" +
  "}finally{await browser.close()}}catch(e){out.browserError=String((e&&e.message)||e).slice(0,500)}}" +
  "process.stdout.write(JSON.stringify(out));process.exit(0)})()";

export interface UrlProbeInput {
  url: string;
  probeTimeoutMs?: number;
  settleMs?: number;
}

/** `node -e <program> <url> <probeTimeoutMs> <settleMs>` 的参数表（适配器直接 spawn 用）。 */
export function urlProbeProgramArgs(input: UrlProbeInput): string[] {
  return [
    URL_PROBE_PROGRAM,
    input.url,
    String(input.probeTimeoutMs ?? UI_SMOKE_PROBE_TIMEOUT_MS),
    String(input.settleMs ?? UI_SMOKE_SETTLE_MS)
  ];
}

/** shell 形态（与 `buildUiSmokeCommand` 同约束：程序体不含双引号）。 */
export function buildUrlProbeCommand(input: UrlProbeInput): string {
  return ["node -e", `"${URL_PROBE_PROGRAM}"`, ...urlProbeProgramArgs(input).slice(1).map(shellSingleQuote)].join(
    " "
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface UiSmokeCommandInput {
  /** 项目声明的启动命令（`npm run start` / `pnpm start`）。 */
  startCommand: string;
  port: number;
  /** **静态** testid（动态的已经在上游排除，探测程序不做判定）。 */
  testIds: readonly string[];
  bootTimeoutMs: number;
  probeTimeoutMs: number;
  settleMs: number;
  /**
   * N-71（`docs/232` §10）：工作区的 mock 启动命令（`pnpm mock`）。
   *
   * 没有它，页面首屏拿不到 `/api/tasks`，必然停在错误态——列表项永远不在，任何只点名列表项
   * testid 的验收标准都会被判 `SURFACE_MISSING`（参考实现同样过不了）。
   */
  mockCommand?: string;
  /** mock 端口（与应用端口不同；`VITE_API_BASE` 指向它）。 */
  mockPort?: number;
  /**
   * 构建命令。`VITE_API_BASE` 是**构建期内联**的，所以要在起 mock 之后用同一个端口重建一次，
   * 页面才连得到 mock（`F1/oracle.mjs:668-676` 同一做法）。
   */
  buildCommand?: string;
}

export function buildUiSmokeCommand(input: UiSmokeCommandInput): string {
  return [
    "node -e",
    `"${UI_SMOKE_PROGRAM}"`,
    shellSingleQuote(input.startCommand),
    shellSingleQuote(String(input.port)),
    shellSingleQuote(JSON.stringify(input.testIds)),
    shellSingleQuote(String(input.bootTimeoutMs)),
    shellSingleQuote(String(input.probeTimeoutMs)),
    shellSingleQuote(String(input.settleMs)),
    shellSingleQuote(input.mockCommand ?? ""),
    shellSingleQuote(String(input.mockPort ?? 0)),
    shellSingleQuote(input.buildCommand ?? "")
  ].join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringList(value: unknown, limit = 40): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry !== "")
    .slice(0, limit);
}

/** 解析探测输出：取**最后一行**可解析的 JSON（与 `parseServerSmokeOutput` 同规则）。 */
export function parseUiSmokeOutput(stdout: string): UiSmokeResult | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
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
    return {
      booted: parsed.booted,
      exited: parsed.exited === true,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
      pageStatus: typeof parsed.pageStatus === "number" ? parsed.pageStatus : null,
      browser: parsed.browser === "playwright" ? "playwright" : "unavailable",
      browserError: typeof parsed.browserError === "string" ? parsed.browserError : null,
      present: asStringList(parsed.present, 200),
      consoleErrors: asStringList(parsed.consoleErrors),
      stderrTail: typeof parsed.stderrTail === "string" ? parsed.stderrTail : "",
      ...(typeof parsed.detectedPort === "number" ? { detectedPort: parsed.detectedPort } : {}),
      ...(typeof parsed.mockBooted === "boolean" ? { mockBooted: parsed.mockBooted } : {}),
      ...(typeof parsed.buildExitCode === "number" || parsed.buildExitCode === null
        ? { buildExitCode: parsed.buildExitCode as number | null }
        : {}),
      ...(typeof parsed.mockStderrTail === "string"
        ? { mockStderrTail: parsed.mockStderrTail }
        : {})
    };
  }
  return null;
}

/**
 * 判定表（`docs/233` §5.2）。
 *
 * 顺序是判据强度，不是随意排列：
 * - `PAGE_UNREACHABLE` 先看**页面本身**——起不来就没有 UI 可谈；
 * - 浏览器不可用 ⇒ **跳过**。这一条必须排在 `SURFACE_MISSING` 之前，否则「没有浏览器」会被读成
 *   「元素不在」，一个假阴性把整片判死（N-49/N-53/N-54 全是这一类）；
 * - `SURFACE_MISSING` 先于 `CONSOLE_ERROR`：一个元素都没挂上，控制台的报错只是它的症状。
 */
export function evaluateUiSmoke(
  result: UiSmokeResult,
  ids: readonly UiTestId[],
  options: { consoleErrorsFatal?: boolean } = {}
): UiSmokeVerdict {
  const skipReason = uiTestIdSkipReason(ids);
  if (skipReason) return { kind: "skipped", reason: skipReason };

  if (!result.booted) {
    if (isEnvironmentBootFailure(result.stderrTail)) {
      return { kind: "skipped", reason: "BOOT_ENV_UNRESOLVED" };
    }
    const exit = result.exited
      ? ` exited with ${result.exitCode ?? "null"}${result.signal ? ` (${result.signal})` : ""}`
      : " never answered";
    return {
      kind: "failed",
      failureCode: "PAGE_UNREACHABLE",
      detail: `start script${exit}; no listen on the requested port`
    };
  }

  if (result.pageStatus === null || result.pageStatus >= 400) {
    return {
      kind: "failed",
      failureCode: "PAGE_UNREACHABLE",
      detail: `the preview is up but GET / returned ${result.pageStatus ?? "no response"}`
    };
  }

  if (result.browser !== "playwright") {
    return { kind: "skipped", reason: "BROWSER_UNAVAILABLE" };
  }

  const wanted = staticTestIds(ids);
  const seen = new Set(result.present);
  const matched = wanted.filter((name) => seen.has(name));
  if (matched.length === 0) {
    return {
      kind: "failed",
      failureCode: "SURFACE_MISSING",
      detail:
        `the page loaded (GET / -> ${result.pageStatus}) but none of the elements this slice's ` +
        `acceptance criteria name are on it (missing: ${wanted.join(", ")})`
    };
  }

  if ((options.consoleErrorsFatal ?? true) && result.consoleErrors.length > 0) {
    return {
      kind: "failed",
      failureCode: "CONSOLE_ERROR",
      detail: `console reported ${result.consoleErrors.length} error(s): ${result.consoleErrors
        .slice(0, 3)
        .join(" | ")}`
    };
  }

  return { kind: "passed", present: matched };
}

/** AC 文本里点名的 testid 上限——探测成本与证据体积的折中（与 `SMOKE_ROUTE_LIMIT` 同值）。 */
export const UI_SMOKE_TESTID_LIMIT = 8;
/** 前端预览比裸 Node 服务慢（首次编译 / 依赖优化），启动窗口给宽一点。 */
export const UI_SMOKE_BOOT_TIMEOUT_MS = 30_000;
export const UI_SMOKE_PROBE_TIMEOUT_MS = 15_000;
/** 载入后等页面的异步渲染（首屏数据、路由守卫）落定。 */
export const UI_SMOKE_SETTLE_MS = 1_500;
/**
 * N-71：加入「按 mock 端口重建 + 起 mock」后，一次冒烟的顺序是
 * 构建（≤30s）→ mock（≤20s）→ 应用启动（≤30s）→ 探测（≤15s）→ settle；
 * 110s 覆盖这条链，同时仍低于验证门单次工具调用的 125s 上限（`DEFAULT_CHECK_TIMEOUT_MS` + 5s）。
 */
export const UI_SMOKE_COMMAND_TIMEOUT_MS = 110_000;
