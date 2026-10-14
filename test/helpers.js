import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { FlagService } from '../src/domain/flag-service.js';
import { ValueCheck } from '../src/domain/value-check.js';
import { FlagsApi } from '../src/http/flags-api.js';
import { FlagStore } from '../src/store/flag-store.js';
import { HistoryStore } from '../src/store/history-store.js';

export const RW_KEY = 'k'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const WRITE_KEY = 'w'.repeat(40);
export const PROD_KEY = 'p'.repeat(40);

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return {
    PORT: '0',
    FLAGS_API_KEYS: `console:${RW_KEY},dashboard:${READ_KEY}:read,deployer:${WRITE_KEY}:write,mobile:${PROD_KEY}:read:prod`,
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

/** @param {Record<string, string>} [overrides] */
export function testConfig(overrides) {
  return Config.fromEnv(testEnv(overrides));
}

/** Wired domain objects over an in-memory database. @param {Record<string, string>} [overrides] */
export function testService(overrides) {
  const config = testConfig(overrides);
  const db = new Database(':memory:');
  const flags = new FlagStore(db);
  const history = new HistoryStore(db);
  const service = new FlagService({ db, flags, history, check: new ValueCheck(config.maxValueBytes), environments: config.environments });
  return { config, db, flags, history, service };
}

/** Fully wired Fastify app. @param {Record<string, string>} [overrides] @param {object} [deps] Extra constructor deps, e.g. an AuditClient. */
export async function buildApp(overrides, deps = {}) {
  const t = testService(overrides);
  const app = await new FlagsApi({ ...t, version: readServiceVersion(import.meta.url), ...deps }).build();
  await app.ready();
  return { app, ...t };
}

/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}
