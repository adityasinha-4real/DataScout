import { useState, type FormEvent } from 'react';

import { ApiError } from '../lib/api';
import type { AskResponse, QuerySpecFilter } from '../lib/types';

const VALUELESS = ['empty', 'notEmpty'];

/** What the chip shows: the filter in words. */
export function filterLabel(filter: QuerySpecFilter): string {
  return VALUELESS.includes(filter.operator)
    ? `${filter.column} ${filter.operator}`
    : `${filter.column} ${filter.operator} ${filter.value ?? ''}`;
}

/** The same filter in the form the rows endpoint takes. */
export function filterToParam(filter: QuerySpecFilter): string {
  return VALUELESS.includes(filter.operator)
    ? `${filter.column}:${filter.operator}`
    : `${filter.column}:${filter.operator}:${filter.value ?? ''}`;
}

interface AskBoxProps {
  onAsk(question: string): Promise<AskResponse>;
  onApply(filters: string[], rankBy: string): void;
}

/**
 * Asking is deliberately not magic: the answer shows the filters that were
 * generated and how many rows they matched, so the user can see what ran
 * before deciding to keep it.
 */
export function AskBox({ onAsk, onApply }: AskBoxProps) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (question.trim() === '' || pending) return;

    setPending(true);
    setError(null);
    try {
      setResult(await onAsk(question.trim()));
    } catch (err) {
      setResult(null);
      setError(
        err instanceof ApiError ? err.message : 'Could not answer that question.',
      );
    } finally {
      setPending(false);
    }
  }

  const filters = result?.spec.filters ?? [];

  return (
    <section data-testid="ask-box">
      <h2>Ask a question</h2>
      <form className="controls" onSubmit={(event) => void submit(event)}>
        <input
          aria-label="Ask a question"
          data-testid="ask-input"
          placeholder="Which players scored at least 37?"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button type="submit" data-testid="ask-submit" disabled={pending}>
          {pending ? 'Asking…' : 'Ask'}
        </button>
      </form>

      {error && (
        <p className="error" role="alert" data-testid="ask-error">
          {error}
        </p>
      )}

      {result && (
        <div data-testid="ask-result">
          <p className="muted" data-testid="ask-explanation">
            {result.explanation}
          </p>

          <ul className="chips" data-testid="ask-filters">
            {filters.length === 0 ? (
              <li data-testid="ask-filter-chip">
                <code>no filters</code>
              </li>
            ) : (
              filters.map((filter) => (
                <li key={filterToParam(filter)} data-testid="ask-filter-chip">
                  <code>{filterLabel(filter)}</code>
                </li>
              ))
            )}
          </ul>

          <p data-testid="ask-row-count">{result.total} matching rows</p>

          <button
            type="button"
            data-testid="ask-apply"
            onClick={() =>
              onApply(filters.map(filterToParam), result.spec.rankBy ?? '')
            }
          >
            Use these filters
          </button>
        </div>
      )}
    </section>
  );
}
