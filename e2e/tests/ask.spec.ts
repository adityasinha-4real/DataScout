import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../fixtures/players.csv');

const uniqueEmail = () =>
  `ask.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
const PASSWORD = 'ask-test-password';

/** Register a fresh account and upload the fixture, landing on the dataset. */
async function openDataset(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.locator('#email').fill(uniqueEmail());
  await page.locator('#password').fill(PASSWORD);
  await page.getByTestId('submit-auth').click();

  await page.getByTestId('csv-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('dataset-summary')).toHaveText('7 rows · 5 columns');
}

const COLUMNS = ['name', 'team', 'score', 'minutes', 'joined'];

/**
 * /ask is intercepted so the suite never needs an API key and never reaches a
 * model. The backend's own translation and validation are covered by
 * backend/test/ask.test.js; what is under test here is the UI contract:
 * the filters the model produced are shown, and so is what they matched.
 */
test('asking a question shows the generated filters and the rows they match', async ({
  page,
}) => {
  await page.route('**/api/datasets/*/ask', async (route) => {
    const body = route.request().postDataJSON() as { question: string };
    expect(body.question).toBe('who scored at least 37?');

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        datasetId: 'intercepted',
        spec: {
          filters: [{ column: 'score', operator: 'gte', value: '37' }],
          rankBy: 'score',
        },
        explanation:
          'Kept rows where score is at least 37, ranked them by score, highest first.',
        columns: COLUMNS,
        rows: [
          { row: ['Katherine', 'Green', '51', '95', '2017-02-11'], rank: 1 },
          { row: ['Ada', 'Blue', '42', '90', '2021-03-01'], rank: 2 },
          { row: ['Linus', 'Blue', '42', '60', '2022-01-09'], rank: 2 },
          { row: ['Grace', 'Red', '37', '85', '2020-07-14'], rank: 3 },
        ],
        total: 4,
        page: 1,
        pageSize: 50,
        pageCount: 1,
      }),
    });
  });

  await openDataset(page);

  await page.getByTestId('ask-input').fill('who scored at least 37?');
  await page.getByTestId('ask-submit').click();

  // The generated query is shown, not just its result.
  await expect(page.getByTestId('ask-filter-chip')).toHaveCount(1);
  await expect(page.getByTestId('ask-filter-chip')).toHaveText('score gte 37');
  await expect(page.getByTestId('ask-row-count')).toHaveText('4 matching rows');
  await expect(page.getByTestId('ask-explanation')).toContainText(
    'ranked them by score',
  );

  // Adopting the answer drives the real table through the real rows endpoint,
  // which is not intercepted: 4 of the 7 fixture rows score 37 or more.
  await page.getByTestId('ask-apply').click();
  await expect(page.getByTestId('active-filters')).toContainText('score:gte:37');
  await expect(page.getByTestId('row-count')).toHaveText('4 matching rows');
  await expect(page.getByTestId('rows-table').getByTestId('row')).toHaveCount(4);
  await expect(page.getByTestId('rank-cell').first()).toHaveText('1');
});

test('a question the server cannot answer is reported, not swallowed', async ({
  page,
}) => {
  await page.route('**/api/datasets/*/ask', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'LLM_UNAVAILABLE',
          message: 'Natural-language search is not configured on this server.',
        },
      }),
    }),
  );

  await openDataset(page);

  await page.getByTestId('ask-input').fill('anything at all');
  await page.getByTestId('ask-submit').click();

  await expect(page.getByTestId('ask-error')).toContainText('not configured');
  await expect(page.getByTestId('ask-result')).toHaveCount(0);
  // The table is untouched by a failed question.
  await expect(page.getByTestId('row-count')).toHaveText('7 matching rows');
});
