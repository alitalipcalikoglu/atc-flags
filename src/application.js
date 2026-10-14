import { Config } from './config.js';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { Lifecycle } from '@atc-web/atc-service-core/lifecycle';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Database } from './db.js';
import { FlagService } from './domain/flag-service.js';
import { ValueCheck } from './domain/value-check.js';
import { FlagsApi } from './http/flags-api.js';
import { Maintenance } from './maintenance.js';
import { FlagStore } from './store/flag-store.js';
import { HistoryStore } from './store/history-store.js';
import { EventPublisher } from './events/event-publisher.js';

/**
 * Composition root: wires configuration, storage, domain, HTTP and maintenance, and owns the
 * process lifecycle.
 */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.version = readServiceVersion(import.meta.url);
    this.audit = new AuditClient({ target: config.audit });
    this.publisher = new EventPublisher({ source: 'atc-flags', target: config.webhookOut });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.flags = new FlagStore(this.db);
    this.history = new HistoryStore(this.db);
    this.service = new FlagService({ db: this.db, flags: this.flags, history: this.history, check: new ValueCheck(config.maxValueBytes), environments: config.environments, publisher: this.publisher });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {Maintenance|null} */
    this.maintenance = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const api = new FlagsApi({ config, audit: this.audit, publisher: this.publisher, service: this.service, flags: this.flags, history: this.history, db: this.db, version: this.version });
    const app = await api.build();
    this.app = app;
    this.maintenance = new Maintenance({ history: this.history, log: app.log.child({ component: 'maintenance' }), options: { historyRetentionDays: config.historyRetentionDays } });
    const { shutdown } = Lifecycle.install({
      forceExitMs: 30_000,
      log: app.log,
      steps: [
        () => this.maintenance?.stop(),
        () => this.app?.close(),
        () => this.publisher.close(),
        () => this.audit.close(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.publisher.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, environments: config.environments, flags: this.flags.counts().total }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    this.maintenance.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

}
