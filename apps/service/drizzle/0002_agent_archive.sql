CREATE TABLE agent_archive (
  id TEXT PRIMARY KEY NOT NULL,
  repo_id TEXT NOT NULL,
  connection_id TEXT,
  session_id TEXT,
  parent_session_id TEXT,
  archived_at TEXT NOT NULL,
  data TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_archive_identity ON agent_archive(connection_id, session_id, coalesce(parent_session_id, '')) WHERE connection_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_archive_order ON agent_archive(archived_at DESC, id);
--> statement-breakpoint
CREATE TABLE repository_archive (
  id TEXT PRIMARY KEY NOT NULL,
  disconnected_at TEXT NOT NULL,
  data TEXT NOT NULL
);
--> statement-breakpoint
PRAGMA user_version = 3;
