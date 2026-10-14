/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').FlagRow} FlagRow */
/** @typedef {import('../types.js').EnvRow} EnvRow */

/** Persistence for flags, their per-environment states and environment versions. */
export class FlagStore {
  static FLAG_COLUMNS = 'key, kind, description, tags, archived, rollout_salt, created_by, created_at, updated_at';
  static ENV_COLUMNS = 'key, env, enabled, value, off_value, percentage, rules, version, updated_by, updated_at';

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const F = FlagStore.FLAG_COLUMNS;
    const E = FlagStore.ENV_COLUMNS;
    this.stmt = {
      insertFlag: db.prepare(`INSERT INTO flags (${F}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      flag: db.prepare(`SELECT ${F} FROM flags WHERE key = ?`),
      updateFlag: db.prepare(`UPDATE flags SET description = ?, tags = ?, archived = ?, rollout_salt = ?, updated_at = ? WHERE key = ?`),
      deleteFlag: db.prepare(`DELETE FROM flags WHERE key = ?`),
      insertEnv: db.prepare(`INSERT INTO flag_envs (${E}) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`),
      env: db.prepare(`SELECT ${E} FROM flag_envs WHERE key = ? AND env = ?`),
      envsOf: db.prepare(`SELECT ${E} FROM flag_envs WHERE key = ? ORDER BY env`),
      envsIn: db.prepare(`SELECT ${E} FROM flag_envs WHERE env = ?`),
      updateEnv: db.prepare(`UPDATE flag_envs SET enabled = ?, value = ?, off_value = ?, percentage = ?, rules = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE key = ? AND env = ?`),
      bumpVersion: db.prepare(`INSERT INTO env_versions (env, version) VALUES (?, 1) ON CONFLICT(env) DO UPDATE SET version = version + 1`),
      version: db.prepare(`SELECT version FROM env_versions WHERE env = ?`),
      counts: db.prepare(`SELECT COUNT(*) AS total, SUM(archived) AS archived FROM flags`),
      countsByEnv: db.prepare(`SELECT env, SUM(enabled) AS enabled, COUNT(*) AS total FROM flag_envs GROUP BY env`),
      salts: db.prepare(`SELECT key, kind, rollout_salt, archived FROM flags`),
    };
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.cache = new Map();
  }

  /** @param {FlagRow} row */
  insertFlag(row) {
    this.stmt.insertFlag.run(row.key, row.kind, row.description, row.tags, row.archived, row.rollout_salt, row.created_by, row.created_at, row.updated_at);
    return row;
  }

  /** @param {string} key */
  flag(key) {
    return /** @type {FlagRow|undefined} */ (this.stmt.flag.get(key));
  }

  /** @param {FlagRow} row */
  updateFlag(row) {
    this.stmt.updateFlag.run(row.description, row.tags, row.archived, row.rollout_salt, row.updated_at, row.key);
    return row;
  }

  /** @param {string} key */
  deleteFlag(key) {
    return Number(this.stmt.deleteFlag.run(key).changes) > 0;
  }

  /** @param {Omit<EnvRow, 'version'>} row */
  insertEnv(row) {
    this.stmt.insertEnv.run(row.key, row.env, row.enabled, row.value, row.off_value, row.percentage, row.rules, row.updated_by, row.updated_at);
    this.stmt.bumpVersion.run(row.env);
    return { ...row, version: 1 };
  }

  /** @param {string} key @param {string} env */
  env(key, env) {
    return /** @type {EnvRow|undefined} */ (this.stmt.env.get(key, env));
  }

  /** @param {string} key */
  envsOf(key) {
    return /** @type {EnvRow[]} */ (this.stmt.envsOf.all(key));
  }

  /** All states of one environment (evaluation and snapshot). @param {string} env */
  envsIn(env) {
    return /** @type {EnvRow[]} */ (this.stmt.envsIn.all(env));
  }

  /** @param {EnvRow} row Fields to store; `version` is incremented by the store. */
  updateEnv(row) {
    this.stmt.updateEnv.run(row.enabled, row.value, row.off_value, row.percentage, row.rules, row.updated_by, row.updated_at, row.key, row.env);
    this.stmt.bumpVersion.run(row.env);
    return /** @type {EnvRow} */ (this.env(row.key, row.env));
  }

  /** Bump an environment's version without changing a state (flag deleted / archived). @param {string} env */
  touch(env) {
    this.stmt.bumpVersion.run(env);
  }

  /** Add `n` to an environment's lifetime evaluation count. @param {string} env @param {number} n */
  addEvaluations(env, n) {
    this.db.prepare('INSERT INTO eval_counts (env, total) VALUES (?, ?) ON CONFLICT (env) DO UPDATE SET total = total + excluded.total').run(env, n);
  }

  /** @param {string} env */
  evaluationsOf(env) {
    return Number(/** @type {{ total: number }|undefined} */ (this.db.prepare('SELECT total FROM eval_counts WHERE env = ?').get(env))?.total ?? 0);
  }

  /** @param {string} env */
  version(env) {
    const r = /** @type {{ version: number }|undefined} */ (this.stmt.version.get(env));
    return r ? Number(r.version) : 0;
  }

  /**
   * Newest first by key order (keys are stable, so pagination is by key).
   * @param {{ q?: string, tag?: string, archived?: boolean, kind?: string }} f
   * @param {{ limit: number, after?: string }} page
   * @returns {FlagRow[]}
   */
  list(f, { limit, after }) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const params = [];
    if (f.q !== undefined) { where.push("(key LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"); const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`; params.push(like, like); }
    if (f.tag !== undefined) { where.push('tags LIKE ?'); params.push(`%${JSON.stringify(f.tag)}%`); }
    if (f.kind !== undefined) { where.push('kind = ?'); params.push(f.kind); }
    if (f.archived !== undefined) { where.push('archived = ?'); params.push(f.archived ? 1 : 0); }
    if (after !== undefined) { where.push('key > ?'); params.push(after); }
    const sql = `SELECT ${FlagStore.FLAG_COLUMNS} FROM flags ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY key LIMIT ?`;
    let stmt = this.cache.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this.cache.set(sql, stmt); }
    return /** @type {FlagRow[]} */ (stmt.all(...params, limit));
  }

  counts() {
    const r = /** @type {{ total: number, archived: number|null }} */ (this.stmt.counts.get());
    const byEnv = /** @type {{ env: string, enabled: number|null, total: number }[]} */ (this.stmt.countsByEnv.all()).map((x) => ({ env: x.env, enabled: Number(x.enabled ?? 0), total: Number(x.total) }));
    return { total: Number(r.total), archived: Number(r.archived ?? 0), byEnv };
  }

  /** Kind, rollout salt and archive state of every flag, for evaluation. */
  salts() {
    return /** @type {{ key: string, kind: import('../types.js').FlagKind, rollout_salt: string, archived: number }[]} */ (this.stmt.salts.all());
  }
}
