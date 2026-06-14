PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dependency_edges` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `source` text NOT NULL, `dependent_kind` text NOT NULL, `dependent_id` text NOT NULL, `dependency_kind` text NOT NULL, `dependency_id` text NOT NULL, `relationship` text NOT NULL, `metadata` text DEFAULT '{}' NOT NULL, `stale_at` integer, `stale_reason` text, `last_verified_at` integer, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action, CONSTRAINT `dependency_edges_dependent_kind_check` CHECK(`dependent_kind` in ('project','person','task','fact','time_series_point','document','document_chunk','thought')), CONSTRAINT `dependency_edges_dependency_kind_check` CHECK(`dependency_kind` in ('project','person','task','fact','time_series_point','document','document_chunk','thought')), CONSTRAINT `dependency_edges_relationship_check` CHECK(`relationship` in ('references','derived_from','summarizes','supersedes','observes_subject','mentions','related_to')), CONSTRAINT `dependency_edges_unique` UNIQUE(`owner_id`,`dependent_kind`,`dependent_id`,`dependency_kind`,`dependency_id`,`relationship`));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dependency_edges_dependent_idx` ON `dependency_edges` (`owner_id`,`dependent_kind`,`dependent_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dependency_edges_dependency_idx` ON `dependency_edges` (`owner_id`,`dependency_kind`,`dependency_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dependency_edges_relationship_idx` ON `dependency_edges` (`owner_id`,`relationship`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dependency_edges_stale_idx` ON `dependency_edges` (`owner_id`,`stale_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', t.owner_id, t.source, 'thought', tp.thought_id, 'person', tp.person_id, 'references', '{}', unixepoch(), unixepoch()
FROM thought_people tp JOIN thoughts t ON t.id = tp.thought_id JOIN people p ON p.id = tp.person_id;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', t.owner_id, t.source, 'thought', tt.thought_id, 'task', tt.task_id, 'references', '{}', unixepoch(), unixepoch()
FROM thought_tasks tt JOIN thoughts t ON t.id = tt.thought_id JOIN tasks k ON k.id = tt.task_id AND k.owner_id = t.owner_id;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', t.owner_id, t.source, 'thought', tf.thought_id, 'fact', tf.fact_id, 'references', '{}', unixepoch(), unixepoch()
FROM thought_facts tf JOIN thoughts t ON t.id = tf.thought_id JOIN facts f ON f.id = tf.fact_id AND f.owner_id = t.owner_id;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', t.owner_id, t.source, 'thought', td.thought_id, 'document', td.document_id, 'references', '{}', unixepoch(), unixepoch()
FROM thought_documents td JOIN thoughts t ON t.id = td.thought_id JOIN documents d ON d.id = td.document_id AND d.owner_id = t.owner_id;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', f.owner_id, f.source, 'fact', fst.fact_id, 'thought', fst.thought_id, 'derived_from', '{}', unixepoch(), unixepoch()
FROM fact_source_thoughts fst JOIN facts f ON f.id = fst.fact_id JOIN thoughts t ON t.id = fst.thought_id AND t.owner_id = f.owner_id;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', f.owner_id, f.source, 'fact', fsf.fact_id, 'fact', fsf.source_fact_id, 'derived_from', '{}', unixepoch(), unixepoch()
FROM fact_source_facts fsf JOIN facts f ON f.id = fsf.fact_id JOIN facts sf ON sf.id = fsf.source_fact_id AND sf.owner_id = f.owner_id;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', f.owner_id, f.source, 'fact', fsd.fact_id, 'document', fsd.document_id, 'derived_from', '{}', unixepoch(), unixepoch()
FROM fact_source_documents fsd JOIN facts f ON f.id = fsd.fact_id JOIN documents d ON d.id = fsd.document_id AND d.owner_id = f.owner_id;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', f.owner_id, f.source, 'fact', fsc.fact_id, 'document_chunk', fsc.document_chunk_id, 'derived_from', '{}', unixepoch(), unixepoch()
FROM fact_source_document_chunks fsc JOIN facts f ON f.id = fsc.fact_id JOIN document_chunks c ON c.id = fsc.document_chunk_id JOIN documents d ON d.id = c.document_id AND d.owner_id = f.owner_id;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', nf.owner_id, nf.source, 'fact', nf.id, 'fact', nf.supersedes_fact_id, 'supersedes', '{}', unixepoch(), unixepoch()
FROM facts nf JOIN facts of ON of.id = nf.supersedes_fact_id AND of.owner_id = nf.owner_id WHERE nf.supersedes_fact_id IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', newer.owner_id, newer.source, 'fact', newer.id, 'fact', older.id, 'supersedes', '{}', unixepoch(), unixepoch()
FROM facts older JOIN facts newer ON newer.id = older.superseded_by_fact_id AND newer.owner_id = older.owner_id WHERE older.superseded_by_fact_id IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO dependency_edges (id, owner_id, source, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship, metadata, created_at, updated_at)
SELECT 'bf' || substr(lower(hex(randomblob(10))), 1, 20) || 'e', s.owner_id, s.source, 'time_series_point', s.id, s.subject_type, s.subject_id, 'observes_subject', '{}', unixepoch(), unixepoch()
FROM time_series_points s
WHERE s.subject_type IS NOT NULL AND s.subject_id IS NOT NULL AND (
  (s.subject_type = 'project' AND EXISTS (SELECT 1 FROM projects p WHERE p.id = s.subject_id AND p.owner_id = s.owner_id)) OR
  (s.subject_type = 'person' AND EXISTS (SELECT 1 FROM people p WHERE p.id = s.subject_id)) OR
  (s.subject_type = 'task' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = s.subject_id AND t.owner_id = s.owner_id)) OR
  (s.subject_type = 'fact' AND EXISTS (SELECT 1 FROM facts f WHERE f.id = s.subject_id AND f.owner_id = s.owner_id)) OR
  (s.subject_type = 'document' AND EXISTS (SELECT 1 FROM documents d WHERE d.id = s.subject_id AND d.owner_id = s.owner_id)) OR
  (s.subject_type = 'thought' AND EXISTS (SELECT 1 FROM thoughts th WHERE th.id = s.subject_id AND th.owner_id = s.owner_id))
);
--> statement-breakpoint
CREATE TABLE `facts_new` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `project_id` text, `source` text NOT NULL, `statement` text NOT NULL, `citations` text DEFAULT '[]' NOT NULL, `confidence` real DEFAULT 0.5 NOT NULL, `status` text DEFAULT 'current' NOT NULL, `metadata` text DEFAULT '{}' NOT NULL, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action, CONSTRAINT `facts_confidence_check` CHECK(`confidence` >= 0.0 and `confidence` <= 1.0), CONSTRAINT `facts_status_check` CHECK(`status` in ('current','superseded','proven_wrong')));
--> statement-breakpoint
INSERT INTO `facts_new` (id, owner_id, project_id, source, statement, citations, confidence, status, metadata, created_at, updated_at) SELECT id, owner_id, project_id, source, statement, citations, confidence, status, metadata, created_at, updated_at FROM `facts`;
--> statement-breakpoint
DROP TABLE `facts`;
--> statement-breakpoint
ALTER TABLE `facts_new` RENAME TO `facts`;
--> statement-breakpoint
CREATE INDEX `facts_owner_project_idx` ON `facts` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE INDEX `facts_owner_status_idx` ON `facts` (`owner_id`,`status`);
--> statement-breakpoint
CREATE TABLE `time_series_points_new` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `project_id` text, `source` text NOT NULL, `series_key` text NOT NULL, `value` real, `unit` text, `observed_at` integer NOT NULL, `metadata` text DEFAULT '{}' NOT NULL, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action);
--> statement-breakpoint
INSERT INTO `time_series_points_new` (id, owner_id, project_id, source, series_key, value, unit, observed_at, metadata, created_at, updated_at) SELECT id, owner_id, project_id, source, series_key, value, unit, observed_at, metadata, created_at, updated_at FROM `time_series_points`;
--> statement-breakpoint
DROP TABLE `time_series_points`;
--> statement-breakpoint
ALTER TABLE `time_series_points_new` RENAME TO `time_series_points`;
--> statement-breakpoint
CREATE INDEX `time_series_owner_series_observed_idx` ON `time_series_points` (`owner_id`,`series_key`,`observed_at`);
--> statement-breakpoint
CREATE INDEX `time_series_owner_project_observed_idx` ON `time_series_points` (`owner_id`,`project_id`,`observed_at`);
--> statement-breakpoint
DROP TABLE IF EXISTS `thought_people`;
--> statement-breakpoint
DROP TABLE IF EXISTS `thought_tasks`;
--> statement-breakpoint
DROP TABLE IF EXISTS `thought_facts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `thought_documents`;
--> statement-breakpoint
DROP TABLE IF EXISTS `fact_source_thoughts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `fact_source_facts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `fact_source_documents`;
--> statement-breakpoint
DROP TABLE IF EXISTS `fact_source_document_chunks`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
