CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`story_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scenes_story_idx` ON `scenes` (`story_id`);--> statement-breakpoint
CREATE INDEX `scenes_story_position_idx` ON `scenes` (`story_id`,`position`);--> statement-breakpoint
CREATE TABLE `shots` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`position` integer NOT NULL,
	`description` text NOT NULL,
	`duration_ms` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shots_scene_idx` ON `shots` (`scene_id`);--> statement-breakpoint
CREATE INDEX `shots_scene_position_idx` ON `shots` (`scene_id`,`position`);--> statement-breakpoint
CREATE TABLE `stories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`premise` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stories_project_idx` ON `stories` (`project_id`);--> statement-breakpoint
CREATE INDEX `stories_project_updated_at_idx` ON `stories` (`project_id`,`updated_at`);