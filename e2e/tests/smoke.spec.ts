import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../fixtures/players.csv');

const uniqueEmail = () =>
  `smoke.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
const PASSWORD = 'smoke-test-password';

/**
 * The primary user flow end to end:
 * register -> upload a CSV -> see it profiled -> filter -> rank -> export.
 */
test('a new user can register, upload a CSV, explore it and export', async ({
  page,
}) => {
  await page.goto('/');

  // --- register ---
  await page.getByTestId('tab-register').click();
  const email = uniqueEmail();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByTestId('submit-auth').click();

  await expect(page.getByTestId('current-user')).toHaveText(email);
  await expect(page.getByTestId('empty-state')).toBeVisible();

  // --- upload ---
  await page.getByTestId('csv-input').setInputFiles(FIXTURE);

  await expect(page.getByTestId('dataset-name')).toHaveText('players');
  await expect(page.getByTestId('dataset-summary')).toHaveText(
    '7 rows · 5 columns',
  );

  // --- the upload was actually profiled, not just stored ---
  await expect(page.getByTestId('profile-row-score')).toContainText('number');
  await expect(page.getByTestId('profile-row-score')).toContainText('15 – 51');
  await expect(page.getByTestId('profile-row-name')).toContainText('string');
  // `minutes` has exactly one blank cell in the fixture.
  await expect(page.getByTestId('profile-row-minutes')).toContainText('1');

  await expect(page.getByTestId('row-count')).toHaveText('7 matching rows');
  await expect(page.getByTestId('rows-table').getByTestId('row')).toHaveCount(7);

  // --- filter ---
  await page.getByTestId('filter-column').selectOption('team');
  await page.getByTestId('filter-operator').selectOption('eq');
  await page.getByTestId('filter-value').fill('Blue');
  await page.getByTestId('add-filter').click();

  await expect(page.getByTestId('active-filters')).toContainText('team:eq:Blue');
  await expect(page.getByTestId('row-count')).toHaveText('3 matching rows');
  await expect(page.getByTestId('rows-table').getByTestId('row')).toHaveCount(3);

  // --- rank within the filtered set, ties sharing a rank ---
  await page.getByTestId('rank-by').selectOption('score');
  await expect(page.getByTestId('rank-cell').first()).toHaveText('1');
  await expect(page.getByTestId('rank-cell').nth(1)).toHaveText('1');
  await expect(page.getByTestId('rank-cell').nth(2)).toHaveText('2');

  // --- export reflects the filter, not the whole dataset ---
  await page.getByTestId('export').click();
  await expect(page.getByTestId('export-result')).toHaveText('Exported 3 rows');

  // --- removing the filter restores the full set ---
  await page.getByRole('button', { name: 'Remove filter team:eq:Blue' }).click();
  await expect(page.getByTestId('row-count')).toHaveText('7 matching rows');
});

test('the session survives a reload and sign-out returns to the login screen', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  const email = uniqueEmail();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByTestId('submit-auth').click();
  await expect(page.getByTestId('current-user')).toHaveText(email);

  await page.reload();
  await expect(page.getByTestId('current-user')).toHaveText(email);

  await page.getByTestId('logout').click();
  await expect(page.getByTestId('submit-auth')).toBeVisible();

  // A signed-out visitor cannot reach the dataset list by URL.
  await page.goto('/datasets');
  await expect(page.getByTestId('submit-auth')).toBeVisible();
});

test('a duplicate registration is reported to the user', async ({ page }) => {
  const email = uniqueEmail();

  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByTestId('submit-auth').click();
  await expect(page.getByTestId('current-user')).toHaveText(email);
  await page.getByTestId('logout').click();

  await page.getByTestId('tab-register').click();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByTestId('submit-auth').click();

  await expect(page.getByTestId('auth-error')).toContainText('already exists');
});

test('signing in with a wrong password shows an error and grants no access', async ({
  page,
}) => {
  const email = uniqueEmail();

  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByTestId('submit-auth').click();
  await expect(page.getByTestId('current-user')).toBeVisible();
  await page.getByTestId('logout').click();

  await page.getByTestId('tab-login').click();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('definitely-wrong-password');
  await page.getByTestId('submit-auth').click();

  await expect(page.getByTestId('auth-error')).toContainText(
    'Incorrect email or password',
  );
  await expect(page.getByTestId('current-user')).toHaveCount(0);
});
