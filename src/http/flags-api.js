import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { createErrorHandler, registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { FlagError } from '../domain/errors.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';
import { AuditMetrics } from '../audit-metrics.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('../domain/flag-service.js').FlagService} FlagService */
/** @typedef {import('../types.js').Context} Context */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */
/** @typedef {import('fastify').FastifyReply} FastifyReply */

/**
 * HTTP surface: management of flags (write role) and evaluation/snapshots (read role). Keys may
 * be scoped to environments; a scoped key never sees another environment's state.
 */
export class FlagsApi {
  static READY_CACHE_MS = 10_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {FlagService} deps.service
   * @param {import('../store/flag-store.js').FlagStore} deps.flags
   * @param {import('../store/history-store.js').HistoryStore} deps.history
   * @param {import('../db.js').Database} deps.db
   * @param {string} deps.version
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('@atc-web/atc-service-core/audit').AuditClient} [deps.audit]
   * @param {import('../events/event-publisher.js').EventPublisher} [deps.publisher]
   */
  constructor({ config, audit, publisher, service, flags, history, db, version, logger }) {
    this.config = config;
    this.audit = audit;
    this.publisher = publisher ?? null;
    this.service = service;
    this.flags = flags;
    this.history = history;
    this.db = db;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      ...requestOptions({ logger: this.logger, logLevel: config.logLevel }),
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerRequestContext(app, { trustProxy: config.trustProxy });
    app.decorateRequest('apiKey', /** @type {any} */ (null));
    app.setErrorHandler(createErrorHandler(FlagError));
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    });
    registerProbes(app, () => this.db.ping(), { cacheMs: FlagsApi.READY_CACHE_MS });
    registerOpenApi(app, new URL('../../openapi.yaml', import.meta.url));
    registerInfo(app, {
      service: 'atc-flags',
      version: this.version,
      capabilities: ['percentage-rollout', 'targeting-rules', 'snapshot-etag'],
      schemaVersion: this.db.schemaVersion,
    });
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }


  /**
   * Environments a request may see: the key's scope intersected with what exists.
   * @param {FastifyRequest} request
   */
  #visibleEnvs(request) {
    const scope = request.apiKey.envs;
    return scope ? this.config.environments.filter((e) => scope.includes(e)) : this.config.environments;
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey.id,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const read = { preHandler: ApiKeyAuth.require('read') };
    const write = { preHandler: ApiKeyAuth.require('write') };
    const key = (/** @type {FastifyRequest} */ r) => /** @type {{ key: string }} */ (r.params).key;
    const env = (/** @type {FastifyRequest} */ r) => { const e = /** @type {{ env: string }} */ (r.params).env; s.assertEnv(e); ApiKeyAuth.assertEnv(r.apiKey, e); return e; };
    const actor = (/** @type {FastifyRequest} */ r) => r.apiKey.id;
    const full = (/** @type {FastifyRequest} */ r, /** @type {string} */ k) => Views.flag(s.get(k), this.flags.envsOf(k).filter((e) => this.#visibleEnvs(r).includes(e.env)));

    api.get('/environments', read, async (request) => ({ items: this.#visibleEnvs(request).map((e) => ({ env: e, version: this.flags.version(e) })) }));

    // ---- flags
    api.post('/flags', { config: { audit: AuditClient.route('atc-flags.flag.create', (_r, b) => ({ type: 'flag', id: b.flag.key })) }, ...write, schema: { body: Schemas.create } }, async (request, reply) => {
      const row = s.create(/** @type {any} */ (request.body), actor(request));
      reply.header('location', `/v1/flags/${row.key}`);
      return reply.code(201).send({ flag: full(request, row.key) });
    });

    api.get('/flags', { ...read, schema: { querystring: Schemas.listQuery } }, async (request) => {
      const q = /** @type {Record<string, string|undefined>} */ (request.query);
      const { items, nextCursor } = s.list({ q: q.q, tag: q.tag, kind: q.kind, archived: q.archived === undefined ? undefined : q.archived === 'true' }, { limit: q.limit ? Number(q.limit) : 50, cursor: q.cursor });
      const visible = this.#visibleEnvs(request);
      return { items: items.map((f) => Views.flag(f, this.flags.envsOf(f.key).filter((e) => visible.includes(e.env)))), nextCursor };
    });

    api.get('/flags/:key', { ...read, schema: { params: Schemas.keyParams } }, async (request) => ({ flag: full(request, key(request)) }));

    api.patch('/flags/:key', { config: { audit: AuditClient.route('atc-flags.flag.update', (r) => ({ type: 'flag', id: /** @type {any} */ (r.params).key }), (r) => ({ patch: r.body })) }, ...write, schema: { params: Schemas.keyParams, body: Schemas.patchFlag } }, async (request) => {
      s.update(key(request), /** @type {any} */ (request.body), actor(request));
      return { flag: full(request, key(request)) };
    });

    api.delete('/flags/:key', { config: { audit: AuditClient.route('atc-flags.flag.delete', (r) => ({ type: 'flag', id: /** @type {any} */ (r.params).key })) }, ...write, schema: { params: Schemas.keyParams } }, async (request, reply) => {
      if (request.apiKey.envs) throw new FlagError('FORBIDDEN', 'an environment-scoped key cannot delete flags');
      s.remove(key(request), actor(request));
      return reply.code(204).send();
    });

    api.get('/flags/:key/history', { ...read, schema: { params: Schemas.keyParams, querystring: Schemas.historyQuery } }, async (request) => {
      s.get(key(request));
      return this.#history(key(request), /** @type {any} */ (request.query));
    });

    api.get('/history', { ...read, schema: { querystring: Schemas.historyQuery } }, async (request) => this.#history(null, /** @type {any} */ (request.query)));

    // ---- environment state
    api.get('/flags/:key/envs/:env', { ...read, schema: { params: Schemas.keyEnvParams } }, async (request) => ({ env: env(request), state: Views.env(s.envState(key(request), env(request))) }));

    api.patch('/flags/:key/envs/:env', { config: { audit: AuditClient.route('atc-flags.env.update', (r) => ({ type: 'flag', id: /** @type {any} */ (r.params).key }), (r) => ({ env: /** @type {any} */ (r.params).env, patch: r.body })) }, ...write, schema: { params: Schemas.keyEnvParams, body: Schemas.patchEnv } }, async (request) => ({
      env: env(request), state: Views.env(s.updateEnv(key(request), env(request), /** @type {any} */ (request.body), actor(request))),
    }));

    api.post('/flags/:key/envs/:env/copy', { config: { audit: AuditClient.route('atc-flags.env.copy', (r) => ({ type: 'flag', id: /** @type {any} */ (r.params).key }), (r) => ({ env: /** @type {any} */ (r.params).env, ...(/** @type {object} */ (r.body ?? {})) })) }, ...write, schema: { params: Schemas.keyEnvParams, body: Schemas.copyEnv } }, async (request) => {
      const to = /** @type {{ to: string }} */ (request.body).to;
      s.assertEnv(to);
      ApiKeyAuth.assertEnv(request.apiKey, to);
      return { env: to, state: Views.env(s.copyEnv(key(request), env(request), to, actor(request))) };
    });

    // ---- evaluation
    api.post('/evaluate', { ...read, schema: { body: Schemas.evaluateBody } }, async (request, reply) => {
      const b = /** @type {{ env: string, context?: Context, keys?: string[], details?: boolean }} */ (request.body);
      return this.#evaluate(reply, request, b.env, b.context ?? {}, b.keys, b.details === true);
    });

    api.get('/evaluate', { ...read, schema: { querystring: Schemas.evaluateQuery } }, async (request, reply) => {
      const q = /** @type {Record<string, string|undefined>} */ (request.query);
      /** @type {Context} */
      const ctx = {};
      if (q.userId) ctx.userId = q.userId;
      if (q.email) ctx.email = q.email;
      for (const [k, v] of Object.entries(q)) if (k.startsWith('attrs.') && v !== undefined) (ctx.attrs ??= {})[k.slice(6)] = v;
      return this.#evaluate(reply, request, /** @type {string} */ (q.env), ctx, q.keys ? q.keys.split(',').filter(Boolean) : undefined, q.details === 'true');
    });

    api.get('/snapshot/:env', { ...read, schema: { params: Schemas.envParams } }, async (request, reply) => {
      const e = env(request);
      const snap = s.snapshot(e);
      const etag = `"${e}-${snap.version}"`;
      reply.header('etag', etag).header('cache-control', 'private, max-age=0, must-revalidate');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return snap;
    });

    api.get('/stats', read, async (request) => {
      const c = this.flags.counts();
      const visible = this.#visibleEnvs(request);
      return {
        flags: { total: c.total, archived: c.archived },
        environments: visible.map((e) => ({ env: e, version: this.flags.version(e), enabled: c.byEnv.find((x) => x.env === e)?.enabled ?? 0, evaluations: s.evaluationTotal(e) })),
      };
    });
  }

  /**
   * @param {FastifyReply} reply
   * @param {FastifyRequest} request
   * @param {string} env
   * @param {Context} ctx
   * @param {string[]|undefined} keys
   * @param {boolean} details
   */
  #evaluate(reply, request, env, ctx, keys, details) {
    this.service.assertEnv(env);
    ApiKeyAuth.assertEnv(request.apiKey, env);
    const { version, results } = this.service.evaluate(env, ctx, keys);
    reply.header('x-flags-version', String(version));
    if (details) return { env, version, flags: results };
    return { env, version, flags: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.value])) };
  }

  /**
   * @param {string|null} key
   * @param {{ limit?: string, before?: string }} q
   */
  #history(key, q) {
    const limit = q.limit ? Number(q.limit) : 50;
    const rows = this.history.list(key, { limit: limit + 1, beforeId: q.before ? Number(q.before) : undefined });
    const items = rows.slice(0, limit);
    return { items: items.map(Views.history), nextBefore: rows.length > limit ? String(items.at(-1)?.id) : null };
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preHandler: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const c = this.flags.counts();
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP flags_total Flags, by archive state.',
        '# TYPE flags_total gauge',
        `flags_total{state="active"} ${c.total - c.archived}`,
        `flags_total{state="archived"} ${c.archived}`,
        '# HELP flags_enabled Enabled flags per environment.',
        '# TYPE flags_enabled gauge',
        ...c.byEnv.map((e) => `flags_enabled{env="${e.env}"} ${e.enabled}`),
        '# HELP flags_env_version Change counter per environment.',
        '# TYPE flags_env_version gauge',
        ...this.config.environments.map((e) => `flags_env_version{env="${e}"} ${this.flags.version(e)}`),
        '# HELP flags_evaluations_total Evaluation requests over the lifetime of the database, per environment.',
        '# TYPE flags_evaluations_total counter',
        ...this.config.environments.map((e) => `flags_evaluations_total{env="${e}"} ${this.service.evaluationTotal(e)}`),
        ...AuditMetrics.lines(this.audit),
        ...(this.publisher?.metricLines() ?? []),
        '# HELP flags_process_uptime_seconds Process uptime.',
        '# TYPE flags_process_uptime_seconds gauge',
        `flags_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
