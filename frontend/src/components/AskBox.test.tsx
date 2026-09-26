import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { fail, mockApi, ok, renderApp, type RecordedRequest } from '../test/api';
import { COLUMNS, ROWS, datasetRoutes, rowsReply } from '../test/fixtures';

const ANSWER = {
  datasetId: 'ds1',
  spec: {
    filters: [
      { column: 'value', operator: 'gte', value: '12' },
      { column: 'note', operator: 'notEmpty' },
    ],
    rankBy: 'value',
  },
  explanation: 'Kept rows where value is at least 12, ranked them by value, highest first.',
  columns: COLUMNS,
  rows: [7, 2, 5].map((index, i) => ({ row: ROWS[index], rank: [1, 2, 2][i], index })),
  total: 3,
  page: 1,
  pageSize: 50,
  pageCount: 1,
};

const rows = (request: RecordedRequest) =>
  request.params.getAll('filter').length === 2
    ? rowsReply([7, 2, 5], [1, 2, 2])
    : rowsReply([0, 1, 2, 3, 4, 5, 6, 7]);

const askRequests = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.method === 'POST' && r.path === '/api/datasets/ds1/ask');

describe('ask box', () => {
  it('shows the generated filters and match count, and applies them on request', async () => {
    const requests = mockApi({
      ...datasetRoutes(rows),
      'POST /api/datasets/:id/ask': () => ok(ANSWER),
    });
    const user = userEvent.setup();
    renderApp('/datasets/ds1');
    await screen.findByText('8 matching rows');

    await user.type(screen.getByTestId('ask-input'), '  which values are 12 or more?  ');
    await user.click(screen.getByTestId('ask-submit'));

    const result = await screen.findByTestId('ask-result');
    expect(
      within(result)
        .getAllByTestId('ask-filter-chip')
        .map((chip) => chip.textContent),
    ).toEqual(['value gte 12', 'note notEmpty']);
    expect(within(result).getByTestId('ask-row-count').textContent).toBe('3 matching rows');
    expect(within(result).getByTestId('ask-explanation').textContent).toContain(
      'ranked them by value',
    );
    // The question is sent trimmed, as JSON.
    expect(JSON.parse(askRequests(requests)[0]?.body ?? '{}')).toEqual({
      question: 'which values are 12 or more?',
    });
    // Asking alone does not touch the table.
    expect(screen.getByTestId('row-count').textContent).toBe('8 matching rows');

    await user.click(screen.getByTestId('ask-apply'));

    const chips = await screen.findByTestId('active-filters');
    expect(chips.textContent).toContain('value:gte:12');
    expect(chips.textContent).toContain('note:notEmpty');
    await waitFor(() =>
      expect(screen.getByTestId('row-count').textContent).toBe('3 matching rows'),
    );
    expect(screen.getAllByTestId('rank-cell').map((c) => c.textContent)).toEqual([
      '1',
      '2',
      '2',
    ]);
    expect((screen.getByTestId('rank-by') as HTMLSelectElement).value).toBe('value');
  });

  it('reports a question the server could not answer, and shows no result', async () => {
    mockApi({
      ...datasetRoutes(rows),
      'POST /api/datasets/:id/ask': () =>
        fail(422, 'UNRESOLVABLE_QUERY', 'That question refers to a column this dataset does not have.'),
    });
    const user = userEvent.setup();
    renderApp('/datasets/ds1');
    await screen.findByText('8 matching rows');

    await user.type(screen.getByTestId('ask-input'), 'what is the salary?');
    await user.click(screen.getByTestId('ask-submit'));

    expect((await screen.findByTestId('ask-error')).textContent).toBe(
      'That question refers to a column this dataset does not have.',
    );
    expect(screen.queryByTestId('ask-result')).toBeNull();
    expect((screen.getByTestId('ask-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a blank question is never sent', async () => {
    const requests = mockApi({
      ...datasetRoutes(rows),
      'POST /api/datasets/:id/ask': () => ok(ANSWER),
    });
    const user = userEvent.setup();
    renderApp('/datasets/ds1');
    await screen.findByText('8 matching rows');

    await user.type(screen.getByTestId('ask-input'), '    ');
    await user.click(screen.getByTestId('ask-submit'));
    await user.type(screen.getByTestId('ask-input'), '{Enter}');

    expect(askRequests(requests)).toHaveLength(0);
    expect(screen.queryByTestId('ask-result')).toBeNull();
    expect(screen.queryByTestId('ask-error')).toBeNull();
  });

  it('an answer with no filters says so instead of showing nothing', async () => {
    mockApi({
      ...datasetRoutes(rows),
      'POST /api/datasets/:id/ask': () =>
        ok({
          ...ANSWER,
          spec: {},
          explanation: 'Kept every row.',
          rows: [],
          total: 8,
        }),
    });
    const user = userEvent.setup();
    renderApp('/datasets/ds1');
    await screen.findByText('8 matching rows');

    await user.type(screen.getByTestId('ask-input'), 'show me everything');
    await user.click(screen.getByTestId('ask-submit'));

    const chip = await screen.findByTestId('ask-filter-chip');
    expect(chip.textContent).toBe('no filters');
    expect(screen.getByTestId('ask-row-count').textContent).toBe('8 matching rows');
  });
});
