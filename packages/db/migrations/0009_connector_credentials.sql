CREATE TABLE `ingestion_connector_credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `connector_id` text NOT NULL,
  `source` text NOT NULL,
  `auth_type` text NOT NULL DEFAULT 'password',
  `status` text NOT NULL DEFAULT 'valid',
  `encrypted_payload` text NOT NULL,
  `encryption_metadata` text DEFAULT '{}' NOT NULL,
  `redacted_summary` text DEFAULT '{}' NOT NULL,
  `expires_at` integer,
  `last_verified_at` integer,
  `shared` integer DEFAULT 0 NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connector_id`) REFERENCES `ingestion_connectors`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT "ingestion_connector_credentials_status_check" CHECK(`status` in ('missing','valid','needs_setup','mfa_required','expired','revoked','error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_connector_credentials_owner_connector_unique` ON `ingestion_connector_credentials` (`owner_id`,`connector_id`);
--> statement-breakpoint
CREATE INDEX `ingestion_connector_credentials_owner_status_idx` ON `ingestion_connector_credentials` (`owner_id`,`status`);
--> statement-breakpoint
CREATE INDEX `ingestion_connector_credentials_connector_idx` ON `ingestion_connector_credentials` (`owner_id`,`connector_id`);
