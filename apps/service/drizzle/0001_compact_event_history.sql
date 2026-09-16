CREATE TABLE event_baseline (
  id TEXT PRIMARY KEY NOT NULL,
  cursor INTEGER NOT NULL,
  data TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE command_receipts (
  source_id TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX command_receipts_age ON command_receipts(pinned, created_at, cursor);
--> statement-breakpoint
PRAGMA user_version = 2;
