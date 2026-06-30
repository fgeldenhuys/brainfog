CREATE TABLE `document_transfer_capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source` text NOT NULL,
	`operation` text NOT NULL,
	`secret_hash` text NOT NULL,
	`project_id` text,
	`document_id` text,
	`title` text,
	`filename` text,
	`mime_type` text,
	`write_mode` text,
	`indexing_mode` text,
	`max_size_bytes` integer,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_transfer_capabilities_secret_hash_unique` ON `document_transfer_capabilities` (`secret_hash`);
--> statement-breakpoint
CREATE INDEX `document_transfer_capabilities_expires_at_idx` ON `document_transfer_capabilities` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `document_transfer_capabilities_owner_idx` ON `document_transfer_capabilities` (`owner_id`);
