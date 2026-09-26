import type {
  AnomaliesResponse,
  ApiErrorBody,
  AskResponse,
  AuthResponse,
  DatasetProfile,
  DatasetSummary,
  RowsPage,
} from './types';

/**
 * Blank (the normal case) means requests go to relative /api paths on the
 * page's own origin: Vercel rewrites them to the API in production, and Vite's
 * proxy does the same in dev and e2e. Same-origin means no CORS and a
 * first-party session cookie. VITE_API_BASE_URL is only for a deliberate
 * cross-origin setup, and there is still no hardcoded host to fall back on.
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
  // The session is an HttpOnly cookie the server sets at login. This client
  // never sees or stores the token; it just asks the browser to send the
  // cookie along, which a cross-origin fetch only does with 'include'.
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
    credentials: 'include',
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
  anomaliesOnly?: boolean;
}

function toSearch(query: RowsQuery): string {
  const params = new URLSearchParams();
  for (const filter of query.filters ?? []) params.append('filter', filter);
  if (query.sort) params.set('sort', query.sort);
  if (query.direction) params.set('direction', query.direction);
  if (query.rankBy) params.set('rankBy', query.rankBy);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  if (query.anomaliesOnly) params.set('anomaliesOnly', 'true');
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

  me: () => request<{ user: AuthResponse['user'] }>('/api/auth/me'),

  logout: () => request<null>('/api/auth/logout', { method: 'POST' }),

  listDatasets: () =>
    request<{ datasets: DatasetSummary[] }>('/api/datasets'),

  uploadDataset: (name: string, csv: string) =>
    request<{ dataset: DatasetSummary }>(
      `/api/datasets?name=${encodeURIComponent(name)}`,
      { method: 'POST', csv },
    ),

  getDataset: (id: string) =>
    request<{ dataset: DatasetSummary }>(`/api/datasets/${id}`),

  getProfile: (id: string) =>
    request<{ datasetId: string; profile: DatasetProfile }>(`/api/datasets/${id}/profile`),

  getAnomalies: (id: string) =>
    request<AnomaliesResponse>(`/api/datasets/${id}/anomalies`),

  getRows: (id: string, query: RowsQuery) =>
    request<RowsPage>(`/api/datasets/${id}/rows${toSearch(query)}`),

  ask: (id: string, question: string) =>
    request<AskResponse>(`/api/datasets/${id}/ask`, {
      method: 'POST',
      json: { question },
    }),

  exportCsv: (id: string, query: RowsQuery) =>
    request<string>(`/api/datasets/${id}/export${toSearch(query)}`, {
      accept: 'text',
    }),

  deleteDataset: (id: string) =>
    request<null>(`/api/datasets/${id}`, { method: 'DELETE' }),
};
