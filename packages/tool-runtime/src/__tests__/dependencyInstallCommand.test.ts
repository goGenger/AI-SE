import { describe, expect, it } from "vitest";
import { isDependencyInstallCommand, isPlaywrightBrowserInstallCommand } from "../tools/packageManager";

/**
 * `docs/236` §4.2：**命令分类**——只有装依赖拿得出网。
 *
 * 设计原文的要求是「保守：出现管道、命令替换、`sh -c` 包装、`&&` 串联时**不算** install
 * （宁可拒绝联网，也不放过拼接）」。这组用例就是那句话的逐条展开。
 *
 * 为什么这么保守：拿不到 registry 的 install 只是装不上；而**误判成 install** 会让一条
 * 任意命令带上网络。两个方向的代价不对称。
 */
describe("docs/236 §4.2：install 命令分类", () => {
  describe("认得的安装命令", () => {
    it.each([
      "pnpm install",
      "pnpm install --frozen-lockfile",
      "pnpm i",
      "pnpm ci",
      "pnpm add chalk",
      "pnpm add -D typescript",
      "npm install",
      "npm install --production",
      "npm i",
      "npm ci",
      "npm add left-pad",
      "yarn add react",
      "yarn install",
      "  pnpm install  "
    ])("%s", (command) => {
      expect(isDependencyInstallCommand(command), command).toBe(true);
    });
  });

  describe("拼接 / 管道 / 命令替换一律不算（宁可拒绝联网）", () => {
    it.each([
      ["链式", "pnpm install && curl http://1.1.1.1"],
      ["链式（install 在后）", "evil && pnpm install"],
      ["管道", "pnpm install | tee log"],
      ["分号", "pnpm install; curl http://1.1.1.1"],
      ["或", "pnpm install || pnpm add x"],
      ["重定向", "pnpm install > out.txt"],
      ["命令替换（反引号）", "pnpm install `whoami`"],
      ["命令替换（$()）", "pnpm install $(curl http://1.1.1.1)"],
      ["变量展开", "pnpm install $EXTRA"],
      ["换行", "pnpm install\ncurl http://1.1.1.1"],
      ["未闭合引号", "pnpm install '"],
      ["sh -c 包装", 'sh -c "pnpm install"'],
      ["bash -c 包装", 'bash -c "pnpm install"'],
      ["node -e 包装", 'node -e "require(\'child_process\').execSync(\'pnpm install\')"'],
      ["env 前缀", "env pnpm install"],
      ["nohup 前缀", "nohup pnpm install"],
      ["绝对路径命令头", "/usr/local/bin/pnpm install"]
    ])("%s", (_label, command) => {
      expect(isDependencyInstallCommand(command), command).toBe(false);
    });
  });

  describe("非安装类：不给出网", () => {
    it.each([
      ["构建", "pnpm build"],
      ["测试", "pnpm test"],
      ["脚本", "pnpm run build"],
      ["预览", "pnpm preview"],
      ["更新", "pnpm update"],
      ["升级", "pnpm upgrade"],
      ["移除", "pnpm remove chalk"],
      ["审计", "pnpm audit"],
      ["发布", "pnpm publish"],
      ["子目录安装（cd 属拼接之外的单独路径）", "npm run install-deps"]
    ])("%s", (_label, command) => {
      expect(isDependencyInstallCommand(command), command).toBe(false);
    });
  });

  it("只认显式动词：`npm run install` 不是安装（那是项目脚本，名字恰好叫 install）", () => {
    // 关键区分：`npm run <script>` 执行的是项目自己的代码，不是包管理器在装东西。
    expect(isDependencyInstallCommand("npm run install")).toBe(false);
    expect(isDependencyInstallCommand("pnpm run install")).toBe(false);
  });

  it("空串 / 纯空白不算", () => {
    expect(isDependencyInstallCommand("")).toBe(false);
    expect(isDependencyInstallCommand("   ")).toBe(false);
  });

  it("引号内的 `&&` 是数据，仍算 install（与两条黑名单同一个引号口径）", () => {
    // `pnpm add 'a&&b'` 里的 `&&` 在引号内，shell 不会把它当控制符。
    expect(isDependencyInstallCommand("pnpm add 'a&&b'")).toBe(true);
  });
});


describe("docs/255：Playwright browser install command detection", () => {
  it.each([
    "npx playwright install chromium",
    "npx playwright@1.64.1 install chromium",
    "playwright install",
    "pnpm exec playwright install chromium",
    "npm exec playwright install chromium",
    "npm run test:e2e:install",
    "pnpm run test:e2e:install"
  ])("recognizes %s", (command) => {
    expect(isPlaywrightBrowserInstallCommand(command)).toBe(true);
    expect(isDependencyInstallCommand(command)).toBe(false);
  });

  it.each(["npm run test", "pnpm install", "npm run build", "npx playwright test"])(
    "rejects %s",
    (command) => {
      expect(isPlaywrightBrowserInstallCommand(command)).toBe(false);
    }
  );
});
