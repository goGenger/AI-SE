-- Phase F (F1-2): 单一生效计划版本——旧版本计划行标记 SUPERSEDED（superseded_at 非空），
-- 读取面（仓储层）默认过滤；需要旧版本的场景显式声明（includeSuperseded）。
-- 背景：重规划产生新版本后旧版计划行与新版并存（E1 现役 74 行 = 现役 v7 的 14 + 旧代尘留 60）。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- 活跃计划行索引（读取面默认路径：仅现役版本）。
CREATE INDEX IF NOT EXISTS tasks_active_plan_idx
  ON tasks (requirement_id, slice_key, version)
  WHERE workflow_run_id IS NULL AND superseded_at IS NULL;

-- 回填 1：切片键不属于任何现役切片的历史行（旧代尘留，如 E1 的 s1-auth-persistence 等旧切片）。
UPDATE tasks t SET superseded_at = now()
WHERE t.workflow_run_id IS NULL AND t.superseded_at IS NULL AND t.slice_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM requirement_slices rs
    WHERE rs.requirement_id = t.requirement_id AND rs.slice_key = t.slice_key
  );

-- 回填 2：与切片行 planning_version 不一致的旧版本（同切片已被重规划取代）。
UPDATE tasks t SET superseded_at = now()
FROM requirement_slices rs
WHERE t.workflow_run_id IS NULL AND t.superseded_at IS NULL
  AND t.requirement_id = rs.requirement_id AND t.slice_key = rs.slice_key
  AND rs.planning_version IS NOT NULL AND t.version < rs.planning_version;

-- 回填 3：同一（需求, 切片键）分组内存在更高版本的旧版本行（含单级/无切片键分组）。
UPDATE tasks t SET superseded_at = now()
WHERE t.workflow_run_id IS NULL AND t.superseded_at IS NULL
  AND EXISTS (
    SELECT 1 FROM tasks newer
    WHERE newer.requirement_id = t.requirement_id
      AND newer.workflow_run_id IS NULL
      AND COALESCE(newer.slice_key, '') = COALESCE(t.slice_key, '')
      AND newer.version > t.version
  );
