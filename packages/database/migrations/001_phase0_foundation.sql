CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url VARCHAR(500) NOT NULL UNIQUE,
  provider VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS repositories_set_updated_at ON repositories;
CREATE TRIGGER repositories_set_updated_at
BEFORE UPDATE ON repositories
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  repository_id UUID NOT NULL REFERENCES repositories(id),
  status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_repository_id_idx ON projects(repository_id);
CREATE INDEX IF NOT EXISTS projects_status_idx ON projects(status);

DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  action VARCHAR(120) NOT NULL,
  entity_type VARCHAR(120) NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at);
