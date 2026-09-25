export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface AuthResponse {
  user: User;
  token: string;
  expiresIn: number;
}

export interface CsvWarning {
  row: number;
  code: string;
  message: string;
}

export interface DatasetSummary {
  id: string;
  name: string;
  rowCount: number;
  columns: string[];
  warnings: CsvWarning[];
  createdAt: string;
}

export interface ColumnStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  stddev: number;
  sum: number;
}

export interface ColumnProfile {
  name: string;
  index: number;
  type: 'number' | 'string' | 'date' | 'boolean' | 'empty';
  count: number;
  missing: number;
  unique: number;
  stats?: ColumnStats;
  top?: { value: string; count: number }[];
}

export interface DatasetProfile {
  rowCount: number;
  columns: ColumnProfile[];
}

export interface RowsPage {
  datasetId: string;
  columns: string[];
  /** `index` is the row's 0-based position in the uploaded file. */
  rows: { row: string[]; rank: number | null; index: number }[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** What the model is allowed to produce: operations the engine already has. */
export interface QuerySpecFilter {
  column: string;
  operator: string;
  value?: string;
}

export interface QuerySpec {
  filters?: QuerySpecFilter[];
  sort?: string;
  direction?: 'asc' | 'desc';
  rankBy?: string;
  limit?: number;
}

export interface AskResponse extends RowsPage {
  spec: QuerySpec;
  explanation: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field: string; message: string }[];
  };
}

/** One flagged cell: which rule(s) put it outside the expected range. */
export interface AnomalyFlag {
  row: number;
  value: number;
  rules: ('iqr' | 'robustZ')[];
}

export interface ColumnAnomalies {
  column: string;
  insufficientData: boolean;
  flagged: AnomalyFlag[];
}

export interface AnomaliesResponse {
  datasetId: string;
  columns: ColumnAnomalies[];
}
