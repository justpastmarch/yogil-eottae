CREATE TABLE `journey_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`view_id` text NOT NULL,
	`source` text NOT NULL,
	`mime` text NOT NULL,
	`byte_length` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `journey_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `journey_captures_job` ON `journey_captures` (`job_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `journey_capture_parts` (
	`capture_id` text NOT NULL,
	`part_index` integer NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY (`capture_id`,`part_index`),
	FOREIGN KEY (`capture_id`) REFERENCES `journey_captures`(`id`) ON UPDATE no action ON DELETE cascade
);
