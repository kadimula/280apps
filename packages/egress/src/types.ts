// The slice of the @cloudflare/containers surface the egress layer depends on,
// declared structurally so this package carries no runtime dependency on the
// library (it is imported only as `import type`, erased at build). The shapes
// mirror @cloudflare/containers@0.3.7 `dist/lib/container.d.ts` exactly.

export type { EgressPolicy, EgressCredential } from '@280/contracts';

// What the ContainerProxy passes an outbound handler. `params` carries the
// per-host config we bind via setOutboundByHost — serializable, so the secret's
// NAME crosses the Durable Object boundary while its VALUE never does.
export interface OutboundHandlerCtx {
  containerId: string;
  className: string;
  params?: unknown;
}

// An outbound handler runs in the Workers runtime, outside the container sandbox.
// `env` is the Worker's env (the vault); the container never sees it.
export type OutboundHandler = (
  req: Request,
  env: unknown,
  ctx: OutboundHandlerCtx,
) => Promise<Response> | Response;

// One entry of a setOutboundByHosts call: a named handler from `outboundHandlers`
// plus the serializable params bound for that host.
export interface OutboundByHostEntry {
  method: string;
  params?: unknown;
}

// The container stub surface applyEgressPolicy drives. A subset of the library's
// Container instance methods; the DurableObjectStub the front holds implements it.
export interface ContainerStub {
  setAllowedHosts(hosts: string[]): Promise<void>;
  setOutboundByHosts(handlers: Record<string, string | OutboundByHostEntry>): Promise<void>;
}

// The static container class registerEgress mutates. Assigning `outboundHandlers`
// (never a class field) runs the base setter that populates the named-handler
// registry — the class-field footgun the spike documented (OQ5).
export interface EgressContainerClass {
  outboundHandlers?: Record<string, OutboundHandler>;
}

// The per-host config bound as ctx.params: only names, the credential type, and
// header/scope wiring — no secret values. Kept flat and JSON-serializable for the DO
// boundary. `type` selects the minter ('' means the static header path); `scopes`
// are the deploy-declared OAuth scopes for a minted type.
export interface EgressCallParams {
  appId: string;
  host: string;
  secret: string; // secret NAME, '' when the host is allowlisted without a credential
  type: string; // credential type; '' or 'header' is the static path
  header: string;
  scheme: string;
  scopes: string[];
}
