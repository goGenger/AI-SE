import { describe, expect, it } from "vitest";
import { ciEnvironment } from "../services/deliveryAdapters";

/**
 * N-45（`docs/232` §9.7）：本地 CI 的六步契约必须在**隔离环境**里跑。
 *
 * 实测缺陷（2026-10-24）：平台以 `PORT=47558` 启动，`LocalCiOperations.runCi` 用 `env: process.env`
 * 把端口带进了工作区，E1 的「未设置 PORT 时默认 3000」当场失败——三次 CI 全挂在同一条 AC-01 上，
 * 而 oracle 在同一个工作区里 29/29 全过（假阴性 1）。
 */
describe("N-45 本地 CI 的环境隔离", () => {
  it("平台自己的启动参数一律不带（端口 / 库连接 / 闸门 / 密钥）", () => {
    const env = ciEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/dev",
      PORT: "47558",
      VERIFICATION_GATE: "enforce",
      DATABASE_URL: "postgres://ai_se@localhost:5432/ai_se",
      POSTGRES_USER: "ai_se",
      POSTGRES_PASSWORD: "secret",
      MODEL_API_KEY: "sk-test",
      AUTONOMY_LEVEL: "L1"
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/dev");
    for (const key of [
      "PORT",
      "VERIFICATION_GATE",
      "DATABASE_URL",
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "MODEL_API_KEY",
      "AUTONOMY_LEVEL"
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("执行所需的东西留着（本地化 / 临时目录 / 代理 / 容器 daemon）", () => {
    const env = ciEnvironment({
      LANG: "zh_CN.UTF-8",
      TMPDIR: "/var/folders/tmp",
      HTTPS_PROXY: "http://proxy.internal:3128",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      COREPACK_HOME: "/Users/dev/.cache/node/corepack"
    });

    expect(env.LANG).toBe("zh_CN.UTF-8");
    expect(env.TMPDIR).toBe("/var/folders/tmp");
    expect(env.HTTPS_PROXY).toBe("http://proxy.internal:3128");
    expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(env.COREPACK_HOME).toBe("/Users/dev/.cache/node/corepack");
  });

  it("未设置的变量不会以 undefined 形式出现（spawn 会把它变成字符串 \"undefined\"）", () => {
    const env = ciEnvironment({ PATH: "/usr/bin" });
    expect(Object.values(env).every((value) => typeof value === "string")).toBe(true);
    expect("HOME" in env).toBe(false);
  });
});
