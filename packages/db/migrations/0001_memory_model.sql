PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `source` text NOT NULL, `name` text NOT NULL, `description` text, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action);
--> statement-breakpoint
CREATE INDEX `projects_owner_name_idx` ON `projects` (`owner_id`,`name`);
--> statement-breakpoint
CREATE TABLE `people` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `source` text NOT NULL, `name` text NOT NULL, `aliases` text DEFAULT '[]' NOT NULL, `contact_info` text DEFAULT '{}' NOT NULL, `notes` text, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action);
--> statement-breakpoint
CREATE INDEX `people_owner_name_idx` ON `people` (`owner_id`,`name`);
--> statement-breakpoint
CREATE TABLE `tasks` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `project_id` text, `source` text NOT NULL, `title` text NOT NULL, `description` text, `status` text DEFAULT 'open' NOT NULL, `priority` real DEFAULT 0.5 NOT NULL, `due_at` integer, `recurrence` text, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action, CONSTRAINT `tasks_status_check` CHECK(`status` in ('open','in_progress','done','cancelled')), CONSTRAINT `tasks_priority_check` CHECK(`priority` >= 0.0 and `priority` <= 1.0));
--> statement-breakpoint
CREATE INDEX `tasks_owner_status_idx` ON `tasks` (`owner_id`,`status`);
--> statement-breakpoint
CREATE INDEX `tasks_owner_project_idx` ON `tasks` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE INDEX `tasks_owner_priority_idx` ON `tasks` (`owner_id`,`priority`);
--> statement-breakpoint
CREATE TABLE `facts` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `project_id` text, `source` text NOT NULL, `statement` text NOT NULL, `citations` text DEFAULT '[]' NOT NULL, `confidence` real DEFAULT 0.5 NOT NULL, `status` text DEFAULT 'current' NOT NULL, `supersedes_fact_id` text, `superseded_by_fact_id` text, `metadata` text DEFAULT '{}' NOT NULL, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`supersedes_fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE set null, FOREIGN KEY (`superseded_by_fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE set null, CONSTRAINT `facts_confidence_check` CHECK(`confidence` >= 0.0 and `confidence` <= 1.0), CONSTRAINT `facts_status_check` CHECK(`status` in ('current','superseded','proven_wrong')));
--> statement-breakpoint
CREATE INDEX `facts_owner_project_idx` ON `facts` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE INDEX `facts_owner_status_idx` ON `facts` (`owner_id`,`status`);
--> statement-breakpoint
CREATE INDEX `facts_supersedes_idx` ON `facts` (`supersedes_fact_id`);
--> statement-breakpoint
CREATE INDEX `facts_superseded_by_idx` ON `facts` (`superseded_by_fact_id`);
--> statement-breakpoint
CREATE TABLE `documents` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `project_id` text, `source` text NOT NULL, `title` text NOT NULL, `r2_key` text NOT NULL, `mime_type` text DEFAULT 'text/markdown' NOT NULL, `size_bytes` integer, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action);
--> statement-breakpoint
CREATE INDEX `documents_owner_project_idx` ON `documents` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE TABLE `document_chunks` (`id` text PRIMARY KEY NOT NULL, `document_id` text NOT NULL, `chunk_index` integer NOT NULL, `content` text NOT NULL, `created_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade, CONSTRAINT `document_chunks_document_index_unique` UNIQUE(`document_id`,`chunk_index`));
--> statement-breakpoint
CREATE TABLE `thoughts` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `project_id` text, `source` text NOT NULL, `content` text NOT NULL, `type` text DEFAULT 'observation' NOT NULL, `metadata` text DEFAULT '{}' NOT NULL, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action, CONSTRAINT `thoughts_type_check` CHECK(`type` in ('observation','idea','reference','person_note')));
--> statement-breakpoint
CREATE INDEX `thoughts_owner_created_idx` ON `thoughts` (`owner_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `thoughts_owner_project_idx` ON `thoughts` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE TABLE `time_series_points` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `project_id` text, `source` text NOT NULL, `series_key` text NOT NULL, `subject_type` text, `subject_id` text, `value` real, `unit` text, `observed_at` integer NOT NULL, `metadata` text DEFAULT '{}' NOT NULL, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action);
--> statement-breakpoint
CREATE INDEX `time_series_owner_series_observed_idx` ON `time_series_points` (`owner_id`,`series_key`,`observed_at`);
--> statement-breakpoint
CREATE INDEX `time_series_owner_project_observed_idx` ON `time_series_points` (`owner_id`,`project_id`,`observed_at`);
--> statement-breakpoint
CREATE INDEX `time_series_owner_subject_observed_idx` ON `time_series_points` (`owner_id`,`subject_type`,`subject_id`,`observed_at`);
--> statement-breakpoint
CREATE TABLE `thought_people` (`thought_id` text NOT NULL, `person_id` text NOT NULL, PRIMARY KEY(`thought_id`,`person_id`), FOREIGN KEY (`thought_id`) REFERENCES `thoughts`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `thought_people_person_idx` ON `thought_people` (`person_id`);
--> statement-breakpoint
CREATE TABLE `thought_tasks` (`thought_id` text NOT NULL, `task_id` text NOT NULL, PRIMARY KEY(`thought_id`,`task_id`), FOREIGN KEY (`thought_id`) REFERENCES `thoughts`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `thought_tasks_task_idx` ON `thought_tasks` (`task_id`);
--> statement-breakpoint
CREATE TABLE `thought_facts` (`thought_id` text NOT NULL, `fact_id` text NOT NULL, PRIMARY KEY(`thought_id`,`fact_id`), FOREIGN KEY (`thought_id`) REFERENCES `thoughts`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `thought_facts_fact_idx` ON `thought_facts` (`fact_id`);
--> statement-breakpoint
CREATE TABLE `thought_documents` (`thought_id` text NOT NULL, `document_id` text NOT NULL, PRIMARY KEY(`thought_id`,`document_id`), FOREIGN KEY (`thought_id`) REFERENCES `thoughts`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `thought_documents_document_idx` ON `thought_documents` (`document_id`);
--> statement-breakpoint
CREATE TABLE `fact_source_thoughts` (`fact_id` text NOT NULL, `thought_id` text NOT NULL, PRIMARY KEY(`fact_id`,`thought_id`), FOREIGN KEY (`fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`thought_id`) REFERENCES `thoughts`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `fact_source_thoughts_thought_idx` ON `fact_source_thoughts` (`thought_id`);
--> statement-breakpoint
CREATE TABLE `fact_source_facts` (`fact_id` text NOT NULL, `source_fact_id` text NOT NULL, PRIMARY KEY(`fact_id`,`source_fact_id`), FOREIGN KEY (`fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`source_fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `fact_source_facts_source_idx` ON `fact_source_facts` (`source_fact_id`);
--> statement-breakpoint
CREATE TABLE `fact_source_documents` (`fact_id` text NOT NULL, `document_id` text NOT NULL, PRIMARY KEY(`fact_id`,`document_id`), FOREIGN KEY (`fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `fact_source_documents_document_idx` ON `fact_source_documents` (`document_id`);
--> statement-breakpoint
CREATE TABLE `fact_source_document_chunks` (`fact_id` text NOT NULL, `document_chunk_id` text NOT NULL, PRIMARY KEY(`fact_id`,`document_chunk_id`), FOREIGN KEY (`fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE cascade, FOREIGN KEY (`document_chunk_id`) REFERENCES `document_chunks`(`id`) ON UPDATE no action ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX `fact_source_document_chunks_chunk_idx` ON `fact_source_document_chunks` (`document_chunk_id`);
