interface AnomalyToggleProps {
  /** Rows flagged in at least one column; null while still loading. */
  flaggedRows: number | null;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * Narrows the rows table to statistical outliers. Disabled when there is
 * nothing to narrow to, so "on" can never mean "an empty table for no reason".
 */
export function AnomalyToggle({ flaggedRows, checked, onChange }: AnomalyToggleProps) {
  const none = flaggedRows === 0;
  return (
    <div className="row" data-testid="anomaly-toggle">
      <label>
        <input
          type="checkbox"
          data-testid="anomalies-only"
          checked={checked && !none}
          disabled={flaggedRows === null || none}
          onChange={(event) => onChange(event.target.checked)}
        />{' '}
        Show anomalies only
      </label>
      <span className="muted" data-testid="anomaly-count">
        {flaggedRows === null
          ? 'Checking for outliers…'
          : none
            ? 'No outliers found'
            : `${flaggedRows} row${flaggedRows === 1 ? '' : 's'} flagged`}
      </span>
    </div>
  );
}
