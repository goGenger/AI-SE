/**
 * N-49（`docs/232` §9.14）：切片边界现在只是「用同一条测试命令再跑一遍」——它与逐任务检查跑的都是
 * **项目自己的测试**。第六次回归里 slice-auth-persistence 的边界检查 `passed`（作用域 AC-01..AC-13），
 * 而同一时刻 `GET /api/register` 是 404：交付的是「模块 + 单元测试」，**没有人把路由挂进服务器**，
 * 项目自己的 136 条测试里 135 条是绿的（它们直接调 handler，不启动服务）。只有 oracle 这个黑盒能看见。
 *
 * 本模块补的是同一个黑盒视角：在切片边界起一次**真实进程**，用项目声明的 `start` 脚本启动，
 * 再按本切片验收标准里点名的路由打一遍 HTTP。判据只有一条——**业务端点是否真的挂在运行中的服务上**。
 * 它不判业务正确性（那是测试与 oracle 的事），也不判状态码是否符合 AC（那是逐任务检查的事）。
 *
 * 与 `buildPackageFactsProbeCommand` 同一范式（`taskVerifierRules.ts:415`）：`node -e` 单命令、
 * 输出 JSON、由纯函数解析。沙箱每条命令都是**全新容器**（`packages/sandbox/src/index.ts:139`
 * `ai-se-sandbox-${randomUUID()}`），所以起进程与探测必须在同一条命令里完成。
 */

export interface SmokeRoute {
  method: string;
  path: string;
}

export interface ServerSmokeProbe {
  method: string;
  path: string;
  status: number | null;
  error?: string;
}

export interface ServerSmokeResult {
  booted: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  control: ServerSmokeProbe | null;
  probes: ServerSmokeProbe[];
  stderrTail: string;
  /** 未在指定端口起来、但输出里自称的端口（`listening on :3000` 一类）。 */
  detectedPort?: number | null;
}

export type ServerSmokeVerdict =
  | { kind: "passed"; businessProbes: ServerSmokeProbe[] }
  | { kind: "failed"; failureCode: "BOOT_FAILED" | "SURFACE_UNMOUNTED"; detail: string }
  | { kind: "skipped"; reason: "BOOT_ENV_UNRESOLVED" | "NO_ROUTES" | "ONLY_PARAMETERIZED_ROUTES" };

/** 健康/存活端点：证明「进程起来了」，**不**证明「业务面挂上了」——不参与挂载判定。 */
const HEALTH_PATHS = [
  /^\/$/,
  /^\/healthz?$/i,
  /^\/readyz?$/i,
  /^\/livez?$/i,
  /^\/ping$/i,
  /^\/status$/i,
  /^\/metrics$/i
];

/** 静态资源不参与挂载判定（它们不来自路由表）。 */
const ASSET_EXTENSION = /\.(?:js|mjs|cjs|css|html?|png|jpe?g|gif|svg|ico|webp|woff2?|map|json)$/i;

const METHOD_PATH = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[A-Za-z0-9_\-/:.{}]*)/g;
const BARE_PATH =
  /(?:^|[\s`（(、,;:：，；）])(\/[A-Za-z][A-Za-z0-9_\-/:.{}]*)/g;

/**
 * N-53（`docs/232` §9.24）：**裸路径只认 `/api…`**。
 *
 * 第十次回归里 `VOLUME /data`、`DATA_DIR=/data`、`挂载 /data 数据卷` 被裸路径正则当成了 HTTP 路由，
 * `server-smoke` 于是对一个**容器数据卷路径**判 `SURFACE_UNMOUNTED`，把 REVIEW 任务连着判失败两次并
 * 派生出 REPLAN——这是门的误判，不是交付缺陷。
 *
 * 口径：**带方法的路径直接信任**（AC 写 `GET /data` 就是路由）；**没有方法的路径只认 `/api/<段>`**
 * （业务路由的通行写法），其余一律不猜。两个方向的代价不对称——漏掉一个真实的裸路径只会让冒烟
 * 记 `NO_ROUTES` 跳过，误判则会把整个切片做废。
 *
 * N-54（`docs/232` §9.26）：裸的 `/api` 本身是**挂载点**，不是端点——全库 1901 条 AC 文本里命中它的
 * 五处全是「`/api` 路由」「`/api/*`」这类散文/通配写法，没有一处是「GET /api 返回…」的端点声明。
 * 因此裸路径要求 `/api` 之后**还有一段**；通配路径另由 `normalizePath` 拒掉。
 */
const BARE_ROUTE = /^\/api\/.+/i;

/** 路径占位符换成固定 UUID：`/api/tasks/:id`、`/api/tasks/{id}` 都指向一个不存在但合法的资源。 */
const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

function normalizePath(raw: string): string | null {
  let path = raw.trim().replace(/[.,;:]+$/, "");
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) path = path.slice(0, queryIndex);
  // 通配族（`/api/*`、`/api/tasks/:id` 之外的 `*`）不是**一个**端点，探测哪个具体地址都是猜。
  if (path.includes("*")) return null;
  if (!path.startsWith("/")) return null;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path.length > 120) return null;
  if (path.startsWith("/__")) return null;
  return path;
}

function isBusinessPath(path: string): boolean {
  if (HEALTH_PATHS.some((pattern) => pattern.test(path))) return false;
  if (ASSET_EXTENSION.test(path)) return false;
  return true;
}

function substitutePlaceholders(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)|\{[A-Za-z_][A-Za-z0-9_]*\}/g, PLACEHOLDER);
}

/**
 * 从验收标准文本里取出**被点名的** HTTP 路由。
 *
 * 只收文本里明确写出的路径——不去猜（例如按 FR 编号推 REST 形状）。猜出来的路由会把「门自己的假设」
 * 变成失败依据，那正是本仓库反复出现的缺陷类型（`docs/160`）。文本里没写路由时返回空数组，
 * 由调用方记 `NO_ROUTES` 跳过，**不静默**。
 */
export function extractHttpRoutes(texts: readonly string[], limit = 8): SmokeRoute[] {
  const found: SmokeRoute[] = [];
  const seen = new Set<string>();
  const push = (method: string, rawPath: string, explicit: boolean): void => {
    if (found.length >= limit) return;
    const path = normalizePath(rawPath);
    if (path === null) return;
    // 裸路径只认 `/api…` 与健康端点（后者不进业务判定，但留在证据里当「进程活着」的读数）。
    if (
      !explicit &&
      !BARE_ROUTE.test(path) &&
      !HEALTH_PATHS.some((pattern) => pattern.test(path))
    ) {
      return;
    }
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ method, path });
  };

  for (const text of texts) {
    if (typeof text !== "string" || text === "") continue;
    for (const match of text.matchAll(METHOD_PATH)) {
      push(match[1] ?? "GET", match[2] ?? "", true);
    }
    for (const match of text.matchAll(BARE_PATH)) {
      push("GET", match[1] ?? "", false);
    }
  }
  return found;
}

/** 业务路由（挂载判定用）：健康端点与静态资源不算交付的业务面。 */
export function businessRoutes(routes: readonly SmokeRoute[]): SmokeRoute[] {
  return routes.filter((route) => isBusinessPath(route.path));
}

/**
 * 探测程序。**单引号 JS 字符串、无 `"`/`$`/反引号/反斜杠**——整段会被包进 shell 的双引号里
 * （与 `buildPackageFactsProbeCommand` 同一约束）。
 *
 * 进程用 `detached` 起，结束时按**进程组**杀：`npm run start` 会派生孙进程，只杀直接子进程会留下孤儿
 * 占着端口（沙箱容器随命令结束销毁，但孤儿会让本命令的退出等待变慢）。
 */
const SMOKE_PROGRAM =
  "const{spawn}=require('node:child_process');" +
  "const net=require('node:net');const fs=require('node:fs');const os=require('node:os');" +
  "const path=require('node:path');" +
  "const a=process.argv.slice(1);const startCmd=a[0];const port=Number(a[1]);" +
  "const routes=JSON.parse(a[2]);const bootTimeoutMs=Number(a[3]);const probeTimeoutMs=Number(a[4]);" +
  "const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-se-smoke-'));" +
  "const out={booted:false,exited:false,exitCode:null,signal:null,control:null,probes:[],stderrTail:'',detectedPort:null};" +
  "let stderr='';let stdout='';" +
  "const child=spawn(startCmd,{shell:true,detached:true,cwd:process.cwd()," +
  "env:Object.assign({},process.env,{PORT:String(port),DATA_DIR:dataDir,NODE_ENV:'test'})," +
  "stdio:['ignore','pipe','pipe']});" +
  "child.stdout.on('data',c=>{stdout+=c});child.stderr.on('data',c=>{stderr+=c});" +
  "child.on('exit',(code,signal)=>{out.exited=true;out.exitCode=code;out.signal=signal});" +
  "const wait=ms=>new Promise(r=>setTimeout(r,ms));" +
  "const connectTo=p=>new Promise(res=>{const s=net.connect({port:p,host:'127.0.0.1'});let done=false;" +
  "const fin=v=>{if(done)return;done=true;try{s.destroy()}catch(e){}res(v)};" +
  "s.on('connect',()=>fin(true));s.on('error',()=>fin(false));s.setTimeout(500,()=>fin(false))});" +
  "const probe=async(method,p,targetPort)=>{try{" +
  "const r=await fetch('http://127.0.0.1:'+targetPort+p,{method:method," +
  "headers:{'content-type':'application/json'}," +
  "body:method==='GET'||method==='HEAD'?undefined:'{}',redirect:'manual'," +
  "signal:AbortSignal.timeout(probeTimeoutMs)});" +
  "return{method:method,path:p,status:r.status}}catch(e){" +
  "return{method:method,path:p,status:null,error:String((e&&e.code)||e)}}};" +
  "(async()=>{const deadline=Date.now()+bootTimeoutMs;let live=null;" +
  "while(Date.now()<deadline){if(await connectTo(port)){live=port;break}if(out.exited)break;await wait(250)}" +
  "if(live===null){const m=/(?:listening[^0-9]{0,40}|http:\\/\\/(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):)([0-9]{2,5})/i.exec(stdout+stderr);" +
  "if(m){const declared=Number(m[1]);if(declared!==port&&await connectTo(declared)){live=declared;out.detectedPort=declared}}}" +
  "if(live!==null){out.booted=true;" +
  "out.control=await probe('GET','/__ai_se_smoke__'+Math.random().toString(36).slice(2),live);" +
  "for(const r of routes){out.probes.push(await probe(r.method,r.path,live))}}" +
  "out.stderrTail=stderr.slice(-2000);" +
  "try{process.kill(-child.pid,'SIGKILL')}catch(e){}try{child.kill('SIGKILL')}catch(e){}" +
  "process.stdout.write(JSON.stringify(out));process.exit(0)})()";

/** 单引号包裹：程序里不含单引号，所以无需转义。 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface ServerSmokeCommandInput {
  /** 项目声明的启动命令（`npm run start` / `pnpm start`）。 */
  startCommand: string;
  port: number;
  routes: readonly SmokeRoute[];
  bootTimeoutMs: number;
  probeTimeoutMs: number;
}

export function buildServerSmokeCommand(input: ServerSmokeCommandInput): string {
  const routes = input.routes.map((route) => ({
    method: route.method,
    path: substitutePlaceholders(route.path)
  }));
  return [
    "node -e",
    `"${SMOKE_PROGRAM}"`,
    shellSingleQuote(input.startCommand),
    shellSingleQuote(String(input.port)),
    shellSingleQuote(JSON.stringify(routes)),
    shellSingleQuote(String(input.bootTimeoutMs)),
    shellSingleQuote(String(input.probeTimeoutMs))
  ].join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asProbe(value: unknown): ServerSmokeProbe | null {
  if (!isRecord(value)) return null;
  const method = typeof value.method === "string" ? value.method : "GET";
  const path = typeof value.path === "string" ? value.path : "";
  const status = typeof value.status === "number" ? value.status : null;
  if (path === "") return null;
  return {
    method,
    path,
    status,
    ...(typeof value.error === "string" ? { error: value.error } : {})
  };
}

/** 解析探测输出。取**最后一行**可解析的 JSON——`npm run start` 的日志走的是被捕获的管道，
 *  正常不会污染 stdout；多行时仍以最后一条为准，避免把业务日志误当结论。 */
export function parseServerSmokeOutput(stdout: string): ServerSmokeResult | null {
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
    const probes = Array.isArray(parsed.probes)
      ? parsed.probes.map(asProbe).filter((entry): entry is ServerSmokeProbe => entry !== null)
      : [];
    return {
      booted: parsed.booted,
      exited: parsed.exited === true,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
      control: asProbe(parsed.control),
      probes,
      stderrTail: typeof parsed.stderrTail === "string" ? parsed.stderrTail : "",
      ...(typeof parsed.detectedPort === "number" ? { detectedPort: parsed.detectedPort } : {})
    };
  }
  return null;
}

/**
 * 环境类启动失败（缺依赖、无网、包管理器不存在）：**不判交付缺陷**。
 * 沙箱默认无外网，`npm run start` 因为 `node_modules` 没装而失败是环境问题，与产物无关——
 * 让环境把切片判死，等于把 `docs/232` 里反复出现的假阴性再造一遍。
 */
const ENV_FAILURE = /Cannot find module|MODULE_NOT_FOUND|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|registry\.npmjs\.org|(?:npm|pnpm|yarn): (?:not found|command not found)|command not found/i;

/**
 * 环境类启动失败判定。导出是因为 `uiSmoke`（`docs/233` §5.2）用的是**同一条**判据——
 * 「沙箱里起不来的原因是不是产物的问题」只有一个答案，两处各写一份就会漂移。
 */
export function isEnvironmentBootFailure(text: string): boolean {
  return ENV_FAILURE.test(text);
}

export function evaluateServerSmoke(
  result: ServerSmokeResult,
  routes: readonly SmokeRoute[]
): ServerSmokeVerdict {
  const business = businessRoutes(routes);
  if (business.length === 0) return { kind: "skipped", reason: "NO_ROUTES" };

  if (!result.booted) {
    if (isEnvironmentBootFailure(result.stderrTail)) {
      return { kind: "skipped", reason: "BOOT_ENV_UNRESOLVED" };
    }
    const exit = result.exited
      ? ` exited with ${result.exitCode ?? "null"}${result.signal ? ` (${result.signal})` : ""}`
      : " never answered";
    return {
      kind: "failed",
      failureCode: "BOOT_FAILED",
      detail: `start script${exit}; no listen on the requested port`
    };
  }

  // **只数业务探测**：健康端点返回 200 只证明进程活着，把它算进「已挂载」正是 N-49 的形状
  // （第六次回归里 `/healthz` 200 而 `/api/register` 404，健康端点一计入就会把「没挂」读成「挂上了」）。
  const businessKeys = new Set(
    business.map((route) => `${route.method} ${substitutePlaceholders(route.path)}`)
  );
  const businessProbes = result.probes.filter((probe) =>
    businessKeys.has(`${probe.method} ${probe.path}`)
  );
  const mounted = businessProbes.filter((probe) => probe.status !== null && probe.status !== 404);
  if (mounted.length === 0) {
    // 带占位符的路由（`/api/tasks/:id`）对不存在的资源返回 404 是**合法**的——它不能作为
    // 「没挂上」的证据。切片里只点名了这类路由时，只能留痕跳过，不判死。
    const decisive = business.filter((route) => !/:|\{/.test(route.path));
    if (decisive.length === 0) return { kind: "skipped", reason: "ONLY_PARAMETERIZED_ROUTES" };
    const statuses = businessProbes
      .map((probe) => `${probe.method} ${probe.path} -> ${probe.status ?? probe.error ?? "no response"}`)
      .join(", ");
    return {
      kind: "failed",
      failureCode: "SURFACE_UNMOUNTED",
      detail:
        `the server is up but every business route named by this slice's acceptance criteria ` +
        `returned 404 (${statuses || "no business probe ran"})`
    };
  }
  return { kind: "passed", businessProbes };
}

/** AC 文本里点名的路由总数上限——探测成本与证据体积的折中。 */
export const SMOKE_ROUTE_LIMIT = 8;
export const SMOKE_BOOT_TIMEOUT_MS = 20_000;
export const SMOKE_PROBE_TIMEOUT_MS = 5_000;
export const SMOKE_COMMAND_TIMEOUT_MS = 60_000;

/** 从任务输入里取验收标准文本（`input.acceptanceCriteria`），忽略形状不符的条目。 */
export function acceptanceTexts(inputs: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const input of inputs) {
    if (!isRecord(input)) continue;
    const criteria = input.acceptanceCriteria;
    if (!Array.isArray(criteria)) continue;
    for (const entry of criteria) {
      if (typeof entry === "string" && entry.trim() !== "") texts.push(entry);
    }
  }
  return texts;
}
