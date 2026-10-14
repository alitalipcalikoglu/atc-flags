import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/atc-service-core/auth';
import { FlagError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/**
 * Bearer API-key authentication with read/write roles and optional environment scoping. Thin
 * wrapper over service-core's `ApiKeyAuth`.
 */
export class ApiKeyAuth {
  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys);
  }

  /** Fastify `onRequest` hook. */
  get hook() {
    return this.core.hook;
  }

  /**
   * Route-level guard on role.
   * @param {'read'|'write'} need
   */
  static require(need) {
    return CoreApiKeyAuth.require(need, {
      roleOf: (request) => /** @type {any} */ (request).apiKey?.role,
      makeError: (n) => new FlagError('FORBIDDEN', `this API key has no ${n} access`),
    });
  }

  /**
   * Environment guard: a key scoped to some environments may not touch others.
   * @param {ApiKey} key
   * @param {string} env
   */
  static assertEnv(key, env) {
    CoreApiKeyAuth.assertScope(/** @type {any} */ ({ scopes: key.envs }), env, (name) => new FlagError('FORBIDDEN', `this API key has no access to environment "${name}"`));
  }

  /**
   * @param {string} secret Presented secret.
   * @returns {ApiKey|undefined} Matching key.
   */
  identify(secret) {
    return /** @type {ApiKey|undefined} */ (/** @type {any} */ (this.core.identify(secret)));
  }
}
