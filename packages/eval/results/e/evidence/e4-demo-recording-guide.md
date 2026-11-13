# E-4 演示包 · 录屏操作指引（录屏由用户执行；不承诺视频文件）

> 组件：① 可复现演示脚本 `packages/eval/scripts/e4-demo.sh`；② 实跑抓证 `e4-demo-capture.txt`；
> ③ 控制台截图 4 张（`demo/console-*.png`）；④ 本指引。

## 前置（各 1 条命令）

```bash
# 平台受控实例（应已在跑；health 200）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47557/health

# （可选）拉起控制台并指向受控实例；页面必须用 http://localhost:5173 打开（CORS 白名单为 localhost）
VITE_API_BASE_URL=http://127.0.0.1:47557 corepack pnpm --filter @ai-se/web dev
```

## 录制脚本建议（约 3–5 分钟）

1. **终端 · 能力巡礼**（≈90s）
   `bash packages/eval/scripts/e4-demo.sh`
   看点：健康检查 → 项目数据 → **T-13 翻转证据**（`expected=pass`）→ 追溯表 → 交付链环境/部署 → 审计记录。
2. **控制台 · 仪表盘**（≈20s）：`http://localhost:5173/` — 10 个项目概览。
3. **控制台 · 需求抽屉 + 追溯表**（≈40s）：需求页 → S1「详情」→ 滚动到「追溯表（FR → AC → 测试 → 结果 → 证据）」卡片
   （如实说明：当前映射覆盖受 acKeys 缺口限制，为已登记发现）。
4. **控制台 · 工作流详情**（≈40s）：工作流页 → 选中 `ba500ded`（E1 slice-1，14/14 成功）→ 详情；
   口播：该切片含 **E-0(a) 红灯翻转实况生效**（T-13）与 12 个 SUCCESS 任务。
5. **收束**（≈20s）：回到终端展示 `results/e/evidence/` 与 `results/d/evidence/` 证据索引。

## 边界（如实）

- 外部环境（GitHub / GHCR / VLM / Figma / 真实生产）为 **BLOCKED BY EXTERNAL CONFIG**，演示只覆盖本机真实回路。
- 控制台截图已预存 `demo/console-1..4*.png`；录屏时可按上述顺序重走一遍。
- 若控制台未起：仅录终端部分即可（脚本输出自足）。
