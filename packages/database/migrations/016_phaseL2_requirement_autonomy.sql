-- Phase L2 (自治 L2): 需求级自治级别——关口 1（切片计划人工确认）纳入自治契约。
-- 关口 1 发生在任何工作流之前，工作流级 policy 此时尚不存在，故级别落在需求上。
-- 缺省 NULL = 现状：关口 1 一律等人工确认（零行为变化）。
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS autonomy_level VARCHAR(16);
