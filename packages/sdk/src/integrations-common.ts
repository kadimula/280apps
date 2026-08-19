import { ID_HEADER } from '@280/contracts/identity';
import { sdkApiUrl, type HeaderSource, type RequestLike } from './index.js';

// Set on any result the platform reported as not-ready (the integration is not
// connected, the bound resource is gone, or the owner must re-authorize). The
// other fields then hold safe empty values, so an app that ignores this flag
// renders an empty state instead of crashing; branch on it to prompt a connect.
export type NotReadyCode = 'not_connected' | 'resource_not_found' | 'reauthorization_required';

export class IntegrationRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'IntegrationRequestError';
  }
}

// The platform's expected not-ready states: a human still needs to connect,
// bind, or re-authorize. These degrade to a safe result instead of throwing;
// every other code (provider/unavailable/invalid/unauthenticated/internal) still
// throws IntegrationRequestError so genuine failures surface.
const NOT_READY_CODES = new Set<NotReadyCode>(['not_connected', 'resource_not_found', 'reauthorization_required']);

export function notReadyCode(err: unknown): NotReadyCode | null {
  return err instanceof IntegrationRequestError && NOT_READY_CODES.has(err.code as NotReadyCode)
    ? (err.code as NotReadyCode)
    : null;
}

export interface IntegrationClient {
  command<I extends object, O>(operation: string, fallback: (input: I, notReady: NotReadyCode) => O): (input: I) => Promise<O>;
}

export function integrationClient(
  request: RequestLike,
  capability: string,
  opts: { origin?: string; fetch?: typeof fetch },
): IntegrationClient {
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const token = readHeader(request, ID_HEADER);

  async function call<T>(operation: string, body: object): Promise<T> {
    const url = sdkApiUrl(`/v1/sdk/integrations/${capability}/${operation}`, { origin: opts.origin });
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = (text === '' ? {} : safeJson(text)) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof data.error === 'string' ? data.error : 'request_failed';
      const message = typeof data.message === 'string' ? data.message : `${capability} request failed (${res.status})`;
      throw new IntegrationRequestError(code, message, res.status, data.retryable === true);
    }
    return data as T;
  }

  // Each command runs the backend call and, on a not-ready code, resolves to the
  // fallback result instead of throwing; every other error still throws.
  function command<I extends object, O>(
    operation: string,
    fallback: (input: I, notReady: NotReadyCode) => O,
  ): (input: I) => Promise<O> {
    return async (input) => {
      try {
        return await call<O>(operation, input);
      } catch (err) {
        const code = notReadyCode(err);
        if (code !== null) return fallback(input, code);
        throw err;
      }
    };
  }

  return { command };
}

export function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readHeader(request: RequestLike, name: string): string {
  const direct = request as HeaderSource;
  const src = typeof direct.get === 'function' ? direct : (request as { headers: HeaderSource }).headers;
  const v = src.get(name) ?? src.get(name.toLowerCase());
  return typeof v === 'string' ? v : '';
}
