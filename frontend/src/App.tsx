import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';

import { useAuth } from './lib/auth';
import { LoginPage } from './pages/LoginPage';
import { DatasetsPage } from './pages/DatasetsPage';
import { DatasetPage } from './pages/DatasetPage';

function RequireAuth({ children }: { children: ReactElement }) {
  const { token, ready } = useAuth();
  // Wait for the stored-token check before deciding, otherwise a reload would
  // bounce a signed-in user back to the login screen.
  if (!ready) return <p className="muted centered">Loading…</p>;
  return token ? children : <Navigate to="/" replace />;
}

function LandingRoute() {
  const { token, ready } = useAuth();
  if (!ready) return <p className="muted centered">Loading…</p>;
  return token ? <Navigate to="/datasets" replace /> : <LoginPage />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingRoute />} />
      <Route
        path="/datasets"
        element={
          <RequireAuth>
            <DatasetsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/datasets/:id"
        element={
          <RequireAuth>
            <DatasetPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
