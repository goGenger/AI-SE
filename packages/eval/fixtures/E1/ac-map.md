# E1 · AC ↔ oracle 断言对照表

> 说明：oracle 与 AC 一一对应（断言 id = AC 编号）；`node selfcheck.mjs` 会脚本化校验
> **无未覆盖 AC、无孤立断言**，并校验 `fixture.json.requirementText` 与本 PRD 完全一致（唯一需求源）。
> 行序按 PRD 正文的 FR 分组（与 oracle 执行顺序一致），非编号排序。

| AC    | 优先级 | 验证方式              | oracle 断言      |
| ----- | ------ | --------------------- | ---------------- |
| AC-01 | Must   | HTTP 断言             | `check("AC-01")` |
| AC-02 | Must   | HTTP 断言             | `check("AC-02")` |
| AC-03 | Must   | HTTP 断言             | `check("AC-03")` |
| AC-05 | Must   | HTTP 断言             | `check("AC-05")` |
| AC-06 | Must   | 并发 HTTP 断言        | `check("AC-06")` |
| AC-07 | Must   | HTTP 断言             | `check("AC-07")` |
| AC-08 | Must   | HTTP 断言             | `check("AC-08")` |
| AC-09 | Must   | HTTP 断言             | `check("AC-09")` |
| AC-10 | Must   | HTTP 断言             | `check("AC-10")` |
| AC-11 | Must   | HTTP 断言             | `check("AC-11")` |
| AC-12 | Must   | HTTP 断言             | `check("AC-12")` |
| AC-13 | Must   | HTTP 断言             | `check("AC-13")` |
| AC-14 | Must   | HTTP 断言             | `check("AC-14")` |
| AC-15 | Must   | 边界断言              | `check("AC-15")` |
| AC-16 | Must   | 边界断言              | `check("AC-16")` |
| AC-17 | Must   | 边界断言              | `check("AC-17")` |
| AC-18 | Must   | 边界断言              | `check("AC-18")` |
| AC-23 | Must   | HTTP 断言             | `check("AC-23")` |
| AC-19 | Must   | HTTP 断言             | `check("AC-19")` |
| AC-20 | Must   | HTTP 断言             | `check("AC-20")` |
| AC-28 | Must   | HTTP 断言             | `check("AC-28")` |
| AC-27 | Must   | HTTP 断言             | `check("AC-27")` |
| AC-04 | Must   | 文件扫描              | `check("AC-04")` |
| AC-21 | Must   | HTML 断言             | `check("AC-21")` |
| AC-22 | Should | 浏览器（可选）        | `check("AC-22")` |
| AC-24 | Must   | 容器运行              | `check("AC-24")` |
| AC-25 | Must   | 容器运行              | `check("AC-25")` |
| AC-26 | Must   | 容器检查              | `check("AC-26")` |
| AC-29 | Must   | 日志扫描              | `check("AC-29")` |
| AC-30 | Must   | 命令执行 + 测试名解析 | `check("AC-30")` |

> 补充：AC-22 为 Should（不阻塞 oracle 通过，仍输出结果）；部署类断言在同一 oracle 内顺序执行
> （容器构建 → 运行/健康 → 注册与重启持久化 → 非 root → 日志脱敏），失败明细随 `E1_RESULTS_JSON` 逐条输出。
