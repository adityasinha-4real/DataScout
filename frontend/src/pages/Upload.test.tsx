import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { USER, fail, mockApi, ok, renderApp } from '../test/api';
import { DATASET, datasetRoutes } from '../test/fixtures';

const CSV = 'label,value,note\na,10,x\nh,95,x\n';

describe('uploading a CSV', () => {
  it('posts the file as text/csv with the session cookie and opens the new dataset', async () => {
    let uploaded = false;
    const requests = mockApi({
      ...datasetRoutes(),
      'GET /api/datasets': () => ok({ datasets: uploaded ? [DATASET] : [] }),
      'POST /api/datasets': () => {
        uploaded = true;
        return { status: 201, json: { dataset: DATASET } };
      },
    });
    const user = userEvent.setup();
    renderApp('/datasets');

    expect((await screen.findByTestId('empty-state')).textContent).toBe(
      'No datasets yet. Upload a CSV to get started.',
    );
    expect(screen.getByTestId('current-user').textContent).toBe(USER.email);

    await user.upload(
      screen.getByTestId('csv-input'),
      new File([CSV], 'players.csv', { type: 'text/csv' }),
    );

    // Lands on the dataset page the server just created.
    await waitFor(() => expect(screen.getByTestId('dataset-name').textContent).toBe('Spike'));
    expect(screen.getByTestId('dataset-summary').textContent).toBe('8 rows · 3 columns');

    const post = requests.find((r) => r.method === 'POST' && r.path === '/api/datasets');
    expect(post).toBeDefined();
    expect(post?.body).toBe(CSV);
    expect(post?.headers['content-type']).toBe('text/csv');
    expect(post?.params.get('name')).toBe('players');
    // Cookie auth: every request asks for credentials, none carries a token.
    for (const request of requests) {
      expect(request.credentials).toBe('include');
      expect(request.headers.authorization).toBeUndefined();
    }
  });

  it("shows the server's reason when an upload is rejected, and stays put", async () => {
    mockApi({
      'GET /api/auth/me': () => ok({ user: USER }),
      'GET /api/datasets': () => ok({ datasets: [] }),
      'POST /api/datasets': () =>
        fail(413, 'PAYLOAD_TOO_LARGE', 'That file is larger than the upload limit.'),
    });
    const user = userEvent.setup();
    renderApp('/datasets');

    const input = (await screen.findByTestId('csv-input')) as HTMLInputElement;
    await user.upload(input, new File(['x'.repeat(64)], 'huge.csv', { type: 'text/csv' }));

    expect((await screen.findByTestId('upload-error')).textContent).toBe(
      'That file is larger than the upload limit.',
    );
    expect(screen.queryByTestId('dataset-name')).toBeNull();
    expect(input.disabled).toBe(false);
  });

  it('lists existing datasets with their size', async () => {
    mockApi({
      'GET /api/auth/me': () => ok({ user: USER }),
      'GET /api/datasets': () => ok({ datasets: [DATASET] }),
    });
    renderApp('/datasets');

    const list = await screen.findByTestId('dataset-list');
    expect(within(list).getByTestId('dataset-link').textContent).toBe('Spike');
    expect(list.textContent).toContain('8 rows · 3 columns');
  });

  it('a visitor with no session is sent to sign in, not shown the uploader', async () => {
    mockApi({
      'GET /api/auth/me': () => fail(401, 'UNAUTHORIZED', 'Authentication required.'),
    });
    renderApp('/datasets');

    expect(await screen.findByRole('heading', { name: 'DataScout' })).toBeTruthy();
    expect(screen.queryByTestId('csv-input')).toBeNull();
  });
});
