import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AnomalyToggle } from './AnomalyToggle';
import { mockApi, renderApp, type RecordedRequest } from '../test/api';
import { datasetRoutes, rowsReply } from '../test/fixtures';

/** Like the real API: anomaliesOnly=true narrows to the flagged row 7. */
const rows = (request: RecordedRequest) =>
  request.params.get('anomaliesOnly') === 'true'
    ? rowsReply([7])
    : rowsReply([0, 1, 2, 3, 4, 5, 6, 7]);

describe('anomaly toggle on the dataset page', () => {
  it('"Show anomalies only" narrows to the flagged row, highlighted, and back', async () => {
    const requests = mockApi(datasetRoutes(rows));
    const user = userEvent.setup();
    renderApp('/datasets/ds1');

    await screen.findByText('8 matching rows');
    expect(screen.getByTestId('anomaly-count').textContent).toBe('1 row flagged');
    // Highlighted in place before any narrowing: exactly the 95.
    const inPlace = screen.getAllByTestId('anomaly-cell');
    expect(inPlace.map((cell) => cell.textContent)).toEqual(['95']);

    const toggle = screen.getByTestId('anomalies-only') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await user.click(screen.getByLabelText('Show anomalies only'));

    await waitFor(() =>
      expect(screen.getByTestId('row-count').textContent).toBe('1 matching rows'),
    );
    expect(toggle.checked).toBe(true);
    const visible = screen.getAllByTestId('row');
    expect(visible).toHaveLength(1);
    const flagged = within(visible[0] as HTMLElement).getByTestId('anomaly-cell');
    expect(flagged.textContent).toBe('95');
    expect(flagged.className).toBe('anomaly');
    expect(flagged.getAttribute('title')).toBe('Outlier (iqr, robustZ)');
    expect(
      requests.filter((r) => r.path.endsWith('/rows')).at(-1)?.params.get('anomaliesOnly'),
    ).toBe('true');

    await user.click(toggle);
    await waitFor(() => expect(screen.getAllByTestId('row')).toHaveLength(8));
    expect(
      requests.filter((r) => r.path.endsWith('/rows')).at(-1)?.params.has('anomaliesOnly'),
    ).toBe(false);
  });

  it('with nothing flagged the toggle is disabled and says so', async () => {
    mockApi(
      datasetRoutes(rows, {
        datasetId: 'ds1',
        columns: [{ column: 'value', insufficientData: false, flagged: [] }],
      }),
    );
    renderApp('/datasets/ds1');

    await screen.findByText('8 matching rows');
    expect(screen.getByTestId('anomaly-count').textContent).toBe('No outliers found');
    expect((screen.getByTestId('anomalies-only') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryAllByTestId('anomaly-cell')).toHaveLength(0);
  });
});

describe('AnomalyToggle', () => {
  it('reports each change and pluralises its count', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <AnomalyToggle flaggedRows={3} checked={false} onChange={onChange} />,
    );
    expect(screen.getByTestId('anomaly-count').textContent).toBe('3 rows flagged');

    await user.click(screen.getByLabelText('Show anomalies only'));
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<AnomalyToggle flaggedRows={3} checked onChange={onChange} />);
    await user.click(screen.getByLabelText('Show anomalies only'));
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('is disabled while outliers are still loading', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AnomalyToggle flaggedRows={null} checked={false} onChange={onChange} />);

    expect(screen.getByTestId('anomaly-count').textContent).toBe('Checking for outliers…');
    await user.click(screen.getByLabelText('Show anomalies only'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
