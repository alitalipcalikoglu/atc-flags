import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/atc-service-core/config';
import { EventPublisher } from './events/event-publisher.js';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static ENV_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.webhookOut = v.webhookOut;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.environments = v.environments;
    this.rateLimitMax = v.rateLimitMax;
    this.historyRetentionDays = v.historyRetentionDays;
    this.maxValueBytes = v.maxValueBytes;
    Object.freeze(this);
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    const environments = Config.#parseEnvironments(r.optional('FLAGS_ENVIRONMENTS') || 'dev,staging,prod');

    return new Config({
      port: r.integer('PORT', 3007, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      webhookOut: EventPublisher.parseEnv(r, ConfigError),
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/flags.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys: Config.#parseApiKeys(r.required('FLAGS_API_KEYS'), environments),
      environments,
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 1_200, { min: 1 }),
      historyRetentionDays: r.integer('HISTORY_RETENTION_DAYS', 365, { min: 1 }),
      maxValueBytes: r.integer('MAX_VALUE_BYTES', 16_384, { min: 64 }),
    });
  }

  /** @param {string} raw */
  static #parseEnvironments(raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) throw new ConfigError('FLAGS_ENVIRONMENTS must list at least one environment');
    for (const e of list) if (!Config.ENV_PATTERN.test(e)) throw new ConfigError(`FLAGS_ENVIRONMENTS entry "${e}" must match [a-z][a-z0-9-]{0,31}`);
    if (new Set(list).size !== list.length) throw new ConfigError('FLAGS_ENVIRONMENTS entries must be unique');
    return list;
  }

  /**
   * Parse `id:secret[:role[:env+env]]`. Role defaults to `readwrite`, environments to all.
   * @param {string} raw
   * @param {string[]} environments
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw, environments) {
    return parseApiKeys(raw, 'FLAGS_API_KEYS', { roles: ['read', 'write', 'readwrite'], scopeValidate: (e) => environments.includes(e), scopeNoun: 'environment', minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read, write or readwrite' })
      .map(({ id, secret, role, scopes }) => ({ id, secret, role: /** @type {KeyRole} */ (role), envs: scopes }));
  }
}
