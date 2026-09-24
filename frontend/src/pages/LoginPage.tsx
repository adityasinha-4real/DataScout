import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';

type Mode = 'login' | 'register';

export function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await (mode === 'register' ? register(email, password) : login(email, password));
      navigate('/datasets');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not reach the server.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="card centered">
      <h1>DataScout</h1>
      <p className="muted">Upload a CSV, see what is in it, rank what matters.</p>

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          data-testid="tab-register"
          aria-selected={mode === 'register'}
          className={mode === 'register' ? 'active' : ''}
          onClick={() => setMode('register')}
        >
          Create account
        </button>
        <button
          type="button"
          role="tab"
          data-testid="tab-login"
          aria-selected={mode === 'login'}
          className={mode === 'login' ? 'active' : ''}
          onClick={() => setMode('login')}
        >
          Sign in
        </button>
      </div>

      <form onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <button type="submit" data-testid="submit-auth" disabled={busy}>
          {mode === 'register' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      {error && (
        <p className="error" role="alert" data-testid="auth-error">
          {error}
        </p>
      )}
    </main>
  );
}
