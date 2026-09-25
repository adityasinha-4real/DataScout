import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

import { unmatchedRequests } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // A request no test declared is a bug in the test or the app, never noise:
  // fail on it rather than let the UI swallow a 404 and pass by accident.
  const stray = unmatchedRequests.splice(0);
  expect(stray, `unmocked requests: ${stray.join(', ')}`).toEqual([]);
});
