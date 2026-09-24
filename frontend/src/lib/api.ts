import type {
  ApiErrorBody,
  AuthResponse,
  DatasetProfile,
  DatasetSummary,
  RowsPage,
} from './types';

/**
 * The API origin is injected at build time. There is no literal fallback on
 * purpose: shipping a build without VITE_API_BASE_URL should be loud, and a
 * hardcoded localhost would silently work in dev and break everywhere else.
 */
const BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.code === 'string'
  );
}

interface RequestOptions {
  method?: string;
  token?: string | null;
  json?: unknown;
  csv?: string;
  accept?: 'json' | 'text';
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: string | undefined;

  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.csv !== undefined) {
    headers['Content-Type'] = 'text/csv';
    body = options.csv;
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });

  const raw = await response.text();
  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = raw === '' ? null : JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (isErrorBody(parsed)) {
      throw new ApiError(response.status, parsed.error.code, parsed.error.message);
    }
    throw new ApiError(response.status, 'UNEXPECTED', `Request failed (${response.status}).`);
  }

  if (options.accept === 'text') return raw as T;
  return (raw === '' ? null : JSON.parse(raw)) as T;
}

/** Filters travel as repeated `filter=column:operator:value` parameters. */
export interface RowsQuery {
  filters?: string[];
  sort?: string;
  direction?: 'asc' | 'desc';
  rankBy?: string;
  page?: number;
  pageSize?: number;
}

function toSearch(query: RowsQuery): string {
  const params = new URLSearchParams();
  for (const filter of query.filters ?? []) params.append('filter', filter);
  if (query.sort) params.set('sort', query.sort);
  if (query.direction) params.set('direction', query.direction);
  if (query.rankBy) params.set('rankBy', query.rankBy);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

export const api = {
  register: (email: string, password: string) =>
    request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      json: { email, password },
    }),

  login: (email: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      json: { email, password },
    }),

  me: (token: string) => request<{ user: AuthResponse['user'] }>('/api/auth/me', { token }),

  listDatasets: (token: string) =>
    request<{ datasets: DatasetSummary[] }>('/api/datasets', { token }),

  uploadDataset: (token: string, name: string, csv: string) =>
    request<{ dataset: DatasetSummary }>(
      `/api/datasets?name=${encodeURIComponent(name)}`,
      { method: 'POST', token, csv },
    ),

  getDataset: (token: string, id: string) =>
    request<{ dataset: DatasetSummary }>(`/api/datasets/${id}`, { token }),

  getProfile: (token: string, id: string) =>
    request<{ datasetId: string; profile: DatasetProfile }>(
      `/api/datasets/${id}/profile`,
      { token },
    ),

  getRows: (token: string, id: string, query: RowsQuery) =>
    request<RowsPage>(`/api/datasets/${id}/rows${toSearch(query)}`, { token }),

  exportCsv: (token: string, id: string, query: RowsQuery) =>
    request<string>(`/api/datasets/${id}/export${toSearch(query)}`, {
      token,
      accept: 'text',
    }),

  deleteDataset: (token: string, id: string) =>
    request<null>(`/api/datasets/${id}`, { method: 'DELETE', token }),
};
