import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { mockApi, renderApp, type RecordedRequest } from '../test/api';
import { datasetRoutes, rowsReply } from '../test/fixtures';

/** The /rows reply depends on the filters actually sent, like the real API. */
function rowsByFilter(request: RecordedRequest) {
  const filters = request.params.getAll('filter');
  if (filters.includes('value:gte:12')) return rowsReply([2, 5, 7]);
  if (filters.includes('label:empty')) return rowsReply([]);
  return rowsReply([0, 1, 2, 3, 4, 5, 6, 7]);
}

const rowsRequests = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === '/api/datasets/ds1/rows');

const rowCount = () => screen.getByTestId('row-count').textContent;

describe('filter builder', () => {
  it('adds a filter chip, sends it to the rows endpoint and shows the narrowed table', async () => {
    const requests = mockApi(datasetRoutes(rowsByFilter));
    const user = userEvent.setup();
    renderApp('/datasets/ds1');
    await screen.findByText('8 matching rows');

    await user.selectOptions(screen.getByTestId('filter-column'), 'value');
    await user.selectOptions(screen.getByTestId('filter-operator'), 'gte');
    await user.type(screen.getByTestId('filter-value'), '  12 ');
    await user.click(screen.getByTestId('add-filter'));

    const chips = await screen.findByTestId('active-filters');
    expect(within(chips).getByText('value:gte:12')).toBeTruthy();
    await waitFor(() => expect(rowCount()).toBe('3 matching rows'));
    expect(screen.getAllByTestId('row')).toHaveLength(3);
    // The value box is cleared for the next filter, and the value was trimmed.
    expect((screen.getByTestId('filter-value') as HTMLInputElement).value).toBe('');
    expect(rowsRequests(requests).at(-1)?.params.getAll('filter')).toEqual(['value:gte:12']);
  });

  it('refuses a filter that needs a value but has none', async () => {
    const requests = mockApi(datasetRoutes(rowsByFilter));
    const user = userEvent.setup();
    renderApp('/datasets/ds1');
    await screen.findByText('8 matching rows');
    const before = rowsRequests(requests).length;

    await user.selectOptions(screen.getByTestId('filter-operator'), 'eq');
    await user.type(screen.getByTestId('filter-value'), '   ');
    await user.click(screen.getByTestId('add-filter'));

    expect(screen.queryByTestId('active-filters')).toBeNull();
    expect(rowCount()).toBe('8 matching rows');
    expect(rowsRequests(requests)).toHaveLength(before);
  });

  it('adds a value-less operator without a value, and removing the chip restores all rows', async () => {
    const requests = mockApi(datasetRoutes(rowsByFilter));
    const user = userEvent.setup();
    renderApp('/datasets/ds1');
    await screen.findByText('8 matching rows');

    await user.selectOptions(screen.getByTestId('filter-column'), 'label');
    await user.selectOptions(screen.getByTestId('filter-operator'), 'empty');
    await user.click(screen.getByTestId('add-filter'));

    expect(await screen.findByText('label:empty')).toBeTruthy();
    await waitFor(() => expect(rowCount()).toBe('0 matching rows'));

    await user.click(screen.getByRole('button', { name: 'Remove filter label:empty' }));
    await waitFor(() => expect(rowCount()).toBe('8 matching rows'));
    expect(screen.queryByTestId('active-filters')).toBeNull();
    expect(rowsRequests(requests).at(-1)?.params.getAll('filter')).toEqual([]);
  });

  it('ranking by a numeric column shows a rank column', async () => {
    const requests = mockApi(
      datasetRoutes((request) =>
        request.params.get('rankBy') === 'value'
          ? rowsReply([7, 2, 5], [1, 2, 2])
          : rowsReply([0, 1, 2, 3, 4, 5, 6, 7]),
      ),
    );
    const user = userEvent.setup();
    renderApp('/datasets/ds1');
    await screen.findByText('8 matching rows');

    // Only numeric columns are offered for ranking.
    const options = within(screen.getByTestId('rank-by')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['No ranking', 'Rank by value']);

    await user.selectOptions(screen.getByTestId('rank-by'), 'value');

    await waitFor(() =>
      expect(screen.getAllByTestId('rank-cell').map((c) => c.textContent)).toEqual([
        '1',
        '2',
        '2',
      ]),
    );
    expect(rowsRequests(requests).at(-1)?.params.get('rankBy')).toBe('value');
  });
});
