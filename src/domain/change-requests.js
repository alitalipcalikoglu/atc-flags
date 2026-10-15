import { randomBytes } from 'node:crypto';
import { FlagError } from './errors.js';
import { FlagService } from './flag-service.js';

/** @typedef {import('../db.js').Database} Database */

/**
 * @typedef {object} ChangeRow
 * @property {string} id
 * @property {string} flag_key
 * @property {string} env
 * @property {'update'|'copy'} kind
 * @property {string} payload        JSON: the env patch, or `{ from }` for a copy.
 * @property {number} base_updated   updated_at of the environment state when the change was requested.
 * @property {'pending'|'approved'|'rejected'} status
 * @property {string} requested_by
 * @property {number} requested_at
 * @property {string|null} decided_by
 * @property {number|null} decided_at
 * @property {string|null} note
 */

/**
 * Two-person rule for protected environments (PROTECTED_ENVS): a change there is stored as a
 * request; a different actor approves (applies) or rejects it. A request whose environment changed
 * meanwhile is stale and must be made again, so nobody approves something they did not see.
 */
export class ChangeRequests {
  /**
   * @param {object} deps
   * @param {Database} deps.db
   * @param {FlagService} deps.service
   * @param {string[]} deps.protectedEnvs
   */
  constructor({ db, service, protectedEnvs }) {
    this.db = db;
    this.service = service;
    this.protectedEnvs = protectedEnvs;
    this.stmt = {
      insert: db.prepare('INSERT INTO changes (id, flag_key, env, kind, payload, base_updated, status, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?, ?)'),
      get: db.prepare('SELECT * FROM changes WHERE id = ?'),
      decide: db.prepare('UPDATE changes SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = \'pending\''),
      pendingCount: db.prepare('SELECT COUNT(*) AS n FROM changes WHERE status = \'pending\''),
    };
  }

  /** @param {string} env */
  isProtected(env) { return this.protectedEnvs.includes(env); }

  /**
   * Store a change for approval. The payload is validated now (the same checks as applying it).
   * @param {string} key @param {string} env @param {'update'|'copy'} kind @param {Record<string, unknown>} payload @param {string} actor @param {number} [now]
   */
  request(key, env, kind, payload, actor, now = Date.now()) {
    const row = this.service.envState(key, env);
    if (kind === 'update') this.service.validateEnvPatch(key, /** @type {any} */ (payload));
    else this.service.envState(key, /** @type {string} */ (payload.from));
    const id = `chg_${now.toString(36)}${randomBytes(6).toString('hex')}`;
    this.db.transaction(() => {
      this.stmt.insert.run(id, key, env, kind, JSON.stringify(payload), row.updated_at, actor, now);
      this.service.history.record({ key, env, action: 'change.requested', actor, before: FlagService.state(row), after: { change: id, kind, ...payload } }, now);
    });
    return this.get(id);
  }

  /** @param {string} id @returns {ChangeRow} */
  get(id) {
    const c = /** @type {ChangeRow|undefined} */ (this.stmt.get.get(id));
    if (!c) throw new FlagError('CHANGE_NOT_FOUND', `change "${id}" not found`);
    return c;
  }

  /**
   * Apply a pending change as a second person.
   * @param {string} id @param {string} actor @param {number} [now]
   */
  approve(id, actor, now = Date.now()) {
    const c = this.#pending(id);
    if (c.requested_by === actor) throw new FlagError('SELF_APPROVAL', 'a change needs the approval of someone other than its requester');
    const current = this.service.envState(c.flag_key, c.env);
    if (current.updated_at !== c.base_updated) {
      this.stmt.decide.run('rejected', actor, now, 'stale: the environment changed after the request', id);
      throw new FlagError('CHANGE_STALE', 'the environment changed after this request; it was closed, request the change again');
    }
    const payload = JSON.parse(c.payload);
    const by = `${actor} (approved ${c.id} by ${c.requested_by})`;
    const state = c.kind === 'update' ? this.service.updateEnv(c.flag_key, c.env, payload, by, now) : this.service.copyEnv(c.flag_key, payload.from, c.env, by, now);
    this.stmt.decide.run('approved', actor, now, null, id);
    return { change: this.get(id), state };
  }

  /**
   * Turn a pending change down (or withdraw your own).
   * @param {string} id @param {string} actor @param {string|null} note @param {number} [now]
   */
  reject(id, actor, note, now = Date.now()) {
    const c = this.#pending(id);
    this.db.transaction(() => {
      this.stmt.decide.run('rejected', actor, now, note, id);
      this.service.history.record({ key: c.flag_key, env: c.env, action: 'change.rejected', actor, before: null, after: { change: id, note } }, now);
    });
    return this.get(id);
  }

  /**
   * Newest first.
   * @param {{ status?: 'pending'|'approved'|'rejected', key?: string, envs?: string[]|null, limit: number }} q
   * @returns {ChangeRow[]}
   */
  list(q) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const args = [];
    if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.key) { where.push('flag_key = ?'); args.push(q.key); }
    if (q.envs) { where.push(`env IN (${q.envs.map(() => '?').join(', ') || 'NULL'})`); args.push(...q.envs); }
    return /** @type {ChangeRow[]} */ (this.db.prepare(`SELECT * FROM changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC, id DESC LIMIT ?`).all(...args, q.limit));
  }

  pendingCount() { return Number(/** @type {{ n: number }} */ (this.stmt.pendingCount.get()).n); }

  /** @param {string} id */
  #pending(id) {
    const c = this.get(id);
    if (c.status !== 'pending') throw new FlagError('CHANGE_CLOSED', `change "${id}" is already ${c.status}`);
    return c;
  }
}
