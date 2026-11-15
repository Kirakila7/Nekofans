CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`creator` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`body` text NOT NULL,
	`category` text NOT NULL,
	`tags` text NOT NULL,
	`stage` text NOT NULL,
	`url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entries_created_idx` ON `entries` (`created_at`);--> statement-breakpoint
CREATE INDEX `entries_author_idx` ON `entries` (`author_id`);