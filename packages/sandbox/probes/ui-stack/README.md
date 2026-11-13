# ui-stack 探针工程（`docs/234`）

**这不是 workspace 包。** `pnpm-workspace.yaml` 的 glob 是 `packages/*`（一层），本目录不会被匹配；
也**不要**在仓库根直接对它执行 `pnpm install`——它的依赖只允许在容器内按 lockfile 安装。

用途：验证「断网沙箱里能否安装 / 构建 / 预览 / 断言 React + TS + Tailwind」。三步：

1. 生成 lockfile（必须在 pnpm 9.15.0 容器内，与沙箱镜像一致）：

```sh
docker run --rm -v "$PWD/packages/sandbox/probes/ui-stack:/seed" -w /seed node:22-bookworm \
  sh -c 'npm install --global pnpm@9.15.0 && pnpm install --lockfile-only'
```

2. 构建探针镜像（`docs/234` §4，尚未实现）；
3. 在沙箱内跑探针命令（`docs/234` §5，尚未实现）。

断言靶子在 `src/App.tsx`：`text-[#123456]` → `rgb(18, 52, 86)`，`p-4` → `padding: 16px`。
