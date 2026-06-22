CREATE TABLE `ingestion_connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`schedule` text DEFAULT NULL,
	`cursor` text DEFAULT NULL,
	`last_run_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ingestion_connectors_status_check" CHECK(`status` in ('active','paused','disabled'))
);
--> statement-breakpoint
CREATE INDEX `ingestion_connectors_owner_status_idx` ON `ingestion_connectors` (`owner_id`,`status`);
--> statement-breakpoint
CREATE INDEX `ingestion_connectors_owner_type_idx` ON `ingestion_connectors` (`owner_id`,`type`);
--> statement-breakpoint
CREATE INDEX `ingestion_connectors_owner_project_idx` ON `ingestion_connectors` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE TABLE `ingestion_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`source` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`cursor_before` text,
	`cursor_after` text,
	`inserted_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connector_id`) REFERENCES `ingestion_connectors`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ingestion_runs_trigger_check" CHECK(`trigger` in ('manual','scheduled','bridge')),
	CONSTRAINT "ingestion_runs_status_check" CHECK(`status` in ('running','succeeded','failed'))
);
--> statement-breakpoint
CREATE INDEX `ingestion_runs_owner_connector_idx` ON `ingestion_runs` (`owner_id`,`connector_id`);
--> statement-breakpoint
CREATE INDEX `ingestion_runs_owner_started_idx` ON `ingestion_runs` (`owner_id`,`started_at`);
--> statement-breakpoint
CREATE TABLE `ingestion_idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`source_item_id` text NOT NULL,
	`series_key` text NOT NULL,
	`observed_at` integer NOT NULL,
	`time_series_point_id` text,
	`run_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connector_id`) REFERENCES `ingestion_connectors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`time_series_point_id`) REFERENCES `time_series_points`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `ingestion_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_idempotency_unique` ON `ingestion_idempotency_keys` (`owner_id`,`connector_id`,`source_item_id`,`series_key`,`observed_at`);
--> statement-breakpoint
CREATE INDEX `ingestion_idempotency_connector_idx` ON `ingestion_idempotency_keys` (`owner_id`,`connector_id`);
