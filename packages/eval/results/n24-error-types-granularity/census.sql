-- 失败原因分布口径核对（2026-10-20，PL-M24 之后、`errorTypes` 双粒度相加的修复）
-- 用法：set -a; source .env; set +a; docker exec -i ai-se-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -
-- 只读查询，不改任何行。

-- ① 单批复算（l1-m4m run-2 的 4 个 workflow run）：任务级 vs run 级
WITH wf AS (
  SELECT unnest(ARRAY[
    '4860c374-b0bb-4fbf-9691-cdfe1ccb1974',
    '48cd16a5-5434-4950-b212-bb47a04ae1f4',
    'f45b6eb9-bc2f-434a-b4d8-cca9666ef044',
    '716eb98d-c824-421e-9f06-93a2a71d9cd6'
  ])::uuid AS id
)
SELECT 'task-level' AS gran, NULLIF(t.output->>'errorType','') AS code, count(*) AS n
FROM tasks t JOIN wf ON wf.id = t.workflow_run_id
WHERE NULLIF(t.output->>'errorType','') IS NOT NULL
GROUP BY 2
UNION ALL
SELECT 'run-level', NULLIF(r.output->>'errorType',''), count(*)
FROM agent_runs r JOIN tasks t ON t.id = r.task_id JOIN wf ON wf.id = t.workflow_run_id
WHERE NULLIF(r.output->>'errorType','') IS NOT NULL
GROUP BY 2
ORDER BY 1 DESC, 3 DESC;

-- ② 全库任务级：errorType × 任务状态（观察 READY / CANCELLED 也带 errorType）
SELECT t.status AS task_status, NULLIF(t.output->>'errorType','') AS task_errorType, count(*) AS n
FROM tasks t
WHERE NULLIF(t.output->>'errorType','') IS NOT NULL
GROUP BY 1, 2 ORDER BY 3 DESC;

-- ③ 全库 run 级：run 的 errorType 落在什么任务状态上
--    （大量落在 SUCCESS 任务上 ⇒ 证明 run 级计的是「尝试」而非「任务结果」）
SELECT t.status AS task_status, r.status AS run_status,
       NULLIF(r.output->>'errorType','') AS run_errorType, count(*) AS n
FROM agent_runs r JOIN tasks t ON t.id = r.task_id
WHERE NULLIF(r.output->>'errorType','') IS NOT NULL
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
