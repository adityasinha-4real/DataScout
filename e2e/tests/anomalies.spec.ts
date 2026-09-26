import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
// value = 10,11,12,11,10,12,11,95: the criterion's fixture, one spike at row 7.
const FIXTURE = resolve(HERE, '../fixtures/spike.csv');

const uniqueEmail = () =>
  `anomaly.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;

/**
 * Nothing is intercepted: the real API computes the outliers and the real
 * rows endpoint narrows the table, so this covers the whole path.
 */
test('"Show anomalies only" narrows the table to the one flagged row', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.locator('#email').fill(uniqueEmail());
  await page.locator('#password').fill('anomaly-test-password');
  await page.getByTestId('submit-auth').click();

  await page.getByTestId('csv-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('dataset-summary')).toHaveText('8 rows · 3 columns');
  await expect(page.getByTestId('row-count')).toHaveText('8 matching rows');
  await expect(page.getByTestId('anomaly-count')).toHaveText('1 row flagged');

  // Before narrowing, the flagged cell is already highlighted in place.
  await expect(page.getByTestId('anomaly-cell')).toHaveCount(1);

  await page.getByTestId('anomalies-only').check();

  const rows = page.getByTestId('rows-table').getByTestId('row');
  await expect(page.getByTestId('row-count')).toHaveText('1 matching rows');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('h');

  const flagged = rows.first().getByTestId('anomaly-cell');
  await expect(flagged).toHaveCount(1);
  await expect(flagged).toHaveText('95');
  await expect(flagged).toHaveClass(/anomaly/);

  // Turning it off restores the full table.
  await page.getByTestId('anomalies-only').uncheck();
  await expect(rows).toHaveCount(8);
});
