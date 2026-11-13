-- Phase G (G2): 切片级「数据层变更」声明——involves_data=false 的切片在二级规划中跳过
-- database_spec 阶段（机制与 involves_ui → ui_spec 跳过同构；规划成本精简实验）。
-- 缺省 NULL = 视同涉及数据（不跳过；零行为变化）。
ALTER TABLE requirement_slices ADD COLUMN IF NOT EXISTS involves_data BOOLEAN;
