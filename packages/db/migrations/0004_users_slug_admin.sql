ALTER TABLE `users` ADD `slug` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `is_admin` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_slug_unique` ON `users` (`slug`) WHERE `slug` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `users_slug_idx` ON `users` (`slug`);
