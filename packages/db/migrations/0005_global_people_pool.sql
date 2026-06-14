DROP INDEX IF EXISTS `people_owner_name_idx`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `people_name_idx` ON `people` (`name`);
