import { Database as CoreDatabase } from '@atc-web/service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE jobs (
      name        TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      tags        TEXT NOT NULL DEFAULT '[]',
      enabled     INTEGER NOT NULL DEFAULT 1,
      schedule    TEXT NOT NULL,
      target      TEXT NOT NULL,
      target_key  TEXT,
      timeout_ms  INTEGER NOT NULL,
      retry       TEXT NOT NULL,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX jobs_due ON jobs (next_run_at) WHERE enabled = 1 AND next_run_at IS NOT NULL;

    CREATE TABLE runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name        TEXT NOT NULL REFERENCES jobs(name) ON DELETE CASCADE,
      trigger         TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
      status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retrying', 'succeeded', 'failed', 'skipped', 'cancelled')),
      scheduled_for   INTEGER NOT NULL,
      attempt         INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL,
      next_attempt_at INTEGER,
      started_at      INTEGER,
      finished_at     INTEGER,
      duration_ms     INTEGER,
      http_status     INTEGER,
      response        TEXT,
      error           TEXT,
      attempts        TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX runs_job ON runs (job_name, id DESC);
    CREATE INDEX runs_due ON runs (next_attempt_at) WHERE status IN ('pending', 'retrying');
    CREATE INDEX runs_active ON runs (job_name) WHERE status IN ('pending', 'running', 'retrying');
    CREATE INDEX runs_status ON runs (status, id DESC);
    CREATE INDEX runs_created ON runs (created_at);
    `,
  ];
}
