-- MySQL/MariaDB copy of migrations/0002_builtin_roles.sql (identical SQL).
-- so they can never drift; the rows exist so users.role_id can reference them.
INSERT INTO roles (id, name, description, builtin, permissions, created_at, updated_at) VALUES
  ('owner',     'Owner',               'Full control, incl. ownership transfer and audit retention. At least one always exists.', 1, '[]', 0, 0),
  ('admin',     'Admin',               'Everything except owner-only actions.', 1, '[]', 0, 0),
  ('editor',    'Editor',              'Games copy, newsroom, team, pages and media.', 1, '[]', 0, 0),
  ('analyst',   'Marketing / Analyst', 'Read analytics and content; export reports.', 1, '[]', 0, 0),
  ('developer', 'Developer',           'Games, builds, media, API keys, webhooks and cache.', 1, '[]', 0, 0),
  ('viewer',    'Viewer',              'Read-only access to content and analytics.', 1, '[]', 0, 0);
