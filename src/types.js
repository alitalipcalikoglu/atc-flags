/**
 * Shared JSDoc typedefs for the flags service. No runtime exports.
 */

/** @typedef {'read'|'write'|'readwrite'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 * @property {string[]|null} envs   Environments this key may read/write; null = all.
 */

/**
 * Plain values accepted by the `Config` constructor.
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit   Audit service to forward events to; null = off.
 * @property {{ url: string, apiKey: string, timeoutMs: number }|null} webhookOut  atc-webhook-out target for events; null = off.
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string} [dbBackupDir]
 * @property {ApiKey[]} apiKeys
 * @property {string[]} environments
 * @property {number} rateLimitMax
 * @property {number} historyRetentionDays
 * @property {number} maxValueBytes
 */

/** @typedef {import('./config.js').Config} Config */

/** @typedef {'boolean'|'string'|'number'|'json'} FlagKind */

/**
 * Who is asking. Every field optional; percentage rollouts need an id.
 * @typedef {object} Context
 * @property {string} [userId]
 * @property {string} [email]
 * @property {Record<string, string>} [attrs]
 */

/**
 * A targeting rule: the first rule whose `match` fits the context decides the value.
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} [name]
 * @property {{ userIds?: string[], emails?: string[], attrs?: Record<string, string[]> }} match
 * @property {unknown} value
 */

/**
 * State of one flag in one environment.
 * @typedef {object} EnvState
 * @property {boolean} enabled
 * @property {unknown} value       Served when enabled and inside the rollout.
 * @property {unknown} offValue    Served when disabled or outside the rollout.
 * @property {number} percentage   0..100 share of identified contexts that receive `value`.
 * @property {Rule[]} rules
 */

/**
 * @typedef {object} FlagRow
 * @property {string} key
 * @property {FlagKind} kind
 * @property {string} description
 * @property {string} tags          JSON array.
 * @property {number} archived
 * @property {string} rollout_salt
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {object} EnvRow
 * @property {string} key
 * @property {string} env
 * @property {number} enabled
 * @property {string} value        JSON.
 * @property {string} off_value    JSON.
 * @property {number} percentage
 * @property {string} rules        JSON.
 * @property {number} version
 * @property {string} updated_by
 * @property {number} updated_at
 */

/**
 * @typedef {object} HistoryRow
 * @property {number} id
 * @property {string} key
 * @property {string|null} env
 * @property {string} action
 * @property {string} actor
 * @property {string|null} before   JSON.
 * @property {string|null} after    JSON.
 * @property {number} at
 */

/**
 * @typedef {object} Evaluation
 * @property {unknown} value
 * @property {'disabled'|'rule'|'rollout'|'excluded'|'default'|'missing'} reason
 * @property {string} [ruleId]
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
