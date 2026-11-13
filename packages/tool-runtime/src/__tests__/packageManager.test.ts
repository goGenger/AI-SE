import { Sandbox, SandboxCommand, SandboxResult } from "@ai-se/sandbox";
import { describe, expect, it } from "vitest";
import { ToolRuntime } from "../ToolRuntime";
import { createPhase1Tools } from "../tools";
import {
  buildPackageFactsProbeCommand,
  buildRunnerCommand,
  containsUnquotedShellSyntax,
  dependencyInstallCommand,
  isDependencyInstallCommand,
  isScriptOnlyCommand,
  packageRunnerFor,
  parsePackageFacts,
  planPackageScriptCommand,
  pnpmWorkspaceHasPackagesField,
  type PackageFacts
} from "../tools/packageManager";
import { ToolExecutionContext } from "../types";

/**
 * F1-7（FX-25）：包管理器探测模块 + 工具默认命令分支单测。
 * 分支：packageManager 字段 / 唯一锁文件 / 多锁文件（固定顺序 + 警告）/ 无货回退 npm /
 * 无 package.json 报错 / 脚本不存在报错 / 显式 command 覆盖（不触发探测）。
 */

class FakeSandbox implements Sandbox {
  public commands: SandboxCommand[] = [];

  constructor(private readonly handler: (command: SandboxCommand) => SandboxResult | undefined) {}

  async runCommand(_workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    this.commands.push(command);
    const result = this.handler(command);
    if (!result) throw new Error(`unscripted sandbox command: ${command.command}`);
    return result;
  }
}

function sandboxResult(
  command: SandboxCommand,
  overrides: Partial<SandboxResult> = {}
): SandboxResult {
  return {
    command: command.command,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    duration: 1,
    timedOut: false,
    ...overrides
  };
}

function context(sandbox: Sandbox): ToolExecutionContext {
  return {
    requestId: "req-1",
    taskId: "task-1",
    agentRunId: "run-1",
    toolCallId: "tool-call-1",
    actor: "test",
    workspacePath: process.cwd(),
    sandbox,
    timeoutMs: 20
  };
}

function factsJson(facts: Partial<PackageFacts> & { scripts?: Record<string, unknown> }): string {
  return JSON.stringify({
    hasPackageJson: facts.hasPackageJson ?? true,
    ...(facts.packageManager ? { packageManager: facts.packageManager } : {}),
    lockfiles: facts.lockfiles ?? [],
    scripts: facts.scripts ?? {}
  });
}

describe("packageManager 探测模块", () => {
  it("探测命令包含 package.json 读取与锁文件清单", () => {
    const command = buildPackageFactsProbeCommand();
    expect(command).toContain("package.json");
    expect(command).toContain("pnpm-lock.yaml");
    expect(command).toContain("packageManager");
    expect(command).toContain("pnpm-workspace.yaml");
  });

  it("解析新形状输出（含锁文件顺序过滤）", () => {
    const facts = parsePackageFacts(
      factsJson({
        packageManager: "pnpm@9.15.0",
        lockfiles: ["yarn.lock", "pnpm-lock.yaml", "unknown.lock"],
        scripts: { test: "node --test" }
      })
    );
    expect(facts.hasPackageJson).toBe(true);
    expect(facts.packageManager).toBe("pnpm@9.15.0");
    // 固定顺序归一：pnpm-lock.yaml 在 yarn.lock 之前；未知锁文件被剔除。
    expect(facts.lockfiles).toEqual(["pnpm-lock.yaml", "yarn.lock"]);
    expect(facts.scripts.test).toBe("node --test");
  });

  it("兼容旧形状输出（scripts 映射 → npm 回退语义）", () => {
    const facts = parsePackageFacts('{"build":"node scripts/build.mjs","test":"node --test"}');
    expect(facts.hasPackageJson).toBe(true);
    expect(facts.lockfiles).toEqual([]);
    expect(facts.packageManager).toBeUndefined();
    expect(planPackageScriptCommand("test", facts).command).toBe("npm run test");
  });

  it("坏 JSON → 空事实（不抛错）", () => {
    const facts = parsePackageFacts("not-json");
    expect(facts.hasPackageJson).toBe(true);
    expect(facts.scripts).toEqual({});
  });

  it("packageManager 字段优先于锁文件", () => {
    const plan = planPackageScriptCommand("test", {
      hasPackageJson: true,
      packageManager: "pnpm@8.15.0",
      lockfiles: ["yarn.lock"],
      scripts: { test: "node --test" }
    });
    expect(plan.runner).toBe("pnpm");
    expect(plan.command).toBe("pnpm test");
    expect(plan.warnings).toEqual([]);
  });

  it("唯一锁文件决定 runner（pnpm-lock → pnpm；package-lock → npm）", () => {
    expect(
      planPackageScriptCommand("lint", {
        hasPackageJson: true,
        lockfiles: ["pnpm-lock.yaml"],
        scripts: { lint: "eslint ." }
      }).command
    ).toBe("pnpm lint");
    expect(
      planPackageScriptCommand("build", {
        hasPackageJson: true,
        lockfiles: ["package-lock.json"],
        scripts: { build: "tsc" }
      }).command
    ).toBe("npm run build");
  });

  it("多锁文件：固定顺序选择 + 警告", () => {
    const plan = planPackageScriptCommand("test", {
      hasPackageJson: true,
      lockfiles: ["yarn.lock", "pnpm-lock.yaml"],
      scripts: { test: "node --test" }
    });
    expect(plan.runner).toBe("pnpm");
    expect(plan.command).toBe("pnpm test");
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("pnpm-lock.yaml");
    expect(plan.warnings[0]).toContain("yarn.lock");
    expect(plan.warnings[0]).toContain("fixed order");
  });

  it("零依赖且无锁文件的项目走 npm 回退（npm 随 node 镜像自带）", () => {
    const plan = planPackageScriptCommand("test", {
      hasPackageJson: true,
      lockfiles: [],
      scripts: { test: "node --test" }
    });
    expect(plan.runner).toBe("npm");
    expect(plan.command).toBe("npm run test");
    expect(plan.error).toBeUndefined();
  });

  it("无 package.json → NO_PACKAGE_JSON；脚本不存在 → SCRIPT_NOT_FOUND", () => {
    const missingPkg = planPackageScriptCommand("test", {
      hasPackageJson: false,
      lockfiles: [],
      scripts: {}
    });
    expect(missingPkg.error).toBe("NO_PACKAGE_JSON");
    expect(missingPkg.command).toBeUndefined();

    const missingScript = planPackageScriptCommand("test", {
      hasPackageJson: true,
      lockfiles: [],
      scripts: { lint: "eslint ." }
    });
    expect(missingScript.error).toBe("SCRIPT_NOT_FOUND");
    expect(missingScript.errorMessage).toContain('"test"');
  });
});

describe("工具默认命令探测（FX-25）", () => {
  it("无显式 command：探测后按项目 runner 运行（pnpm → `pnpm test`）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.command.includes("package.json"))
        return sandboxResult(command, {
          stdout: factsJson({ packageManager: "pnpm@9.15.0", scripts: { test: "node --test" } })
        });
      return sandboxResult(command, { stdout: "ok 1" });
    });
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute("run_unit_test", {}, context(sandbox));

    expect(result.success).toBe(true);
    expect(sandbox.commands).toHaveLength(2);
    expect(sandbox.commands[0].command).toContain("package.json");
    expect(sandbox.commands[1].command).toBe("pnpm test");
  });

  it("多锁文件警告随工具结果返回", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.command.includes("package.json"))
        return sandboxResult(command, {
          stdout: factsJson({
            lockfiles: ["yarn.lock", "pnpm-lock.yaml"],
            scripts: { test: "node --test" }
          })
        });
      return sandboxResult(command, { stdout: "ok 1" });
    });
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute("run_unit_test", {}, context(sandbox));

    expect(result.success).toBe(true);
    expect((result.data as { warnings?: string[] }).warnings?.[0]).toContain("fixed order");
    expect(sandbox.commands[1].command).toBe("pnpm test");
  });

  it("显式 command 覆盖：不触发探测，单命令直跑", async () => {
    const sandbox = new FakeSandbox((command) => sandboxResult(command, { stdout: "custom" }));
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute(
      "run_unit_test",
      { command: "node --test custom.test.mjs" },
      context(sandbox)
    );

    expect(result.success).toBe(true);
    expect(sandbox.commands).toHaveLength(1);
    expect(sandbox.commands[0].command).toBe("node --test custom.test.mjs");
  });

  it("无 package.json → 明确报错（不静默回退）", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.command.includes("package.json"))
        return sandboxResult(command, { stdout: factsJson({ hasPackageJson: false }) });
      return undefined;
    });
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute("run_unit_test", {}, context(sandbox));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TEST_ERROR");
    expect(result.error?.message).toContain("package.json not found");
    expect(sandbox.commands).toHaveLength(1);
  });

  it("脚本不存在 → 明确报错", async () => {
    const sandbox = new FakeSandbox((command) => {
      if (command.command.includes("package.json"))
        return sandboxResult(command, {
          stdout: factsJson({ scripts: { lint: "eslint ." } })
        });
      return undefined;
    });
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const result = await runtime.execute("run_build", {}, context(sandbox));

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("COMMAND_ERROR");
    expect(result.error?.message).toContain('"build" not found');
  });

  it("buildRunnerCommand 形态", () => {
    expect(buildRunnerCommand("npm", "test")).toBe("npm run test");
    expect(buildRunnerCommand("pnpm", "test")).toBe("pnpm test");
    expect(buildRunnerCommand("yarn", "lint")).toBe("yarn lint");
  });
});

/**
 * F2-2（FX-34）：构建/测试类工具的命令面收口——只接受项目脚本形态；任意命令串拒绝。
 * 关键词扫描让位于允许清单；通用 shell 由 run_command 承载（不受本收口影响）。
 */
describe("F2-2（FX-34）：脚本命令收口", () => {
  it("接受：脚本调用形态（含验证门作用域形态引用透传）", () => {
    for (const command of [
      "npm run build",
      "npm test",
      "npm run test -- --test-name-pattern '\\[AC-01\\]|\\[AC-1\\]'",
      "pnpm run lint",
      "pnpm test:unit",
      "yarn build",
      "node --test tests/ac-01.test.mjs",
      "node --test --test-name-pattern 'a|b' tests",
      "node scripts/build.mjs",
      "node scripts/check.cjs"
    ]) {
      expect(isScriptOnlyCommand(command), command).toBe(true);
    }
  });

  it("拒绝：任意命令串（连接/管道/重定向/替换/解释器/保留子命令/前置旗标）", () => {
    for (const command of [
      "npm run build && rm -rf dist",
      "npm run build; touch x",
      "npm run build | tee log",
      "npm test > out.txt",
      "npm run build 2>&1",
      "node -e \"require('fs').writeFileSync('a','b')\"",
      "bash -c 'npm run build'",
      'sh -c "touch x"',
      "pnpm dlx cowsay",
      "pnpm install",
      "yarn add left-pad",
      "npm run build $(cat list)",
      "npm run build `whoami`",
      "npm run build --prefix /tmp",
      "npm run build && cd sub && npm test",
      "node /tmp/evil.js",
      "node ../evil.js",
      "node --eval \"require('fs').writeFileSync('a','b')\""
    ]) {
      expect(isScriptOnlyCommand(command), command).toBe(false);
    }
    // 引号内测试模式字符不误伤；未闭合引号拒绝。
    expect(containsUnquotedShellSyntax("'a|b'")).toBe(false);
    expect(containsUnquotedShellSyntax("'a|b")).toBe(true);
  });

  it("工具层强制：三工具拒绝任意串；run_command 不受限", async () => {
    const sandbox = new FakeSandbox((command) => sandboxResult(command));
    const runtime = new ToolRuntime({ tools: createPhase1Tools() });

    const rejected = await runtime.execute(
      "run_build",
      { command: "npm run build && rm -rf dist" },
      context(sandbox)
    );
    expect(rejected.success).toBe(false);
    expect(rejected.error?.message).toContain("blocked by script-only policy");

    const rejectedTest = await runtime.execute(
      "run_unit_test",
      { command: "bash -c 'npm test'" },
      context(sandbox)
    );
    expect(rejectedTest.success).toBe(false);
    expect(rejectedTest.error?.message).toContain("script-only");

    const rejectedLint = await runtime.execute(
      "run_lint",
      { command: 'node -e "process.exit(0)"' },
      context(sandbox)
    );
    expect(rejectedLint.success).toBe(false);
    expect(rejectedLint.error?.message).toContain("script-only");

    // 显式脚本命令放行（不触发探测；不进入沙箱前即被判定）。
    const allowed = await runtime.execute(
      "run_build",
      { command: "npm run build" },
      context(sandbox)
    );
    expect(allowed.success).toBe(true);

    // 通用 shell（run_command）仍可直接执行——含连接符的命令不被脚本收口拦截。
    const general = await runtime.execute(
      "run_command",
      { command: "npm run build && echo done" },
      context(sandbox)
    );
    expect(general.success).toBe(true);
  });
});

/**
 * N-67（`docs/232` §10）：验证门装依赖用的两个出口。
 *
 * 两者必须与**默认命令解析同源**：验证门跑 `pnpm build`，装依赖就不能是 `npm ci`——
 * 两个包管理器各装一套 `node_modules`，第二条命令仍然找不到可执行文件（那正是 N-67 的形状）。
 */
describe("N-67：装依赖命令解析", () => {
  const facts = (overrides: Partial<PackageFacts> = {}): PackageFacts => ({
    hasPackageJson: true,
    lockfiles: [],
    scripts: {},
    ...overrides
  });

  it("packageRunnerFor 与 planPackageScriptCommand 判同一个 runner", () => {
    const cases: PackageFacts[] = [
      facts({ packageManager: "pnpm@9.15.0" }),
      facts({ packageManager: "yarn@1.22.22" }),
      facts({ packageManager: "npm@10.0.0" }),
      facts({ lockfiles: ["pnpm-lock.yaml"] }),
      facts({ lockfiles: ["yarn.lock"] }),
      facts({ lockfiles: ["package-lock.json"] }),
      facts({ lockfiles: ["yarn.lock", "package-lock.json"] }),
      facts({ scripts: { build: "tsc -p ." } })
    ];
    for (const entry of cases) {
      expect(packageRunnerFor(entry)).toBe(
        planPackageScriptCommand("build", { ...entry, scripts: { build: "tsc -p ." } }).runner
      );
    }
  });

  it("frozen 用锁文件精确匹配；relaxed 退回普通安装", () => {
    expect(dependencyInstallCommand("pnpm", true)).toBe("pnpm install --frozen-lockfile");
    expect(dependencyInstallCommand("pnpm", false)).toBe("pnpm install");
    expect(dependencyInstallCommand("yarn", true)).toBe("yarn install --frozen-lockfile");
    expect(dependencyInstallCommand("yarn", false)).toBe("yarn install");
    expect(dependencyInstallCommand("npm", true)).toBe("npm ci");
    expect(dependencyInstallCommand("npm", false)).toBe("npm install");
  });

  it("生成的命令都过 install 分类（否则装依赖拿不到 registry 网络）", () => {
    for (const runner of ["pnpm", "yarn", "npm"] as const) {
      for (const frozen of [true, false]) {
        const command = dependencyInstallCommand(runner, frozen);
        expect(isDependencyInstallCommand(command), command).toBe(true);
      }
    }
  });
});


describe("docs/263：双锁文件 + 无效 pnpm-workspace 不得优先 pnpm", () => {
  const bothLocks = ["pnpm-lock.yaml", "package-lock.json"] as const;

  it("pnpmWorkspaceHasPackagesField rejects allowBuilds-only and empty packages", () => {
    expect(pnpmWorkspaceHasPackagesField("allowBuilds:\n  esbuild: set this to true or false\n")).toBe(
      false
    );
    expect(pnpmWorkspaceHasPackagesField("packages: []\n")).toBe(false);
    expect(pnpmWorkspaceHasPackagesField("packages:\n  - '.'\n")).toBe(true);
    expect(pnpmWorkspaceHasPackagesField("packages: ['.']\n")).toBe(true);
  });

  it("both lockfiles + missing or invalid workspace yaml → npm, not pnpm", () => {
    const missing = planPackageScriptCommand("build", {
      hasPackageJson: true,
      lockfiles: [...bothLocks],
      pnpmWorkspace: { present: false, hasPackages: false },
      scripts: { build: "vue-tsc --noEmit && vite build" }
    });
    expect(missing.runner).toBe("npm");
    expect(missing.command).toBe("npm run build");
    expect(missing.warnings.some((warning) => warning.includes("no packages field") || warning.includes("using npm"))).toBe(
      true
    );

    const invalid = planPackageScriptCommand("test", {
      hasPackageJson: true,
      lockfiles: [...bothLocks],
      pnpmWorkspace: { present: true, hasPackages: false },
      scripts: { test: "vitest run" }
    });
    expect(invalid.runner).toBe("npm");
    expect(invalid.command).toBe("npm run test");
  });

  it("legacy facts without pnpmWorkspace keep historical lockfile order (pnpm first)", () => {
    const plan = planPackageScriptCommand("test", {
      hasPackageJson: true,
      lockfiles: [...bothLocks],
      scripts: { test: "vitest run" }
    });
    expect(plan.runner).toBe("pnpm");
    expect(plan.command).toBe("pnpm test");
  });

  it("valid workspace packages field still prefers pnpm when both lockfiles exist", () => {
    const plan = planPackageScriptCommand("test", {
      hasPackageJson: true,
      lockfiles: [...bothLocks],
      pnpmWorkspace: { present: true, hasPackages: true },
      scripts: { test: "vitest run" }
    });
    expect(plan.runner).toBe("pnpm");
    expect(plan.command).toBe("pnpm test");
  });

  it("parsePackageFacts keeps pnpmWorkspace from the probe output", () => {
    const facts = parsePackageFacts(
      JSON.stringify({
        hasPackageJson: true,
        lockfiles: ["pnpm-lock.yaml", "package-lock.json"],
        scripts: { test: "vitest run" },
        pnpmWorkspace: { present: true, hasPackages: false }
      })
    );
    expect(facts.pnpmWorkspace).toEqual({ present: true, hasPackages: false });
    expect(packageRunnerFor(facts)).toBe("npm");
  });
});
