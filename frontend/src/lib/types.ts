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
  rows: { row: string[]; rank: number | null }[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field: string; message: string }[];
  };
}
