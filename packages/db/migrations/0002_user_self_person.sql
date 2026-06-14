ALTER TABLE `users` ADD `self_person_id` text;
--> statement-breakpoint
CREATE INDEX `users_self_person_idx` ON `users` (`self_person_id`);
