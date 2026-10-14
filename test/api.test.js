import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Maintenance } from '../src/maintenance.js';
import { PROD_KEY, READ_KEY, RW_KEY, WRITE_KEY, bearer, buildApp } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('API: probes, auth, roles and environment scoping', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/ready' })).statusCode, 200);
  const spec = await app.inject({ url: '/openapi.yaml' });
  assert.equal(spec.body, readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  assert.match(String(spec.headers['content-type']), /^text\/yaml/);
  const info = json(await app.inject({ url: '/v1/info' }));
  assert.equal(info.service, 'atc-flags');
  assert.equal(info.version, PACKAGE_VERSION);
  assert.equal(info.apiVersion, 'v1');
  assert.deepEqual(info.capabilities, ['percentage-rollout', 'targeting-rules', 'snapshot-etag']);
  assert.equal(typeof info.schemaVersion, 'number');
  assert.equal(typeof info.serviceCore, 'string');
  assert.equal((await app.inject({ url: '/v1/flags' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/flags', headers: bearer(WRITE_KEY) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/flags', headers: bearer(READ_KEY), payload: { key: 'a', kind: 'boolean' } })).statusCode, 403);
  const envs = json(await app.inject({ url: '/v1/environments', headers: bearer(PROD_KEY) }));
  assert.deepEqual(envs.items.map((/** @type {any} */ e) => e.env), ['prod'], 'scoped key sees only its environments');
  assert.deepEqual(json(await app.inject({ url: '/v1/environments', headers: bearer(READ_KEY) })).items.map((/** @type {any} */ e) => e.env), ['dev', 'staging', 'prod']);
  let res = await app.inject({ url: '/v1/evaluate?env=staging', headers: bearer(PROD_KEY) });
  assert.equal(res.statusCode, 403);
  assert.match(json(res).error.message, /no access to environment "staging"/);
  res = await app.inject({ url: '/v1/evaluate?env=qa', headers: bearer(READ_KEY) });
  assert.equal(res.statusCode, 404);
  assert.equal(json(res).error.code, 'UNKNOWN_ENV');
  assert.equal((await app.inject({ url: '/metrics', headers: bearer(WRITE_KEY) })).statusCode, 403);
});

test('API: flag lifecycle, environment state, copy, history', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  let res = await app.inject({ method: 'POST', url: '/v1/flags', headers: bearer(WRITE_KEY), payload: { key: 'checkout.new', kind: 'boolean', description: 'New checkout flow', tags: ['checkout'] } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.headers.location, '/v1/flags/checkout.new');
  let { flag } = json(res);
  assert.equal(flag.createdBy, 'deployer');
  assert.deepEqual(Object.keys(flag.environments), ['dev', 'prod', 'staging']);
  assert.deepEqual(flag.environments.prod, { enabled: false, value: true, offValue: false, percentage: 100, rules: [], version: 1, updatedBy: 'deployer', updatedAt: flag.environments.prod.updatedAt });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/flags', headers: bearer(WRITE_KEY), payload: { key: 'checkout.new', kind: 'boolean' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/flags', headers: bearer(WRITE_KEY), payload: { key: 'Checkout', kind: 'boolean' } })).statusCode, 400);
  res = await app.inject({ method: 'POST', url: '/v1/flags', headers: bearer(WRITE_KEY), payload: { key: 'limit', kind: 'number', value: 'ten' } });
  assert.equal(json(res).error.code, 'INVALID_VALUE');

  res = await app.inject({ method: 'PATCH', url: '/v1/flags/checkout.new/envs/staging', headers: bearer(RW_KEY), payload: { enabled: true, percentage: 25, rules: [{ id: 'team', name: 'Team', match: { emails: ['dev@x.com'] }, value: true }] } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(json(res).state.version, 2);
  assert.equal(json(res).state.rules[0].id, 'team');
  res = await app.inject({ method: 'PATCH', url: '/v1/flags/checkout.new/envs/staging', headers: bearer(RW_KEY), payload: { rules: [{ id: 'x', match: {}, value: true }] } });
  assert.equal(json(res).error.code, 'INVALID_RULE');
  res = await app.inject({ method: 'PATCH', url: '/v1/flags/checkout.new/envs/staging', headers: bearer(RW_KEY), payload: { percentage: 101 } });
  assert.equal(json(res).error.code, 'VALIDATION_FAILED');
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/flags/checkout.new/envs/staging', headers: bearer(PROD_KEY), payload: { enabled: true } })).statusCode, 403);

  res = await app.inject({ method: 'POST', url: '/v1/flags/checkout.new/envs/staging/copy', headers: bearer(RW_KEY), payload: { to: 'prod' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(json(res).env, 'prod');
  assert.equal(json(res).state.percentage, 25);
  res = await app.inject({ url: '/v1/flags/checkout.new/envs/prod', headers: bearer(PROD_KEY) });
  assert.equal(json(res).state.enabled, true);
  res = await app.inject({ url: '/v1/flags/checkout.new', headers: bearer(PROD_KEY) });
  assert.deepEqual(Object.keys(json(res).flag.environments), ['prod'], 'scoped key sees one environment on the flag');

  res = await app.inject({ method: 'PATCH', url: '/v1/flags/checkout.new', headers: bearer(RW_KEY), payload: { tags: ['checkout', 'q4'], archived: true } });
  assert.deepEqual(json(res).flag.tags, ['checkout', 'q4']);
  assert.equal(json(res).flag.archived, true);
  res = await app.inject({ url: '/v1/flags?archived=true', headers: bearer(READ_KEY) });
  assert.equal(json(res).items.length, 1);
  res = await app.inject({ url: '/v1/flags/checkout.new/history', headers: bearer(READ_KEY) });
  assert.deepEqual(json(res).items.map((/** @type {any} */ h) => h.action), ['flag.update', 'env.copy', 'env.update', 'flag.create']);
  assert.equal(json(res).items[1].env, 'prod');
  assert.equal(json(res).items[1].after.from, 'staging');
  res = await app.inject({ url: '/v1/history?limit=2', headers: bearer(READ_KEY) });
  assert.equal(json(res).items.length, 2);
  assert.ok(json(res).nextBefore);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/flags/checkout.new', headers: bearer(PROD_KEY) })).statusCode, 403, 'scoped keys cannot delete');
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/flags/checkout.new', headers: bearer(RW_KEY) })).statusCode, 204);
  assert.equal((await app.inject({ url: '/v1/flags/checkout.new', headers: bearer(READ_KEY) })).statusCode, 404);
});

test('API: evaluate (GET and POST), details, snapshot with ETag, stats, metrics', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  const post = (/** @type {object} */ payload) => app.inject({ method: 'POST', url: '/v1/flags', headers: bearer(RW_KEY), payload });
  await post({ key: 'checkout.new', kind: 'boolean', enabled: true });
  await post({ key: 'banner.text', kind: 'string', value: 'Summer sale', offValue: '', enabled: true });
  await post({ key: 'search.limit', kind: 'number', value: 50, offValue: 10 });
  await post({ key: 'theme', kind: 'json', value: { primary: '#38bdf8' }, offValue: null, enabled: true });
  await app.inject({ method: 'PATCH', url: '/v1/flags/checkout.new/envs/prod', headers: bearer(RW_KEY), payload: { percentage: 0, rules: [{ id: 'beta', match: { attrs: { plan: ['beta'] } }, value: true }] } });

  let res = await app.inject({ url: '/v1/evaluate?env=prod&userId=u1&attrs.plan=beta', headers: bearer(PROD_KEY) });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(json(res), { env: 'prod', version: 5, flags: { 'banner.text': 'Summer sale', 'checkout.new': true, 'search.limit': 10, theme: { primary: '#38bdf8' } } });
  assert.equal(res.headers['x-flags-version'], '5');
  res = await app.inject({ method: 'POST', url: '/v1/evaluate', headers: bearer(READ_KEY), payload: { env: 'prod', context: { userId: 'u2', attrs: { plan: 'free' } }, keys: ['checkout.new', 'nope'], details: true } });
  assert.deepEqual(json(res).flags, { 'checkout.new': { value: false, reason: 'excluded' }, nope: { value: null, reason: 'missing' } });
  res = await app.inject({ method: 'POST', url: '/v1/evaluate', headers: bearer(READ_KEY), payload: { env: 'prod', context: { attrs: { 'bad key': 'x' } } } });
  assert.equal(res.statusCode, 400);

  res = await app.inject({ url: '/v1/snapshot/prod', headers: bearer(PROD_KEY) });
  assert.equal(res.statusCode, 200);
  const etag = String(res.headers.etag);
  assert.equal(etag, '"prod-5"');
  assert.equal(json(res).flags['checkout.new'].rules.length, 1);
  assert.equal((await app.inject({ url: '/v1/snapshot/prod', headers: { ...bearer(PROD_KEY), 'if-none-match': etag } })).statusCode, 304);
  await app.inject({ method: 'PATCH', url: '/v1/flags/search.limit/envs/prod', headers: bearer(RW_KEY), payload: { enabled: true } });
  res = await app.inject({ url: '/v1/snapshot/prod', headers: { ...bearer(PROD_KEY), 'if-none-match': etag } });
  assert.equal(res.statusCode, 200, 'a change invalidates the ETag');
  assert.equal(res.headers.etag, '"prod-6"');
  assert.equal((await app.inject({ url: '/v1/snapshot/staging', headers: bearer(PROD_KEY) })).statusCode, 403);

  res = await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) });
  assert.deepEqual(json(res).flags, { total: 4, archived: 0 });
  const prod = json(res).environments.find((/** @type {any} */ e) => e.env === 'prod');
  assert.equal(prod.enabled, 4);
  assert.equal(prod.evaluations, 2, 'the rejected request is not an evaluation');
  const m = await app.inject({ url: '/metrics', headers: bearer(READ_KEY) });
  assert.match(m.body, /flags_total\{state="active"\} 4/);
  assert.match(m.body, /flags_enabled\{env="prod"\} 4/);
  assert.match(m.body, /flags_evaluations_total\{env="prod"\} 2/);
  assert.match(m.body, /flags_env_version\{env="prod"\} 6/);
});

test('API: list filters, cursor, validation, rate limit', async (t) => {
  const { app } = await buildApp({ RATE_LIMIT_MAX: '30' });
  t.after(() => app.close());
  for (const k of ['a.one', 'b.two', 'c.three']) await app.inject({ method: 'POST', url: '/v1/flags', headers: bearer(RW_KEY), payload: { key: k, kind: 'boolean', tags: k === 'b.two' ? ['x'] : [] } });
  let res = await app.inject({ url: '/v1/flags?limit=2', headers: bearer(READ_KEY) });
  assert.deepEqual(json(res).items.map((/** @type {any} */ f) => f.key), ['a.one', 'b.two']);
  assert.equal(json(res).nextCursor, 'b.two');
  res = await app.inject({ url: '/v1/flags?limit=2&cursor=b.two', headers: bearer(READ_KEY) });
  assert.deepEqual(json(res).items.map((/** @type {any} */ f) => f.key), ['c.three']);
  assert.equal((await app.inject({ url: '/v1/flags?tag=x', headers: bearer(READ_KEY) })).json().items.length, 1);
  assert.equal((await app.inject({ url: '/v1/flags?q=three', headers: bearer(READ_KEY) })).json().items.length, 1);
  assert.equal((await app.inject({ url: '/v1/flags?limit=999', headers: bearer(READ_KEY) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/flags/a.one', headers: bearer(RW_KEY), payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/flags/a.one', headers: bearer(RW_KEY), payload: { extra: 1 } })).statusCode, 400);
  for (let i = 0; i < 30; i++) await app.inject({ url: '/v1/environments', headers: bearer(WRITE_KEY) });
  const limited = await app.inject({ url: '/v1/environments', headers: bearer(WRITE_KEY) });
  assert.equal(limited.statusCode, 429);
  assert.equal(json(limited).error.code, 'RATE_LIMITED');
  assert.equal((await app.inject({ url: '/v1/environments', headers: bearer(READ_KEY) })).statusCode, 200);
});

test('Maintenance: purges old history rows only', async (t) => {
  const { app, history, flags } = await buildApp();
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/flags', headers: bearer(RW_KEY), payload: { key: 'keep.me', kind: 'boolean' } });
  const day = 86_400_000;
  const now = Date.now();
  history.record({ key: 'keep.me', action: 'env.update', actor: 'old' }, now - 400 * day);
  const m = new Maintenance({ history, log: /** @type {any} */ ({ info() {}, error() {} }), options: { historyRetentionDays: 365 } });
  assert.equal(m.run(now), 1);
  assert.equal(history.list('keep.me', { limit: 10 }).length, 1);
  assert.ok(flags.flag('keep.me'));
  m.start(); m.stop();
  assert.equal(m.timer, null);
});
