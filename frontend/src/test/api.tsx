import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { App } from '../App';
import { AuthProvider } from '../lib/auth';

/**
 * The one boundary these tests mock: `fetch`. Everything above it — the API
 * client, auth context, router and components — is the real code, so a test
 * sees exactly the requests the app would send and renders what it would.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  params: URLSearchParams;
  headers: Record<string, string>;
  body: string | undefined;
  credentials: RequestCredentials | undefined;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
}

type Handler = (request: RecordedRequest, match: Record<string, string>) => Reply;

/** Requests that matched no route; setup.ts fails the test if any remain. */
export const unmatchedRequests: string[] = [];

function compile(route: string) {
  const [method, pattern = ''] = route.split(' ');
  const names: string[] = [];
  const source = pattern.replace(/:(\w+)/g, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { method, regex: new RegExp(`^${source}$`), names };
}

/**
 * Stub fetch with a route table such as `{ 'GET /api/datasets/:id': handler }`.
 * Returns every request made, in order, for assertions on what was sent.
 */
export function mockApi(routes: Record<string, Handler>) {
  const table = Object.entries(routes).map(([route, handler]) => ({
    ...compile(route),
    handler,
  }));
  const requests: RecordedRequest[] = [];

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    // Resolved against the page, so no host literal is needed here.
    const url = new URL(String(input), window.location.href);
    const request: RecordedRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      params: url.searchParams,
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(
          ([key, value]) => [key.toLowerCase(), value],
        ),
      ),
      body: typeof init.body === 'string' ? init.body : undefined,
      credentials: init.credentials,
    };
    requests.push(request);

    for (const route of table) {
      if (route.method !== request.method) continue;
      const found = route.regex.exec(request.path);
      if (!found) continue;
      const match = Object.fromEntries(route.names.map((name, i) => [name, found[i + 1] ?? '']));
      const reply = route.handler(request, match);
      const isJson = reply.json !== undefined;
      return new Response(isJson ? JSON.stringify(reply.json) : (reply.text ?? null), {
        status: reply.status ?? 200,
        headers: { 'content-type': isJson ? 'application/json' : 'text/csv' },
      });
    }

    unmatchedRequests.push(`${request.method} ${request.path}`);
    return new Response(null, { status: 599 });
  });

  vi.stubGlobal('fetch', fetchStub);
  return requests;
}

export const ok = (json: unknown): Reply => ({ json });
export const fail = (status: number, code: string, message: string): Reply => ({
  status,
  json: { error: { code, message } },
});

export const USER = { id: 'u1', email: 'ada@example.com', createdAt: '2026-01-01T00:00:00Z' };

/** Render the whole app at `path`, exactly as main.tsx mounts it. */
export function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
