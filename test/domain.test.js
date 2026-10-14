import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlagError } from '../src/domain/errors.js';
import { Evaluator } from '../src/domain/evaluator.js';
import { ValueCheck } from '../src/domain/value-check.js';
import { testService } from './helpers.js';

test('Evaluator: order of decisions and stable buckets', () => {
  /** @type {import('../src/types.js').EnvState} */
  const base = { enabled: true, value: 'on', offValue: 'off', percentage: 100, rules: [{ id: 'vip', match: { emails: ['vip@x.com'] }, value: 'vip' }, { id: 'pro', match: { attrs: { plan: ['pro', 'team'] } }, value: 'pro' }] };
  assert.deepEqual(Evaluator.evaluate({ ...base, enabled: false }, 's', { userId: 'u' }), { value: 'off', reason: 'disabled' });
  assert.deepEqual(Evaluator.evaluate(base, 's', { email: 'VIP@x.com' }), { value: 'vip', reason: 'rule', ruleId: 'vip' });
  assert.deepEqual(Evaluator.evaluate(base, 's', { userId: 'u', attrs: { plan: 'team' } }), { value: 'pro', reason: 'rule', ruleId: 'pro' });
  assert.deepEqual(Evaluator.evaluate(base, 's', { userId: 'u', attrs: { plan: 'free' } }), { value: 'on', reason: 'default' });
  assert.deepEqual(Evaluator.evaluate({ ...base, percentage: 50 }, 's', {}), { value: 'off', reason: 'excluded' }, 'anonymous contexts sit outside partial rollouts');
  assert.deepEqual(Evaluator.evaluate({ ...base, percentage: 0 }, 's', { userId: 'u' }), { value: 'off', reason: 'excluded' });
  let inside = 0;
  for (let i = 0; i < 2000; i++) if (Evaluator.evaluate({ ...base, percentage: 30 }, 'salt', { userId: `user-${i}` }).reason === 'rollout') inside++;
  assert.ok(inside > 500 && inside < 700, `30% rollout hit ${inside}/2000`);
  const at30 = Array.from({ length: 300 }, (_, i) => Evaluator.evaluate({ ...base, percentage: 30 }, 'salt', { userId: `u${i}` }).reason === 'rollout');
  const at60 = Array.from({ length: 300 }, (_, i) => Evaluator.evaluate({ ...base, percentage: 60 }, 'salt', { userId: `u${i}` }).reason === 'rollout');
  assert.ok(at30.every((v, i) => !v || at60[i]), 'raising the percentage never removes a user');
  assert.notEqual(Evaluator.bucket('a', 'u1'), Evaluator.bucket('b', 'u1'), 'salt reshuffles');
  assert.equal(Evaluator.matches({ id: 'x', match: {}, value: 1 }, { userId: 'u' }), false, 'empty match never matches');
});

test('ValueCheck: kinds, sizes and rule normalisation', () => {
  const c = new ValueCheck(64);
  assert.equal(c.value('boolean', true, 'v'), true);
  assert.equal(c.value('number', 1.5, 'v'), 1.5);
  assert.deepEqual(c.value('json', { a: 1 }, 'v'), { a: 1 });
  const err = (/** @type {() => unknown} */ fn, /** @type {string} */ code) => assert.throws(fn, (e) => e instanceof FlagError && e.code === code, code);
  err(() => c.value('boolean', 'yes', 'v'), 'INVALID_VALUE');
  err(() => c.value('number', NaN, 'v'), 'INVALID_VALUE');
  err(() => c.value('string', 'x'.repeat(100), 'v'), 'VALUE_TOO_LARGE');
  const rules = c.rules('string', [{ id: 'a', name: 'A', match: { emails: ['X@Y.com', 'x@y.com'], userIds: ['1'] }, value: 'v' }]);
  assert.deepEqual(rules, [{ id: 'a', name: 'A', match: { emails: ['x@y.com'], userIds: ['1'] }, value: 'v' }]);
  err(() => c.rules('string', [{ id: 'a', match: { emails: ['a'] }, value: 'v' }, { id: 'a', match: { emails: ['b'] }, value: 'v' }]), 'INVALID_RULE');
  err(() => c.rules('string', [{ id: 'Bad Id', match: { emails: ['a'] }, value: 'v' }]), 'INVALID_RULE');
  err(() => c.rules('string', [{ id: 'a', match: {}, value: 'v' }]), 'INVALID_RULE');
  err(() => c.rules('string', [{ id: 'a', match: { attrs: { 'bad key!': ['x'] } }, value: 'v' }]), 'INVALID_RULE');
  err(() => c.rules('boolean', [{ id: 'a', match: { userIds: ['1'] }, value: 'v' }]), 'INVALID_VALUE');
});

test('FlagService: create, defaults per environment, update, history, delete', () => {
  const { service, flags, history } = testService();
  const now = 1_700_000_000_000;
  const f = service.create({ key: 'checkout.new', kind: 'boolean', description: 'New checkout', tags: ['Checkout', 'ui'] }, 'console', now);
  assert.equal(f.tags, '["checkout","ui"]');
  const envs = flags.envsOf('checkout.new');
  assert.deepEqual(envs.map((e) => [e.env, e.enabled, e.value, e.off_value, e.percentage, e.version]), [['dev', 0, 'true', 'false', 100, 1], ['prod', 0, 'true', 'false', 100, 1], ['staging', 0, 'true', 'false', 100, 1]]);
  assert.equal(flags.version('prod'), 1);
  const err = (/** @type {() => unknown} */ fn, /** @type {string} */ code) => assert.throws(fn, (e) => e instanceof FlagError && e.code === code, code);
  err(() => service.create({ key: 'checkout.new', kind: 'boolean' }, 'console', now), 'FLAG_EXISTS');
  err(() => service.create({ key: 'Bad', kind: 'boolean' }, 'console', now), 'INVALID_VALUE');
  err(() => service.create({ key: 'limit', kind: 'number', value: 'x' }, 'console', now), 'INVALID_VALUE');
  service.create({ key: 'limit', kind: 'number', value: 10, offValue: 5, enabled: true }, 'console', now);
  assert.equal(flags.env('limit', 'dev')?.value, '10');
  assert.equal(flags.env('limit', 'dev')?.enabled, 1);

  service.update('checkout.new', { description: 'v2', archived: true }, 'console', now + 1);
  assert.equal(service.get('checkout.new').archived, 1);
  assert.equal(flags.version('prod'), 3, 'archive bumps every environment');
  const salt = service.get('checkout.new').rollout_salt;
  service.update('checkout.new', { reshuffle: true }, 'console', now + 2);
  assert.notEqual(service.get('checkout.new').rollout_salt, salt);
  service.remove('limit', 'console', now + 3);
  err(() => service.get('limit'), 'FLAG_NOT_FOUND');
  assert.equal(flags.envsOf('limit').length, 0, 'states cascade');
  const h = history.list('checkout.new', { limit: 10 });
  assert.deepEqual(h.map((x) => x.action), ['flag.update', 'flag.update', 'flag.create']);
  assert.equal(history.list(null, { limit: 10 })[0].action, 'flag.delete');
});

test('FlagService: environment state, copy, evaluate with cache, snapshot', () => {
  const { service, flags } = testService();
  const now = 1_700_000_000_000;
  service.create({ key: 'banner', kind: 'string', value: 'summer', offValue: '' }, 'console', now);
  const st = service.updateEnv('banner', 'staging', { enabled: true, percentage: 40, rules: [{ id: 'team', match: { emails: ['me@x.com'] }, value: 'team-banner' }] }, 'console', now + 1);
  assert.equal(st.version, 2);
  assert.equal(flags.version('staging'), 2);
  const err = (/** @type {() => unknown} */ fn, /** @type {string} */ code) => assert.throws(fn, (e) => e instanceof FlagError && e.code === code, code);
  err(() => service.updateEnv('banner', 'qa', { enabled: true }, 'console'), 'UNKNOWN_ENV');
  err(() => service.updateEnv('banner', 'staging', { value: 5 }, 'console'), 'INVALID_VALUE');
  err(() => service.updateEnv('nope', 'staging', { enabled: true }, 'console'), 'FLAG_NOT_FOUND');

  let r = service.evaluate('staging', { email: 'me@x.com' });
  assert.equal(r.version, 2);
  assert.deepEqual(r.results.banner, { value: 'team-banner', reason: 'rule', ruleId: 'team' });
  assert.deepEqual(service.evaluate('staging', {}).results.banner, { value: '', reason: 'excluded' });
  assert.deepEqual(service.evaluate('prod', { userId: 'u1' }).results.banner, { value: '', reason: 'disabled' });
  assert.deepEqual(service.evaluate('prod', { userId: 'u1' }, ['banner', 'missing']).results.missing, { value: null, reason: 'missing' });
  assert.equal(service.evaluations.get('staging'), 2);

  const copied = service.copyEnv('banner', 'staging', 'prod', 'console', now + 2);
  assert.equal(copied.enabled, 1);
  assert.equal(copied.percentage, 40);
  assert.equal(flags.version('prod'), 2);
  assert.deepEqual(service.evaluate('prod', { email: 'me@x.com' }).results.banner, { value: 'team-banner', reason: 'rule', ruleId: 'team' }, 'cache invalidated by version');

  const snap = service.snapshot('prod');
  assert.equal(snap.version, 2);
  assert.equal(snap.flags.banner.kind, 'string');
  assert.equal(snap.flags.banner.rules.length, 1);
  assert.equal(typeof snap.flags.banner.salt, 'string');
  service.update('banner', { archived: true }, 'console', now + 3);
  assert.deepEqual(service.snapshot('prod').flags, {}, 'archived flags leave the snapshot');
  assert.deepEqual(service.evaluate('prod', {}, ['banner']).results.banner, { value: null, reason: 'missing' });

  service.create({ key: 'b.one', kind: 'boolean' }, 'console', now);
  service.create({ key: 'a.two', kind: 'boolean', tags: ['x'] }, 'console', now);
  let page = service.list({}, { limit: 2 });
  assert.deepEqual(page.items.map((f) => f.key), ['a.two', 'b.one']);
  page = service.list({}, { limit: 2, cursor: /** @type {string} */ (page.nextCursor) });
  assert.deepEqual(page.items.map((f) => f.key), ['banner']);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(service.list({ tag: 'x' }, { limit: 10 }).items.map((f) => f.key), ['a.two']);
  assert.deepEqual(service.list({ archived: true }, { limit: 10 }).items.map((f) => f.key), ['banner']);
  assert.deepEqual(service.list({ q: 'two' }, { limit: 10 }).items.map((f) => f.key), ['a.two']);
  err(() => service.list({}, { limit: 1, cursor: 'Bad!' }), 'INVALID_CURSOR');
});

test('FlagService: every change is published as flag.changed without values; failed changes publish nothing', () => {
  /** @type {any[]} */ const out = [];
  const { service } = testService(undefined, { publish: (/** @type {string} */ t, /** @type {any} */ d) => out.push([t, d]) });
  service.create({ key: 'a.b', kind: 'boolean' }, 'console', 1);
  service.updateEnv('a.b', 'prod', { enabled: true, percentage: 25 }, 'console', 2);
  service.copyEnv('a.b', 'prod', 'staging', 'console', 3);
  service.update('a.b', { description: 'x' }, 'console', 4);
  service.remove('a.b', 'console', 5);
  assert.throws(() => service.updateEnv('missing', 'prod', { enabled: true }, 'console', 6));
  assert.deepEqual(out, [
    ['flag.changed', { key: 'a.b', env: null, action: 'flag.create', actor: 'console' }],
    ['flag.changed', { key: 'a.b', env: 'prod', action: 'env.update', actor: 'console', enabled: true, percentage: 25 }],
    ['flag.changed', { key: 'a.b', env: 'staging', action: 'env.copy', actor: 'console', enabled: true, percentage: 25 }],
    ['flag.changed', { key: 'a.b', env: null, action: 'flag.update', actor: 'console' }],
    ['flag.changed', { key: 'a.b', env: null, action: 'flag.delete', actor: 'console' }],
  ]);
});

test('evaluation counts are lifetime counters: flushed to the database, added to what is in memory, never lost on a flush', () => {
  const { service, flags } = testService();
  service.create({ key: 'count.me', kind: 'boolean' }, 'console', 1);
  for (let i = 0; i < 3; i += 1) service.evaluate('prod', {});
  assert.deepEqual([service.evaluationTotal('prod'), flags.evaluationsOf('prod')], [3, 0], 'in memory until the flush');
  service.flushEvaluations();
  service.evaluate('prod', {});
  assert.deepEqual([service.evaluationTotal('prod'), flags.evaluationsOf('prod'), service.evaluationTotal('dev')], [4, 3, 0]);
  service.flushEvaluations();
  service.flushEvaluations();
  assert.equal(flags.evaluationsOf('prod'), 4, 'an empty flush changes nothing');
});
