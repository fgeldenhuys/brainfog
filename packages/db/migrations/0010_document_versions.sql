ALTER TABLE `documents` ADD `current_version_number` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`source` text NOT NULL,
	`version_number` integer NOT NULL,
	`r2_key` text NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_bytes` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_document_version_unique` ON `document_versions` (`document_id`,`version_number`);
--> statement-breakpoint
CREATE INDEX `document_versions_document_version_idx` ON `document_versions` (`document_id`,`version_number`);
--> statement-breakpoint
CREATE INDEX `document_versions_owner_created_idx` ON `document_versions` (`owner_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `document_versions_document_id_idx` ON `document_versions` (`document_id`,`id`);
