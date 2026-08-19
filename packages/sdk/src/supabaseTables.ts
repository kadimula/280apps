import { integrationClient, IntegrationRequestError, type NotReadyCode } from './integrations-common.js';
import type { RequestLike } from './index.js';

export { IntegrationRequestError };
export type { NotReadyCode };

export type SupabaseFilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is';

// PostgREST pattern matching: like/ilike use '*' as the wildcard (not SQL '%').
export interface SupabaseFilter {
  column: string;
  op: SupabaseFilterOp;
  value: unknown;
}

export interface TablesSelectInput {
  resource: string;
  columns?: string[];
  filters?: SupabaseFilter[];
  limit?: number;
}

export interface TablesSelectResult {
  rows: Record<string, unknown>[];
  count: number;
  notReady?: NotReadyCode;
}

export interface TablesInsertInput {
  resource: string;
  rows: Record<string, unknown>[];
}

export interface TablesInsertResult {
  rows: Record<string, unknown>[];
  insertedCount: number;
  notReady?: NotReadyCode;
}

export interface TablesUpdateInput {
  resource: string;
  values: Record<string, unknown>;
  filters: SupabaseFilter[];
}

export interface TablesUpdateResult {
  rows: Record<string, unknown>[];
  updatedCount: number;
  notReady?: NotReadyCode;
}

export interface TablesDeleteInput {
  resource: string;
  filters: SupabaseFilter[];
}

export interface TablesDeleteResult {
  deletedCount: number;
  notReady?: NotReadyCode;
}

export interface SupabaseTablesClient {
  select(input: TablesSelectInput): Promise<TablesSelectResult>;
  insert(input: TablesInsertInput): Promise<TablesInsertResult>;
  update(input: TablesUpdateInput): Promise<TablesUpdateResult>;
  delete(input: TablesDeleteInput): Promise<TablesDeleteResult>;
}

export interface SupabaseTablesOptions {
  origin?: string;
  fetch?: typeof fetch;
}

export function supabaseTables(request: RequestLike, opts: SupabaseTablesOptions = {}): SupabaseTablesClient {
  const { command } = integrationClient(request, 'supabase-tables', opts);
  return {
    select: command<TablesSelectInput, TablesSelectResult>('select', (_input, notReady) => ({
      rows: [],
      count: 0,
      notReady,
    })),
    insert: command<TablesInsertInput, TablesInsertResult>('insert', (_input, notReady) => ({
      rows: [],
      insertedCount: 0,
      notReady,
    })),
    update: command<TablesUpdateInput, TablesUpdateResult>('update', (_input, notReady) => ({
      rows: [],
      updatedCount: 0,
      notReady,
    })),
    delete: command<TablesDeleteInput, TablesDeleteResult>('delete', (_input, notReady) => ({
      deletedCount: 0,
      notReady,
    })),
  };
}
