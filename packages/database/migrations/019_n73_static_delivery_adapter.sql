-- N-73 (docs/232 §10): allow the `static` delivery adapter.
--
-- Workspace-first frontend projects (no git repository, no Dockerfile) still have a
-- measurable delivery chain (docs/233 §5.4): CI builds the workspace, staging DEPLOY starts
-- a static preview, staging VERIFY drives a browser against it. Before this migration the
-- adapter column only accepted 'docker', so those projects could not declare an environment
-- and planning had to drop every delivery task.
ALTER TABLE deployment_environments
  DROP CONSTRAINT IF EXISTS deployment_environments_adapter_check;

ALTER TABLE deployment_environments
  ADD CONSTRAINT deployment_environments_adapter_check
  CHECK (adapter::text = ANY (ARRAY['docker'::text, 'static'::text]));
