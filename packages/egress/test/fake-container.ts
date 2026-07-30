// A faithful in-process double of @cloudflare/containers@0.3.7's ContainerProxy
// outbound path, so the egress layer's fail-closed and credential-injection
// behaviour is provable in node CI without workerd or a Cloudflare account. The
// precedence below mirrors `ContainerProxy.fetch` (dist/lib/container.js, steps
// 1-9) and `simpleGlobMatch` exactly; the spike verified the real library matches
// it end-to-end on real Cloudflare (spike report §2/§3).
//
// The security-critical steps this double reproduces: default-deny when nothing is
// configured, the allowedHosts whitelist gate returning HTTP 520 "Origin is
// disallowed", and per-host handler dispatch with ctx.params. If our code ever
// stops locking those down (e.g. enableInternet flipped on, or an exfil host in the
// allowlist), the exfil suite fails.

import type { ContainerStub, EgressContainerClass, OutboundByHostEntry } from '../src/types.js';

const DISALLOWED = 'Origin is disallowed';

function simpleGlobMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function matchesHostList(hostname: string, list: string[]): boolean {
  return list.some((p) => p === hostname || simpleGlobMatch(p, hostname));
}

export interface FakeContainerConfig {
  cls: EgressContainerClass; // holds the registered outboundHandlers
  env: unknown; // the Worker env the handler receives (the vault source)
  // Locked platform defaults (App280Container): default-deny, HTTPS intercepted.
  enableInternet?: boolean;
  containerId?: string;
  className?: string;
  // The direct fetch used only by the enableInternet/allowedHosts fallback path
  // (never reached once applyEgressPolicy registers a handler per allowed host).
  directFetch?: typeof fetch;
}

// FakeContainer implements the ContainerStub surface (setAllowedHosts /
// setOutboundByHosts) that applyEgressPolicy drives, and exposes outboundFetch,
// which the "container" calls to reach the internet — routed through the same
// precedence the real ContainerProxy applies.
export class FakeContainer implements ContainerStub {
  private allowedHosts: string[] | undefined;
  private overrides: Record<string, OutboundByHostEntry> = {};
  private readonly enableInternet: boolean;
  private readonly containerId: string;
  private readonly className: string;
  private readonly directFetch: typeof fetch;

  constructor(private readonly cfg: FakeContainerConfig) {
    this.enableInternet = cfg.enableInternet ?? false;
    this.containerId = cfg.containerId ?? 'test-container';
    this.className = cfg.className ?? 'App280Container';
    this.directFetch = cfg.directFetch ?? fetch;
  }

  async setAllowedHosts(hosts: string[]): Promise<void> {
    this.allowedHosts = hosts;
  }

  async setOutboundByHosts(handlers: Record<string, string | OutboundByHostEntry>): Promise<void> {
    this.overrides = {};
    for (const [host, h] of Object.entries(handlers)) {
      this.overrides[host] = typeof h === 'string' ? { method: h } : h;
    }
  }

  // Mirrors ContainerProxy.fetch precedence for the subset the egress layer uses.
  async outboundFetch(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname.toLowerCase();
    const handlers = this.cfg.cls.outboundHandlers;

    // 2. allowedHosts whitelist gate — the fail-closed security boundary.
    if (this.allowedHosts && !matchesHostList(hostname, this.allowedHosts)) {
      return new Response(DISALLOWED, { status: 520 });
    }
    // 3. per-host handler (exact then glob), the credential-injecting path.
    if (handlers) {
      const override =
        this.overrides[hostname] ??
        Object.entries(this.overrides).find(
          ([pattern]) => pattern !== hostname && simpleGlobMatch(pattern, hostname),
        )?.[1];
      if (override && handlers[override.method]) {
        return handlers[override.method]!(request, this.cfg.env, {
          containerId: this.containerId,
          className: this.className,
          params: override.params,
        });
      }
    }
    // 7/8. fallback: only when explicitly allowed or internet is on.
    if (this.allowedHosts || this.enableInternet) return this.directFetch(request);
    // 9. default deny.
    return new Response(DISALLOWED, { status: 520 });
  }
}
