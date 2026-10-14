import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults, environments, key roles and scopes', () => {
  const c = Config.fromEnv(testEnv());
  assert.deepEqual(c.environments, ['dev', 'staging', 'prod']);
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role, k.envs]), [['console', 'readwrite', null], ['dashboard', 'read', null], ['deployer', 'write', null], ['mobile', 'read', ['prod']]]);
  assert.equal(c.historyRetentionDays, 365);
  assert.deepEqual(Config.fromEnv(testEnv({ FLAGS_ENVIRONMENTS: 'live, test', FLAGS_API_KEYS: `a:${'a'.repeat(40)}:read:live+test` })).apiKeys[0].envs, ['live', 'test']);
  assert.ok(Object.isFrozen(c));
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ FLAGS_API_KEYS: '' }, /FLAGS_API_KEYS is required/);
  bad({ FLAGS_API_KEYS: 'a:short' }, /at least 32/);
  bad({ FLAGS_API_KEYS: `a:${'a'.repeat(40)}:read:qa` }, /unknown environment "qa"/);
  bad({ FLAGS_API_KEYS: `a:${'a'.repeat(40)}:owner` }, /read, write or readwrite/);
  bad({ FLAGS_ENVIRONMENTS: 'Prod' }, /must match/);
  bad({ FLAGS_ENVIRONMENTS: 'prod,prod' }, /unique/);
  bad({ TLS_CERT_PATH: '/x.pem' }, /must be set together/);
});

test('Config: WEBHOOK_OUT_URL and WEBHOOK_OUT_API_KEY come together', () => {
  assert.equal(Config.fromEnv(testEnv()).webhookOut, null);
  assert.equal(Config.fromEnv(testEnv({ WEBHOOK_OUT_URL: 'http://h:3009/', WEBHOOK_OUT_API_KEY: 'k' })).webhookOut?.url, 'http://h:3009');
  assert.throws(() => Config.fromEnv(testEnv({ WEBHOOK_OUT_URL: 'http://h' })), ConfigError);
});
