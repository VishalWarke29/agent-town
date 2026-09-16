CREATE TABLE native_sources (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  home_key TEXT NOT NULL,
  home_path TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(provider, home_key)
);
--> statement-breakpoint
CREATE TABLE native_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  agent_id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  agent_data TEXT,
  UNIQUE(source_id, native_id)
);
--> statement-breakpoint
CREATE INDEX native_sessions_repo ON native_sessions(repo_id);
--> statement-breakpoint
CREATE TABLE native_session_aliases (
  alias_key TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL
);
--> statement-breakpoint
PRAGMA user_version = 4;
