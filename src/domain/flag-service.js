import { randomBytes } from 'node:crypto';
import { FlagError } from './errors.js';
import { Evaluator } from './evaluator.js';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../store/flag-store.js').FlagStore} FlagStore */
/** @typedef {import('../store/history-store.js').HistoryStore} HistoryStore */
/** @typedef {import('./value-check.js').ValueCheck} ValueCheck */
/** @typedef {import('../types.js').FlagRow} FlagRow */
/** @typedef {import('../types.js').EnvRow} EnvRow */
/** @typedef {import('../types.js').EnvState} EnvState */
/** @typedef {import('../types.js').FlagKind} FlagKind */
/** @typedef {import('../types.js').Context} Context */
/** @typedef {import('../types.js').Evaluation} Evaluation */

/**
 * @typedef {object} CreateInput
 * @property {string} key
 * @property {FlagKind} kind
 * @property {string} [description]
 * @property {string[]} [tags]
 * @property {unknown} [value]      Initial `value` for every environment (kind default otherwise).
 * @property {unknown} [offValue]   Initial `offValue` for every environment.
 * @property {boolean} [enabled]    Initial `enabled` for every environment (default false).
 */

/** Use-cases: flag lifecycle, per-environment state, evaluation, snapshots, history. */
export class FlagService {
  static KEY = /^[a-z0-9]+([.\-_][a-z0-9]+)*$/;

  /**
   * @param {object} deps
   * @param {Database} deps.db
   * @param {FlagStore} deps.flags
   * @param {HistoryStore} deps.history
   * @param {ValueCheck} deps.check
   * @param {string[]} deps.environments
   * @param {{ publish: (type: string, data?: unknown) => boolean }} [deps.publisher]
   */
  constructor({ db, flags, history, check, environments, publisher }) {
    this.db = db;
    this.flags = flags;
    this.history = history;
    this.check = check;
    this.environments = environments;
    this.publisher = publisher ?? { publish: () => false };
    /** Evaluations since start, per environment. @type {Map<string, number>} */
    this.evaluations = new Map();
    /** Cached environment states keyed by env; invalidated by version. @type {Map<string, { version: number, states: Map<string, { salt: string, kind: FlagKind, state: EnvState }> }>} */
    this.cache = new Map();
  }

  /** @param {FlagKind} kind */
  static defaultValue(kind) {
    return kind === 'boolean' ? false : kind === 'string' ? '' : kind === 'number' ? 0 : null;
  }

  /** @param {FlagKind} kind */
  static defaultOn(kind) {
    return kind === 'boolean' ? true : FlagService.defaultValue(kind);
  }

  /** @param {string} env */
  assertEnv(env) {
    if (!this.environments.includes(env)) throw new FlagError('UNKNOWN_ENV', `unknown environment "${env}"`, { environments: this.environments });
  }

  /**
   * @param {CreateInput} input
   * @param {string} actor
   * @param {number} [now]
   */
  create(input, actor, now = Date.now()) {
    if (!FlagService.KEY.test(input.key) || input.key.length > 80) throw new FlagError('INVALID_VALUE', 'key must be lower-case segments separated by . - or _, at most 80 characters', { where: 'key' });
    if (this.flags.flag(input.key)) throw new FlagError('FLAG_EXISTS', `flag "${input.key}" already exists`);
    const value = this.check.value(input.kind, input.value ?? FlagService.defaultOn(input.kind), 'value');
    const offValue = this.check.value(input.kind, input.offValue ?? FlagService.defaultValue(input.kind), 'offValue');
    const created = this.db.transaction(() => {
      const row = this.flags.insertFlag({
        key: input.key, kind: input.kind, description: input.description ?? '', tags: FlagService.#tags(input.tags), archived: 0,
        rollout_salt: randomBytes(8).toString('hex'), created_by: actor, created_at: now, updated_at: now,
      });
      for (const env of this.environments) {
        this.flags.insertEnv({ key: row.key, env, enabled: input.enabled ? 1 : 0, value: JSON.stringify(value), off_value: JSON.stringify(offValue), percentage: 100, rules: '[]', updated_by: actor, updated_at: now });
      }
      this.history.record({ key: row.key, action: 'flag.create', actor, after: { kind: row.kind, description: row.description, tags: JSON.parse(row.tags), enabled: Boolean(input.enabled), value, offValue } }, now);
      return row;
    });
    this.#changed('flag.create', input.key, null, actor);
    return created;
  }

  /** @param {string} key */
  get(key) {
    const row = this.flags.flag(key);
    if (!row) throw new FlagError('FLAG_NOT_FOUND', `flag "${key}" not found`);
    return row;
  }

  /**
   * @param {string} key
   * @param {{ description?: string, tags?: string[], archived?: boolean, reshuffle?: boolean }} patch
   * @param {string} actor
   * @param {number} [now]
   */
  update(key, patch, actor, now = Date.now()) {
    const row = this.get(key);
    const next = { ...row, updated_at: now };
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.tags !== undefined) next.tags = FlagService.#tags(patch.tags);
    if (patch.archived !== undefined) next.archived = patch.archived ? 1 : 0;
    if (patch.reshuffle) next.rollout_salt = randomBytes(8).toString('hex');
    this.db.transaction(() => {
      this.flags.updateFlag(next);
      if (next.archived !== row.archived || patch.reshuffle) for (const env of this.environments) this.flags.touch(env);
      this.history.record({ key, action: 'flag.update', actor, before: FlagService.#meta(row), after: FlagService.#meta(next) }, now);
    });
    this.#changed('flag.update', key, null, actor);
    return next;
  }

  /**
   * @param {string} key
   * @param {string} actor
   * @param {number} [now]
   */
  remove(key, actor, now = Date.now()) {
    const row = this.get(key);
    this.db.transaction(() => {
      this.flags.deleteFlag(key);
      for (const env of this.environments) this.flags.touch(env);
      this.history.record({ key, action: 'flag.delete', actor, before: FlagService.#meta(row) }, now);
    });
    this.#changed('flag.delete', key, null, actor);
  }

  /**
   * @param {string} key
   * @param {string} env
   */
  envState(key, env) {
    this.assertEnv(env);
    const row = this.flags.env(key, env);
    if (!row) throw new FlagError('FLAG_NOT_FOUND', `flag "${key}" not found`);
    return row;
  }

  /**
   * Partial update of one environment's state; every given field is validated against the kind.
   * @param {string} key
   * @param {string} env
   * @param {{ enabled?: boolean, value?: unknown, offValue?: unknown, percentage?: number, rules?: unknown }} patch
   * @param {string} actor
   * @param {number} [now]
   */
  updateEnv(key, env, patch, actor, now = Date.now()) {
    const flag = this.get(key);
    const row = this.envState(key, env);
    const next = { ...row, updated_by: actor, updated_at: now };
    if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
    if (patch.value !== undefined) next.value = JSON.stringify(this.check.value(flag.kind, patch.value, 'value'));
    if (patch.offValue !== undefined) next.off_value = JSON.stringify(this.check.value(flag.kind, patch.offValue, 'offValue'));
    if (patch.percentage !== undefined) next.percentage = patch.percentage;
    if (patch.rules !== undefined) next.rules = JSON.stringify(this.check.rules(flag.kind, patch.rules));
    const saved = this.db.transaction(() => {
      const updated = this.flags.updateEnv(next);
      this.history.record({ key, env, action: 'env.update', actor, before: FlagService.state(row), after: FlagService.state(updated) }, now);
      return updated;
    });
    this.#changed('env.update', key, env, actor, saved);
    return saved;
  }

  /**
   * Copy one environment's state onto another (promote staging → prod).
   * @param {string} key
   * @param {string} from
   * @param {string} to
   * @param {string} actor
   * @param {number} [now]
   */
  copyEnv(key, from, to, actor, now = Date.now()) {
    const src = this.envState(key, from);
    const dst = this.envState(key, to);
    const saved = this.db.transaction(() => {
      const copied = this.flags.updateEnv({ ...dst, enabled: src.enabled, value: src.value, off_value: src.off_value, percentage: src.percentage, rules: src.rules, updated_by: actor, updated_at: now });
      this.history.record({ key, env: to, action: 'env.copy', actor, before: FlagService.state(dst), after: { from, ...FlagService.state(copied) } }, now);
      return copied;
    });
    this.#changed('env.copy', key, to, actor, saved);
    return saved;
  }

  /**
   * @param {{ q?: string, tag?: string, archived?: boolean, kind?: string }} filter
   * @param {{ limit: number, cursor?: string }} page
   */
  list(filter, { limit, cursor }) {
    if (cursor !== undefined && !FlagService.KEY.test(cursor)) throw new FlagError('INVALID_CURSOR', 'cursor is not valid');
    const rows = this.flags.list(filter, { limit: limit + 1, after: cursor });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? /** @type {FlagRow} */ (items.at(-1)).key : null };
  }

  /**
   * Every non-archived flag of an environment with its rollout salt, cached by version.
   * @param {string} env
   */
  #states(env) {
    this.assertEnv(env);
    const version = this.flags.version(env);
    const cached = this.cache.get(env);
    if (cached && cached.version === version) return cached;
    /** @type {Map<string, { salt: string, kind: FlagKind, state: EnvState }>} */
    const states = new Map();
    const meta = new Map(this.flags.salts().map((s) => [s.key, s]));
    for (const row of this.flags.envsIn(env)) {
      const m = meta.get(row.key);
      if (!m || m.archived) continue;
      states.set(row.key, { salt: m.rollout_salt, kind: m.kind, state: FlagService.state(row) });
    }
    const entry = { version, states };
    this.cache.set(env, entry);
    return entry;
  }

  /**
   * Evaluate every (or the requested) flags for a context.
   * @param {string} env
   * @param {Context} ctx
   * @param {string[]} [keys]
   * @returns {{ version: number, results: Record<string, Evaluation> }}
   */
  evaluate(env, ctx, keys) {
    const { version, states } = this.#states(env);
    this.evaluations.set(env, (this.evaluations.get(env) ?? 0) + 1);
    /** @type {Record<string, Evaluation>} */
    const results = {};
    for (const key of keys ?? [...states.keys()]) {
      const s = states.get(key);
      results[key] = s ? Evaluator.evaluate(s.state, s.salt, ctx) : { value: null, reason: 'missing' };
    }
    return { version, results };
  }

  /**
   * Full rule set of an environment for client-side evaluation.
   * @param {string} env
   */
  snapshot(env) {
    const { version, states } = this.#states(env);
    return { env, version, flags: Object.fromEntries([...states].map(([key, s]) => [key, { kind: s.kind, salt: s.salt, ...s.state }])) };
  }

  /**
   * @param {EnvRow} row
   * @returns {EnvState}
   */
  static state(row) {
    return { enabled: row.enabled === 1, value: JSON.parse(row.value), offValue: JSON.parse(row.off_value), percentage: Number(row.percentage), rules: JSON.parse(row.rules) };
  }

  /**
   * `flag.changed` for subscribers (clients refresh instead of polling). Carries what changed, never the values.
   * @param {string} action @param {string} key @param {string|null} env @param {string} actor @param {EnvRow} [row]
   */
  #changed(action, key, env, actor, row) {
    this.publisher.publish('flag.changed', { key, env, action, actor, ...(row ? { enabled: row.enabled === 1, percentage: Number(row.percentage) } : {}) });
  }

  /** @param {FlagRow} r */
  static #meta(r) {
    return { description: r.description, tags: JSON.parse(r.tags), archived: r.archived === 1 };
  }

  /** @param {string[]|undefined} tags */
  static #tags(tags) {
    return JSON.stringify([...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].sort());
  }
}
