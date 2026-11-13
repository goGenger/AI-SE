import { describe, expect, it } from "vitest";
import { isPathUnderPrefixes, isRootDeliveryArtifactPath } from "./index";

/**
 * PL-M11（`docs/170`）：**唯一**的「这是不是一个仓库根交付物」判据。只判**仓库根级**条目。
 *
 * 它同时支撑两件事，因此与 `isTestFilePath` / `isProjectManifestPath` 同置于 shared：
 *  - `apps/server` 的写范围审计（原 `DEVOPS_PATH` 的 Dockerfile / compose / .dockerignore /
 *    README 四条正则，且只挂在 `DEPLOY` 上）；
 *  - `@ai-se/agent-core` 的写权限（声明了 `writeRootDeliveryArtifacts` 的 agent）。
 *
 * 修前这两件事在计划里都是 `BACKEND` 任务（L1-M4c run 2 的 S4-10「编写 Dockerfile … 保证
 * `docker build -t taskboard .` 成功」与 S4-13「编写 README …」），而没有任何 agent 能写仓库根，
 * 于是 oracle 的容器段在仓库根跑不出构建上下文 —— AC-24/25/26/29 四条 Must 全灭。
 */

describe("isRootDeliveryArtifactPath (PL-M11)", () => {
  it.each([
    ["Dockerfile", true],
    ["Dockerfile.dev", true],
    ["Dockerfile.prod", true],
    ["dockerfile", true],
    [".dockerignore", true],
    ["compose.yaml", true],
    ["compose.yml", true],
    ["docker-compose.yaml", true],
    ["docker-compose.yml", true],
    ["docker-compose.prod.yml", true],
    ["docker-compose.ci.yaml", true],
    ["README", true],
    ["README.md", true],
    ["readme.md", true],
    ["README.rst", true],
    // 变体后缀同属交付物家族：审计侧原正则 `^Dockerfile` 与 `^README(\.|$)` 同样命中它们，
    // 本判据逐条沿用该语义（收窄它们只会再造一处两侧分歧）。
    ["Dockerfile.bak", true],
    ["README.bak", true],
    ["./Dockerfile", true],
    // 只判根级：同名文件出现在子目录里不是「仓库根交付物」。
    ["docker/Dockerfile", false],
    ["infrastructure/Dockerfile", false],
    ["backend/README.md", false],
    ["apps/server/package.json", false],
    // 非交付物：工程清单（归 PL-M10 的 `isProjectManifestPath`）、源码、其他文档一律为假。
    ["package.json", false],
    ["tsconfig.json", false],
    [".gitignore", false],
    ["index.js", false],
    ["compose.yaml.bak", false],
    ["notes.txt", false],
    ["docs/guide.md", false],
    ["", false]
  ])("isRootDeliveryArtifactPath(%s) => %s", (path, expected) => {
    expect(isRootDeliveryArtifactPath(path)).toBe(expected);
  });

  it("treats windows separators the same as posix ones", () => {
    expect(isRootDeliveryArtifactPath("Dockerfile")).toBe(true);
    expect(isRootDeliveryArtifactPath("docker\\Dockerfile")).toBe(false);
  });
});

/**
 * PL-M12（`docs/170` §4 裁定 7）：前缀判定的**唯一**实现——`ToolRuntimeBackend` 的读写权限与
 * `apps/server` 的写范围审计共用它。审计侧原先手抄的 `SOURCE_PATH` 描述的是 `app/`（单数）、
 * `pages/`、`lib/`、`components/` 这类本仓库并不存在的布局，于是对真实的 `apps/`、`packages/`
 * 一律误报越界（L1-M4c run 2 实测 `violations:["apps/"]`）。
 */
describe("isPathUnderPrefixes (PL-M12)", () => {
  const backend = ["apps/server", "server", "backend", "src"];

  it.each([
    ["src/index.ts", true],
    ["src/a/b/c.ts", true],
    ["apps/server/routes/x.ts", true],
    ["backend/index.ts", true],
    ["server/index.ts", true],
    // 前缀是**按路径段**匹配的：`src` 不覆盖 `srcx/`。
    ["srcx/index.ts", false],
    ["apps/web/index.ts", false],
    ["test/a.test.ts", false],
    // 前缀列表里没有的根文件就是没有。
    ["package.json", false],
    ["index.js", false],
    ["", false]
  ])("isPathUnderPrefixes(%s, backend) => %s", (path, expected) => {
    expect(isPathUnderPrefixes(path, backend)).toBe(expected);
  });

  it("supports single-file entries, which is how read scope already names root files", () => {
    const devops = ["infrastructure", "compose.yaml", "Dockerfile"];
    expect(isPathUnderPrefixes("compose.yaml", devops)).toBe(true);
    expect(isPathUnderPrefixes("Dockerfile", devops)).toBe(true);
    expect(isPathUnderPrefixes("infrastructure/main.tf", devops)).toBe(true);
    // 单文件条目不是前缀：`compose.yaml.bak` 不在范围内。
    expect(isPathUnderPrefixes("compose.yaml.bak", devops)).toBe(false);
    expect(isPathUnderPrefixes("README.md", devops)).toBe(false);
  });

  it("treats '.' as 'everything' and [] as 'nothing'", () => {
    expect(isPathUnderPrefixes("anything/at/all.ts", ["."])).toBe(true);
    expect(isPathUnderPrefixes("anything/at/all.ts", [])).toBe(false);
  });

  it("normalises windows separators and leading slashes", () => {
    expect(isPathUnderPrefixes("/src/index.ts", backend)).toBe(true);
    expect(isPathUnderPrefixes("src\\index.ts", backend)).toBe(true);
  });
});
