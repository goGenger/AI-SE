# F1-8（FX-28）PRD 与 oracle 优先级口径核对记录（归档）

> 生成：2026-10-08 ｜ 结论：**四载体一致 = 29 Must + 1 Should，唯一 Should = AC-22**（与仓库现行文本为准）。
> 本文件为 FX-28 的归档核对记录；历史评测结果统一以「口径版本 29/1」标注（见 `f18-recompute.md` 表头）。

## 核对范围与方法（四项均可复跑）

| # | 载体 | 核对命令（在 `packages/eval/fixtures/E1/` 下） | 结果 |
| --- | --- | --- | --- |
| 1 | PRD 正文（`prd.md`） | `grep -c '\| Must' prd.md` / `grep -c '\| Should' prd.md` | Must 行 **29**；Should 行 **1** |
| 2 | AC↔oracle 对照表（`ac-map.md`） | `grep -c '^\| AC-' ac-map.md` / `grep -c '\| Should \|' ac-map.md` | AC 行 **30**；Should 行 **1** |
| 3 | oracle（`oracle.mjs` + `selfcheck.mjs`） | `node selfcheck.mjs` | `reference: exit=0 must=29/29`；变异检出 6/6 → oracle 的 Must 全集 = **29**；断言引用 AC-01..AC-30 |
| 4 | N3 库记录（`requirement_acceptance_criteria`，E1 需求 `a30f30cc-…`） | `docker exec ai-se-postgres-1 psql -U aise -d aise -tAc "SELECT priority, count(*) … GROUP BY priority;"` | **Must 29 / Should 1**；`lower(priority)='should'` 唯一行 = **AC-22** |

## 结论与口径

1. **29 Must + 1 Should**，唯一 Should = **AC-22**（无头浏览器渲染检查，可选增强）——四载体逐一对齐，无分歧。
2. AC-30 的 Must 行文本中出现「Should（AC-22）」字样（引用性提及），按**行级优先级列**判定，不计为第二条 Should（核对方法已写明，避免误读为 29+2）。
3. **历史结果口径标注**：B / C-6 / E-1 / E-2 / E-2b 全部批次均在该口径下评测（oracle Must 29 项为「真成功」判定基准）；离线重算表（`f18-recompute.md`）表头统一标注「口径版本：29 Must + 1 Should（唯一 Should = AC-22）」。
4. 若另有仓库外 PRD 文本，按实际文本另行复议（本记录以仓库现行文本为准）。
