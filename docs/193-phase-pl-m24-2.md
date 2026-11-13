# 193 · PL-M24 (2) 可行性判定（结论：**不可安全实现**，不实施）

> 立项：2026-10-20。用户指令「做 (2)」——把「作用域命令只有挂死、没有真实失败」判为**通过**。
> 基线：`docs/192`（PL-M24 (1) 已完成）、`docs/188` 的 2026-10-20 追加块、真实 E1 工作区实测。
> 状态：**判据未落地。本文件记录「为什么不做」，连同可复现的实测证据。**
> **〔2026-10-20 裁定〕用户答「按你的推荐，不落地 (2)」⇒ 本项关闭，不做。**

---

## 1. 任务与它要区分的两件事

(2) 的目标：让 `# fail 0 / # cancelled N` 的作用域检查**判通过**，从而解冻 L1-8。
它成立的前提是能把下面两件事**机械地分开**：

| | 情形 | 应当 |
| --- | --- | --- |
| **A** | 文件里**零个**测试匹配该 pattern，其文件级钩子挂死 | **通过**（作用域内没有任何该文件的事） |
| **B** | **匹配到的**测试自己挂死 | **失败**（红灯门不许放松） |

### 1.1 实测：Node 对两者给出**同形**证据

同一台机器、同一 Node（v22.22.2）、同一条作用域命令，只换文件：

| | **A** 真实文件、零匹配 | **B** 合成夹具、匹配的测试挂死 |
| --- | --- | --- |
| 命令 | `node --test --test-name-pattern '\[AC-99\]' --test-timeout=5000 src/tests/login-contract.test.mjs` | `node --test --test-name-pattern '\[AC-01\]' --test-timeout=5000` |
| TAP 条目 | `not ok 1 - src/tests/login-contract.test.mjs` | `not ok 1 - hang.test.mjs` |
| `duration_ms` | 5003.7 | 5008.3 |
| `failureType` | `testTimeoutFailure` | `testTimeoutFailure` |
| 计划行 | `1..1` | `1..1` |
| 摘要 | `tests 1 / pass 0 / **fail 0** / cancelled 1` | `tests 1 / pass 0 / **fail 0** / cancelled 1` |
| 带 AC 标记的条目 | **无** | **无** ← 关键 |

产物：`packages/eval/results/n13-hang-only/{real-zero-match,synthetic-test-hang}.txt`。

**B 里那个测试的名字就叫 `[AC-01] a matching test that never returns`，但 Node 根本没有把它报出来**——
报出来的是**文件**。⇒ 「`not ok` 条目不带 AC 标记 ⇒ 这是文件级挂死」**这个前提是假的**。

### 1.2 对照（不构成反例）

同一真实文件换个**有匹配**的 pattern：`tests 1 / **pass 1** / fail 0 / cancelled 0`，199 ms 正常退出
（`real-matching.txt`）。⇒ 挂死确实由「零匹配 + 文件级钩子」触发，这一点 PL-M20 的根因仍然成立。
**但根因成立不等于后果可分。**

---

## 2. 设计过的判据，以及它为什么不安全

```text
hangOnly =  fail === 0
         ∧ cancelled > 0
         ∧ pass > 0
         ∧ 解析到的 AC 全部为 passed 且至少一条
         ∧ 存在「不带 AC 标记的 not ok 条目」
```

- 在 **A** 下成立 —— 这是想要的。
- 在 **B** 下**同样成立**：B 的 `not ok` 条目也不带 AC 标记。
  ⇒ 只要同一任务里还有**另一个通过的作用域测试**（`pass > 0` ∧ 至少一条 AC passed），
  **B 就会被判通过**——**正是 `--test-force-exit` 在 `docs/187` §4 判据 20d 被否掉的那扇门。**

### 2.1 四个候选区分信号，逐一实测被否

| 候选 | 结论 |
| --- | --- |
| `failureType` | A 与 B 都是 `testTimeoutFailure`，无区分力 |
| `duration_ms` | A 与 B 都 ≈ `--test-timeout`，无区分力 |
| 计划行 `1..N` | 它是**根计划**、不是每文件计划；A 与 B 都是 `1..1` |
| 按文件内容 grep 预筛 | 已被数据否决：`login-contract.test.mjs` 对 `AC-01` 的 grep 命中 **7 次**（全在注释与 `[AC-10]` 一类串里）而**匹配的测试名 0 个** |

**⇒ 在 Node 现有 TAP 面上，没有可机械验证的判据。**

---

## 3. Modified Files

| 文件 | 动作 |
| --- | --- |
| `packages/eval/results/n13-hang-only/report.json` | **新增**（可行性判定与全部读数） |
| `packages/eval/results/n13-hang-only/real-zero-match.txt` | **新增**（A 的原始 TAP） |
| `packages/eval/results/n13-hang-only/real-matching.txt` | **新增**（对照的原始 TAP） |
| `packages/eval/results/n13-hang-only/synthetic-test-hang.txt` | **新增**（B 的原始 TAP） |
| `docs/193-phase-pl-m24-2.md` | **新增**（本文件） |
| `docs/146` / `docs/127` / `docs/17` | 改：台账 |

**零 `src/` 改动、零测试改动、零依赖改动。** 按文件清单核对：`apps/` 与 `packages/*/src/` 下无源文件变更。

---

## 4. Implementation

**无。** 这是一次**否决**，不是一次实施。设计出的判据在 §2 被实测推翻，故**不写入代码**。

---

## 5. Architecture Changes

**无。**

---

## 6. Dependencies

**无新增、无升级、无删除。**

---

## 7. Tests / Lint / Typecheck / E2E

**均未运行**——本批**零代码改动**，没有需要门禁的对象。按 `AGENTS.md` §7 的口径如实标注：**不适用**。

可复现的实测命令（三条，均离线、零配额）：

```bash
# A：真实工作区文件的零匹配挂死
cd ~/Desktop/study/ai-se-eval/E1/run-1
node --test --test-name-pattern '\[AC-99\]' --test-timeout=5000 src/tests/login-contract.test.mjs

# 对照：同一文件有匹配时正常跑完
node --test --test-name-pattern '\[AC-10\]' --test-timeout=5000 src/tests/login-contract.test.mjs

# B：一个匹配的测试自己挂死（setInterval 保持事件循环 + 永不 resolve 的 promise）
mkdir -p /tmp/hang && cd /tmp/hang
printf '{"type":"module","scripts":{"test":"node --test"}}\n' > package.json
cat > hang.test.mjs <<'EOF'
import test from "node:test";
test("[AC-01] a matching test that never returns", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
EOF
node --test --test-name-pattern '\[AC-01\]' --test-timeout=5000
```

---

## 8. Known Issues

1. **L1-8 仍然被这一族卡住。** (1) 只保证失败**有界、可归因**（81.7 s 退出、TAP 保住），
   不改变**失败本身**。真实批次里，只要 agent 写出「文件级 `before` 里 spawn 子进程」的测试文件，
   作用域检查仍会判失败。
2. **不能靠「`fail 0` 就放行」。** 见 §1.1 / §2——那会同时放行「匹配的测试真的挂死」。
3. **剩余的安全出路只在工作区侧**：让 agent 写的测试不要在文件级 `before` 里无界地 spawn 子进程
   （或给钩子加自己的超时）。这是**行为塑造**，与 `TEST_FILE_CONSTRAINT` / `WRITE_DENIAL_CONSTRAINT`
   同一类，**没有任何测试能断言 agent 遵守它**（`docs/191` Known Issue 3 同类）。
4. **本判定依赖 Node 的 TAP 形状**（v22.22.2）。若上游改掉「文件级 `not ok`」的报法，
   判别空间可能出现——届时须重新实测，**不能沿用本文件的结论**。

---

## 9. Acceptance Result

**NOT APPLICABLE（判据未定义，任务被否决）。**

用户指令是「做 (2)」。**本批的交付物是「(2) 不可安全实现的判定与证据」，不是实现。**
按记忆 [[verdict-rules-need-a-census]] 的同一条纪律：**判断一条规则能不能当扳机之前，先看它能不能
把靶子与好人分开**——这里分开不了。

**这不是「没做完」，是「做实了不做」。** 若用户仍要求落地，须同时接受 §2 的那扇门（匹配的测试挂死
也会被判通过），那与 `docs/187` §4 判据 20d「红灯门不放松」直接冲突——**应视为 CONTRACT CONFLICT，
须显式裁定，而不是默认对齐**。

**〔2026-10-20 裁定〕用户答「按你的推荐，不落地 (2)」⇒ 本项关闭，不做。**
**本项以「经裁定不做」收尾，不是以 PASS/PARTIAL 收尾**——没有判据被达成，也没有判据被违反。

---

## 10. Next Phase Boundary

**未开始事项（STOP）**：

- **(2) 未实施，且已由用户 2026-10-20 裁定「不落地」——本项关闭。** 理由是 §1–§2 的实测。
- **N-15′**（DEBUG 无类型级检查）、**agent 600s 墙上超时**、**replan 不收敛**、
  **`errorTypes` 双粒度相加** —— **四项未修**。
- **N-18 / N-19 / PL-M24 (1)** 均**未在真实批次验证**。
- **探针未入库**（PL-M24 的临时测量脚本仍在 `/tmp`；本文件已给出三条可复现命令）。
- **未跑任何批次**；下一批开工前仍须先停并重启 `:47558`，并先跑 `deniedPaths` 普查。
