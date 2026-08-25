import { Hono } from 'hono';
import type { Context } from 'hono';
import type { RequestDeps } from '../config.js';
import { docsRoutes } from '../docs.js';
import { sdkIntegrationRoutes } from '../integrations/sdk-routes.js';
import { observe, type HonoEnv, type Logger } from '../observe.js';
import { renderPanic } from './kernel.js';
import { appsRoutes } from './routes/apps.js';
import { authRoutes } from './routes/auth.js';
import { deployRoutes } from './routes/deploy.js';
import { deviceRoutes } from './routes/device.js';
import { integrationRoutes } from './routes/integrations.js';
import { secretsRoutes } from './routes/secrets.js';
import { sharingRoutes } from './routes/sharing.js';

export { MAX_BLOB_BYTES } from './routes/deploy.js';

export interface ServerConfig {
  buildDeps: (c: Context<HonoEnv>) => RequestDeps | Promise<RequestDeps>;
  logger?: Logger;
}

const SILENT: Logger = {
  info() {},
  warn() {},
  error() {},
};

export class Server {
  private readonly buildDeps: ServerConfig['buildDeps'];
  private readonly log?: Logger;

  constructor(cfg: ServerConfig) {
    this.buildDeps = cfg.buildDeps;
    this.log = cfg.logger;
  }

  handler(): Hono<HonoEnv> {
    const app = new Hono<HonoEnv>();

    app.use('*', observe({ logger: () => this.log ?? SILENT, renderPanic: () => renderPanic() }));
    app.use('*', async (c, next) => {
      c.set('deps', await this.buildDeps(c));
      await next();
    });

    app.route('/', deployRoutes());
    app.route('/', deviceRoutes());
    app.route('/', authRoutes());
    app.route('/', appsRoutes());
    app.route('/', sharingRoutes());
    app.route('/', secretsRoutes());
    app.route('/', integrationRoutes());

    app.get('/healthz', (c) => c.text('ok\n'));
    app.route('/v1/docs', docsRoutes());
    app.route('/v1/sdk/integrations', sdkIntegrationRoutes());

    return app;
  }
}
