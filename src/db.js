import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE flags (
      key          TEXT PRIMARY KEY,
      kind         TEXT NOT NULL CHECK (kind IN ('boolean', 'string', 'number', 'json')),
      description  TEXT NOT NULL DEFAULT '',
      tags         TEXT NOT NULL DEFAULT '[]',
      archived     INTEGER NOT NULL DEFAULT 0,
      rollout_salt TEXT NOT NULL,
      created_by   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE flag_envs (
      key         TEXT NOT NULL REFERENCES flags(key) ON DELETE CASCADE,
      env         TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 0,
      value       TEXT NOT NULL,
      off_value   TEXT NOT NULL,
      percentage  INTEGER NOT NULL DEFAULT 100,
      rules       TEXT NOT NULL DEFAULT '[]',
      version     INTEGER NOT NULL DEFAULT 1,
      updated_by  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (key, env)
    );
    CREATE INDEX flag_envs_env ON flag_envs (env);

    -- One counter per environment, bumped on every change; the snapshot ETag.
    CREATE TABLE env_versions (
      env     TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE history (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      key     TEXT NOT NULL,
      env     TEXT,
      action  TEXT NOT NULL,
      actor   TEXT NOT NULL,
      before  TEXT,
      after   TEXT,
      at      INTEGER NOT NULL
    );
    CREATE INDEX history_key ON history (key, id DESC);
    CREATE INDEX history_at ON history (at);
    `,
  ];
}
