# 259 · 反篡改只回读变更文件，内容读不到不再写成削弱

> 状态：**已落地**（2026-11-10 Asia/Shanghai）
> 动机：规划 v10 工作流 `ce6cb38e-…`（切片 `slice-kanban-feedback`）在 T01 骨架任务上被反篡改门连续判红，官方 lint / typecheck / build 全绿，官方测试因没有 AC 作用域跳过。两轮 FRONTEND 修复用尽后工作流失败。证据一直点名 `tests/reports/test-execution-report.md`（第一轮还带上 4 个已有 spec）。该报告里没有 `assert` 行，代理只是加了探针测试后按仓库自己的报告准确性门禁同步了计数。真正原因是内容快照要把整个 `tests/`（约 133 个文件、1.34MB）经沙箱 stdout 读回，而沙箱默认只保留最后 96KB，JSON 被截断后解析失败，判定按「无法证明是增量」把所有哈希有变的文件都当成削弱。

---

## 1. 约定

1. 哈希快照仍看全部受保护测试文件；**内容只回读哈希发生变化、且仍然存在的文件**。优先从宿主机工作区直接读，避开 96KB stdout 上限；宿主机读不到（例如单测假沙箱）再回退到只含变更路径的沙箱命令。
2. 内容读不到（快照截断、单文件超过 256 KiB、命令失败）记入 `unread`，反篡改判定为 `skipped`，**不再写成「削弱」**，也不因此把任务判失败。删除受保护测试文件、以及读到的内容里既有 `assert` 行消失，仍判改弱并失败。
3. `tests/reports/**` 这类交付报告，以及测试目录下不是 `*.test.*` / `*.spec.*` 的 `.md` / `.txt` / `.html`，不再进入受保护测试集。写权限仍走 `isTestFilePath`，TEST 任务还可以更新报告。

## 2. 接线

1. `isProtectedTestPath`：在 `isTestFilePath` 之上排除 `isTestDeliveryReportPath`
2. `classifyProtectedChanges`：区分 `weakened` 与 `unread`；`TaskVerifier` 只在 `weakened` 非空时 fail
3. `readProtectedContentsFromWorkspace` + `buildProtectedContentCommand(paths)`：内容快照按变更集读取

## 3. 非目标

- 不放宽「把既有断言改弱」的拦截
- 不把 `isTestFilePath` 改窄（那会影响到写测试的权限）
- 不提高沙箱全局 `maxOutputBytes` 来硬扛整树内容快照
- 不切 DeepSeek / 不改 `.env`
- 不改 taskflow-vue 产品源码或可访问名

后续：官方全量 test 加长超时、超时不得写成 VACUOUS_TEST，见 [docs/260](./260-official-full-suite-test-timeout-and-vacuous.md)。
