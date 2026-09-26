import { expect, test, type Request } from '@playwright/test';

const uniqueEmail = () =>
  `origin.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;

/**
 * Production serves the API through a same-origin /api rewrite (vercel.mjs);
 * the preview server's proxy plays that role here. This proves the browser
 * really never leaves the page's origin and the session is a first-party,
 * script-invisible cookie on that origin.
 */
test('every API call stays on the page origin and the session is an HttpOnly Lax cookie', async ({
  page,
  context,
  baseURL,
}) => {
  const apiCalls: Request[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request);
  });

  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.locator('#email').fill(uniqueEmail());
  await page.locator('#password').fill('origin-test-password');
  await page.getByTestId('submit-auth').click();
  await expect(page.getByTestId('empty-state')).toBeVisible();

  const pageOrigin = new URL(baseURL ?? page.url()).origin;
  expect(apiCalls.length).toBeGreaterThan(0);
  for (const call of apiCalls) {
    expect(new URL(call.url()).origin).toBe(pageOrigin);
    // Same-origin requests never need a CORS preflight.
    expect(call.method()).not.toBe('OPTIONS');
  }
  expect(apiCalls.map((c) => `${c.method()} ${new URL(c.url()).pathname}`)).toContain(
    'POST /api/auth/register',
  );

  const session = (await context.cookies()).find((c) => c.name === 'datascout_session');
  expect(session).toBeDefined();
  expect(session?.domain).toBe(new URL(pageOrigin).hostname);
  expect(session?.path).toBe('/');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  // Plain http under test: Secure is production-only (NODE_ENV=production).
  expect(session?.secure).toBe(false);

  // HttpOnly means page scripts cannot see it at all.
  expect(await page.evaluate(() => document.cookie)).not.toContain('datascout_session');
});
