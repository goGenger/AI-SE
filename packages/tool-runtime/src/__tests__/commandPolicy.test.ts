import { describe, expect, it } from "vitest";
import { assertCommandAllowed } from "../tools/commandTools";

/**
 * N-44（`docs/232` §9.5）：命令黑名单只作用于**会被执行的词**，不再对整串命令做正则。
 *
 * 原始缺陷（2026-10-24 归因）：AC 作用域检查拼出的命令把测试文件路径当参数传进去，
 * `test/docker-entrypoint.test.js` 命中 `\bdocker\b`（`-` 是词边界）→ 整条命令被拒 →
 * 沙箱里根本没跑（exitCode null）→ 任务判 `checks failed: test`。同一串手工执行 16/16 通过。
 */

function blocked(command: string): boolean {
  try {
    assertCommandAllowed(command);
    return false;
  } catch {
    return true;
  }
}

describe("N-44 命令黑名单：数据不是命令", () => {
  it("AC 作用域测试命令（实值形状）放行——这是那 5 次失败的原始命令", () => {
    expect(
      blocked(
        "pnpm test -- 'test/deploy-contract.test.js' 'test/deployment-contract.test.js' " +
          "'test/deployment-runtime.test.js' 'test/docker-entrypoint.test.js' " +
          "--test-name-pattern '\\[AC-24\\]|\\[AC-25\\]|\\[AC-26\\]' --test-timeout=24000"
      )
    ).toBe(false);
  });

  it("未加引号的路径同样放行（路径 ≠ 可执行词）", () => {
    expect(blocked("pnpm test -- test/docker-entrypoint.test.js")).toBe(false);
    expect(blocked("node --test test/docker-volume.test.js")).toBe(false);
    expect(blocked("npm run test -- 'test/ssh-keys.test.js'")).toBe(false);
    expect(blocked("pnpm build")).toBe(false);
    expect(blocked("node src/scripts/build.js")).toBe(false);
  });

  it("真正的命令词仍然拦住（命令头、绝对路径、包装器）", () => {
    expect(blocked("docker build -t taskboard .")).toBe(true);
    expect(blocked("/usr/bin/docker ps")).toBe(true);
    expect(blocked("sudo docker ps")).toBe(true);
    expect(blocked("xargs docker rm")).toBe(true);
    expect(blocked("curl http://example.com")).toBe(true);
    expect(blocked("docker")).toBe(true);
  });

  it("解释器的 -c/-e 载荷是要执行的代码，按旧口径整串拒绝", () => {
    expect(blocked('sh -c "docker build ."')).toBe(true);
    expect(blocked("bash -c 'curl http://example.com'")).toBe(true);
    expect(blocked('node -e "require(\'child_process\').execSync(\'docker ps\')"')).toBe(true);
    // 解释器 + 普通脚本参数不被误伤。
    expect(blocked("node --test 'test/docker-entrypoint.test.js'")).toBe(false);
  });

  it("半引号拼接不能绕过黑名单", () => {
    expect(blocked("doc'ker' ps")).toBe(true);
  });
});

describe("docs/264：禁止在沙箱升级 Playwright 或安装浏览器", () => {
  it("blocks playwright browser installs and unpinned package bumps", () => {
    expect(blocked("npx playwright install chromium")).toBe(true);
    expect(blocked("npm run test:e2e:install")).toBe(true);
    expect(blocked("npm install -D playwright@1.65.0")).toBe(true);
    expect(blocked("pnpm add @playwright/test@latest")).toBe(true);
  });

  it("allows official e2e, ordinary installs, and an explicit platform pin", () => {
    expect(blocked("npm run test:e2e -- --workers=2")).toBe(false);
    expect(blocked("npm install --no-audit --no-fund --prefer-offline")).toBe(false);
    expect(blocked("npm install -D playwright@1.64.1 @playwright/test@1.64.1")).toBe(false);
  });
});

