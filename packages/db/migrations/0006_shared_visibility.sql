-- Add shared column to projects
ALTER TABLE projects ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
CREATE INDEX projects_shared_idx ON projects(shared);

-- Add shared column to tasks
ALTER TABLE tasks ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
CREATE INDEX tasks_shared_idx ON tasks(shared);

-- Add shared column to facts
ALTER TABLE facts ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
CREATE INDEX facts_shared_idx ON facts(shared);

-- Add shared column to documents
ALTER TABLE documents ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
CREATE INDEX documents_shared_idx ON documents(shared);

-- Add shared column to thoughts
ALTER TABLE thoughts ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
CREATE INDEX thoughts_shared_idx ON thoughts(shared);

-- Add shared column to time_series_points
ALTER TABLE time_series_points ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
CREATE INDEX time_series_shared_idx ON time_series_points(shared);
