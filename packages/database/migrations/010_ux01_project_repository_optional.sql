-- UX-01: Git repository is optional — a project can start workspace-first and
-- bind a repository later via PUT /api/projects/:id/repository.
ALTER TABLE projects ALTER COLUMN repository_id DROP NOT NULL;
