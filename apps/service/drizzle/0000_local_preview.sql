CREATE TABLE town_state (
  id TEXT PRIMARY KEY NOT NULL,
  cursor INTEGER NOT NULL,
  data TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data TEXT NOT NULL
);
