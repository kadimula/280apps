import { APP_STATE_NOT_DEPLOYED, DeployCode, asDeployError, type DeployStatus } from '@280/contracts';
import * as config from './config.js';
import * as output from './output.js';
import { read280, type Policy280 } from './bundle/manifest280.js';
import type { Ctx } from './app.js';

const STATUS_HELP = `two80 status - reconcile this directory, its 280.json, and the platform

Reports one document across three planes: the local link (.280/config.json),
the wiring (280.json integrations and config), and the platform state. It never
fails just to report a state; the summary line is safe to relay to your user.

Usage:
  two80 status [<app>] [flags]

  <app>   app id to check (defaults to this directory's app via .280/config.json)

Examples:
  two80 status
  two80 status app_000001`;

interface NextStep {
  cmd: string;
  when: string;
  needsUser: boolean;
}

interface Composed {
  state: string;
  blockedOn: 'none' | 'agent' | 'user';
  cause?: string;
  summary: string;
  app: Record<string, unknown>;
  platform?: { knowsApp: boolean; url: string };
  status?: DeployStatus;
  next: NextStep[];
}

export async function cmdStatus(ctx: Ctx): Promise<number> {
  const s = ctx.env.streams;

  let rest = ctx.args;
  let appArg = '';
  if (rest.length > 0 && !rest[0]!.startsWith('-')) {
    appArg = rest[0]!;
    rest = rest.slice(1);
  }

  const p = output.parseFlags(s, 'status', rest, []);
  if (p.usage !== undefined) return p.usage;
  if (p.help) {
    output.text(s, STATUS_HELP);
    return output.ExitOK;
  }

  const { cfg } = config.load(ctx.env.root);
  const wiring = readWiring(ctx.env.root);
  const appId = appArg !== '' ? appArg : cfg.appId;
  const app = appBlock(cfg, appId);

  if (appId === '') {
    return output.result(s, assemble(wiring, {
      state: 'unlinked',
      blockedOn: 'agent',
      cause: 'never_pushed',
      summary: 'no app is linked to this directory yet; push to create and deploy it',
      app,
      next: [{ cmd: 'two80 push', when: 'deploy this directory', needsUser: false }],
    }));
  }

  const port = await ctx.deps.openPort();
  let status: DeployStatus;
  try {
    status = await port.appStatus(appId);
  } catch (e) {
    const d = asDeployError(e);
    if (d?.synthesized) return output.result(s, unreachable(wiring, app));
    if (d && (d.code === DeployCode.NoSuchApp || d.code === DeployCode.NotFound)) {
      return output.result(s, unknownApp(wiring, app, appId, appArg !== ''));
    }
    throw e;
  }

  return output.result(s, fromStatus(wiring, app, status));
}

// A broken or missing 280.json must never crash status: drop the wiring plane.
function readWiring(root: string): Policy280 | undefined {
  try {
    return read280(root);
  } catch {
    return undefined;
  }
}

function appBlock(cfg: config.Config, appId: string): Record<string, unknown> {
  const app: Record<string, unknown> = {};
  if (cfg.name !== '') app.name = cfg.name;
  if (appId !== '') app.id = appId;
  if (cfg.framework !== '') app.framework = cfg.framework;
  app.linked = cfg.appId !== '';
  return app;
}

function fromStatus(wiring: Policy280 | undefined, app: Record<string, unknown>, status: DeployStatus): Record<string, unknown> {
  const platform = { knowsApp: true, url: status.url };
  switch (status.state) {
    case 'live':
      return assemble(wiring, {
        state: 'live',
        blockedOn: 'none',
        summary: status.url !== '' ? `your app is live at ${status.url}` : 'your app is live',
        app,
        platform,
        status,
        next: [{ cmd: 'two80 push', when: 'redeploy after changes', needsUser: false }],
      });
    case 'uploading':
    case 'activating':
      return assemble(wiring, {
        state: status.state,
        blockedOn: 'agent',
        cause: 'in_flight',
        summary: `deploy in progress (${status.state}); check again in a moment`,
        app,
        platform,
        status,
        next: [{ cmd: 'two80 status', when: 'poll again in a moment', needsUser: false }],
      });
    case 'waiting_secrets': {
      const integration = status.integrationNotice !== '';
      return assemble(wiring, {
        state: 'waiting_secrets',
        blockedOn: 'user',
        cause: integration ? 'awaiting_integration_binding' : 'awaiting_config_values',
        summary: integration
          ? 'parked: an integration must be connected in the dashboard before this deploy can finish'
          : 'parked: required configuration must be set in the dashboard before this deploy can finish',
        app,
        platform,
        status,
        next: [
          {
            cmd: integration ? 'bind the integration in the 280 dashboard' : 'set the configuration in the 280 dashboard',
            when: 'before the deploy can finish',
            needsUser: true,
          },
          { cmd: 'two80 status', when: 'poll again after the user acts', needsUser: false },
        ],
      });
    }
    case 'failed':
      return assemble(wiring, {
        state: 'failed',
        blockedOn: 'agent',
        cause: 'deploy_failed',
        summary: `the last deploy failed: ${status.failure?.message ?? 'unknown error'}`,
        app,
        platform,
        status,
        next: [{ cmd: 'two80 push', when: 'retry the deploy', needsUser: false }],
      });
    case APP_STATE_NOT_DEPLOYED:
      return assemble(wiring, {
        state: APP_STATE_NOT_DEPLOYED,
        blockedOn: 'agent',
        cause: 'never_pushed',
        summary: 'the platform knows this app but it has never been deployed',
        app,
        platform,
        status,
        next: [{ cmd: 'two80 push', when: 'deploy this directory', needsUser: false }],
      });
    default:
      // Unknown states are treated as in progress, per the contracts State convention.
      return assemble(wiring, {
        state: status.state,
        blockedOn: 'agent',
        summary: `the platform reports state "${status.state}"`,
        app,
        platform,
        status,
        next: [{ cmd: 'two80 status', when: 'check again in a moment', needsUser: false }],
      });
  }
}

function unknownApp(wiring: Policy280 | undefined, app: Record<string, unknown>, appId: string, hasArg: boolean): Record<string, unknown> {
  return assemble(wiring, {
    state: 'unknown_app',
    blockedOn: 'user',
    cause: 'app_missing',
    summary: hasArg
      ? `app ${appId} does not exist on this account`
      : `.280/config.json points at ${appId}, which does not exist on this account`,
    app,
    platform: { knowsApp: false, url: '' },
    next: [
      { cmd: 'two80 push --new', when: `create a fresh app; abandons ${appId}`, needsUser: true },
      { cmd: 'two80 push', when: 'retry against the existing link', needsUser: false },
    ],
  });
}

function unreachable(wiring: Policy280 | undefined, app: Record<string, unknown>): Record<string, unknown> {
  return assemble(wiring, {
    state: 'unreachable',
    blockedOn: 'agent',
    cause: 'endpoint_unavailable',
    summary:
      'the platform status endpoint did not answer in the expected shape; the backend may predate this CLI, or TWO80_API points at the wrong host',
    app,
    next: [{ cmd: 'two80 status', when: 'retry after the backend catches up', needsUser: false }],
  });
}

function assemble(wiring: Policy280 | undefined, c: Composed): Record<string, unknown> {
  const doc: Record<string, unknown> = { state: c.state, blockedOn: c.blockedOn };
  if (c.cause !== undefined) doc.cause = c.cause;
  doc.summary = c.summary;
  doc.app = c.app;
  if (c.platform) {
    const pl: Record<string, unknown> = { knowsApp: c.platform.knowsApp };
    if (c.platform.url !== '') pl.url = c.platform.url;
    doc.platform = pl;
  }
  const integrations = integrationRows(wiring);
  if (integrations.length > 0) doc.integrations = integrations;
  const configEntries = configRows(wiring);
  if (configEntries.length > 0) doc.config = configEntries;
  const st = c.status;
  if (st) {
    if (st.notice !== '') doc.notice = st.notice;
    if (st.secretNotice !== '') doc.secretNotice = st.secretNotice;
    if (st.integrationNotice !== '') doc.integrationNotice = st.integrationNotice;
    if (st.failure) {
      doc.message = st.failure.message;
      doc.fix = st.failure.fix;
    }
  }
  doc.next = c.next;
  return doc;
}

function integrationRows(wiring: Policy280 | undefined): Record<string, unknown>[] {
  if (!wiring) return [];
  return wiring.integrations.map((r) => ({ alias: r.alias, capability: r.capability, operations: r.operations }));
}

function configRows(wiring: Policy280 | undefined): Record<string, unknown>[] {
  if (!wiring) return [];
  return wiring.config.map((e) => ({ name: e.name, source: e.value === '' ? 'dashboard' : 'literal' }));
}
