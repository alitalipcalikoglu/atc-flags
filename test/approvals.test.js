import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RW_KEY, bearer, buildApp } from './helpers.js';

test('two-person rule: prod changes wait for another person; self-approval, stale and closed requests are refused', async (t) => {
  const { app } = await buildApp({ PROTECTED_ENVS: 'prod', ACTOR_KEYS: 'console' });
  t.after(() => app.close());
  const as = (/** @type {string} */ person) => ({ ...bearer(RW_KEY), 'x-actor': person, 'content-type': 'application/json' });
  const call = (/** @type {string} */ method, /** @type {string} */ url, /** @type {any} */ payload, person = 'ada') => app.inject({ method: /** @type {any} */ (method), url, payload, headers: as(person) });
  assert.equal((await call('POST', '/v1/flags', { key: 'checkout.new', kind: 'boolean' })).statusCode, 201);
  // staging is not protected: applied at once
  assert.equal((await call('PATCH', '/v1/flags/checkout.new/envs/staging', { enabled: true })).statusCode, 200);
  // prod is protected: a request
  let res = await call('PATCH', '/v1/flags/checkout.new/envs/prod', { enabled: true, percentage: 10 });
  assert.equal(res.statusCode, 202, res.body);
  const req = res.json().change;
  assert.deepEqual([req.status, req.env, req.kind, req.payload.percentage], ['pending', 'prod', 'update', 10]);
  assert.equal((await call('GET', '/v1/flags/checkout.new/envs/prod')).json().state.enabled, false, 'nothing changed yet');
  assert.equal((await call('PATCH', '/v1/flags/checkout.new/envs/prod', { value: 'not a boolean' })).statusCode, 400, 'requests are validated up front');
  res = await call('POST', `/v1/changes/${req.id}/approve`, {}, 'ada');
  assert.deepEqual([res.statusCode, res.json().error.code], [403, 'SELF_APPROVAL']);
  res = await call('POST', `/v1/changes/${req.id}/approve`, {}, 'grace');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual([res.json().change.status, res.json().change.decidedBy, res.json().state.enabled, res.json().state.percentage], ['approved', 'console/grace', true, 10]);
  assert.equal((await call('POST', `/v1/changes/${req.id}/approve`, {}, 'grace')).json().error.code, 'CHANGE_CLOSED');
  // a copy into prod is a request too; a request whose environment changed meanwhile is stale
  const copy = (await call('POST', '/v1/flags/checkout.new/envs/staging/copy', { to: 'prod' })).json().change;
  const other = (await call('PATCH', '/v1/flags/checkout.new/envs/prod', { percentage: 50 })).json().change;
  assert.equal((await call('POST', `/v1/changes/${other.id}/approve`, {}, 'grace')).statusCode, 200);
  res = await call('POST', `/v1/changes/${copy.id}/approve`, {}, 'grace');
  assert.deepEqual([res.statusCode, res.json().error.code], [409, 'CHANGE_STALE']);
  // rejecting (or withdrawing one's own)
  const third = (await call('PATCH', '/v1/flags/checkout.new/envs/prod', { enabled: false })).json().change;
  res = await call('POST', `/v1/changes/${third.id}/reject`, { note: 'not now' }, 'ada');
  assert.deepEqual([res.json().change.status, res.json().change.note], ['rejected', 'not now']);
  res = await call('GET', '/v1/changes?status=pending');
  assert.deepEqual([res.json().items.length, res.json().protectedEnvs], [0, ['prod']]);
  const history = (await call('GET', '/v1/flags/checkout.new/history')).json().items.map((/** @type {any} */ h) => h.action);
  assert.ok(history.includes('change.requested') && history.includes('change.rejected'));
});
