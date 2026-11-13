# F1 · 纯前端夹具（浏览器验收）

`docs/233` 的落地形态。**只有前端**：被测产物是一个 Vue 3 + Vite + TS 的 TaskBoard 页面，
后端由夹具自带的 mock 进程提供，验收由隐藏的浏览器 oracle 判定。

## 目录

```
F1/
  fixture.json      # 夹具定义（requirementText = prd.md 原文）
  prd.md            # 需求输入（就是提交给平台的那份文本）
  ac-map.md         # AC → 判定方 → testid → 变体反向表
  oracle.mjs        # 黑盒浏览器 oracle（20 Must + 4 Should）
  template/         # 起点工作区：空骨架（无任何业务 UI）
  reference/        # 参考实现（只用于 oracle 自检与 flake 测量）
  mutants/
    empty-shell/    # 与 reference 相同但只渲染空容器 —— 反向门必须命中
    no-console-clean/  # 与 reference 相同但控制台报错 —— AC-20 必须命中
```

**隔离约定（与 E1 同）**：`reference/`、`mutants/`、`oracle.mjs` **不进被测工作区、不进提示词**。

## 四个工作区的关系

`template` / `reference` / 两个 mutant 是**同一个工程**的四份快照：`package.json` 的依赖、
`pnpm-lock.yaml`、`mock-server.mjs` 必须逐字相同（`packages/eval/src/__tests__/f1Fixture.test.ts`
断言这件事），差异只在 `src/App.vue`。锁文件相同意味着 oracle 里那句
`pnpm install --frozen-lockfile` 对四份都成立。

## 怎么自己验一遍（不跑平台、不花配额）

```bash
cd packages/eval/fixtures/F1
node oracle.mjs reference                 # 期望 24/24（Must 20/20）
node oracle.mjs template                  # 期望 >=15 条 Must 失败（夹具能分辨「做没做」）
node oracle.mjs mutants/empty-shell       # 期望 23 条失败（只有 AC-20 通过）
node oracle.mjs mutants/no-console-clean  # 期望只有 AC-20 失败
```

oracle 会把工作区**复制到临时目录**再安装/构建，原目录不受影响；需要本机有 chromium
（`npx playwright install chromium`）与 `@ai-se/eval` 的 playwright devDependency。

## 平台的批次

`packages/eval/scripts/f1-frontend-x3.sh`。它现在**会拒绝启动**（exit 7 / 8），因为两个前提
还没满足：平台还不能选中 `frontend-vue` profile（`docs/235` §10），沙箱镜像也还没有浏览器
（`docs/234`）。这不是脚本坏了，是它不肯在有前提没满足时产出一个会被误读的读数。
