-- N-38: 工作流策略的 autonomyLevel 从不持久化，导致 L1-4「L1 工作流一律 enforce」从未生效。
-- mapWorkflow 从列重建 policy（workflowRepositories.ts），INSERT 也只写定长列；policy 里
-- autonomyLevel 既没有列也没有 JSON 字段，于是任何从库里读回的工作流 policy 都缺这一项，
-- verifyingTaskExecutor.modeFor 永远退回全局 VERIFICATION_GATE。
-- 缺省 NULL = 现状：未声明自治的工作流行为不变。
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS autonomy_level VARCHAR(16);
