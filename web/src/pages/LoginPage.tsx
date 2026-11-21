import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { RateLimitedError, UnauthorizedError } from '../api/errors.js';
import { SESSION_ENDED_MESSAGE } from '../auth/SessionWatcher.js';
import { useLogin, useMe } from '../auth/useAuth.js';
import { Loading } from './Loading.js';

/** Minutes to wait, rounded UP (61 seconds is 2 minutes), at least 1. */
export function minutesFor(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

function messageFor(error: Error): string {
  if (error instanceof UnauthorizedError) return 'Invalid email or password';
  if (error instanceof RateLimitedError) {
    if (error.retryAfterSeconds === undefined) return 'Too many attempts. Try again later.';
    const minutes = minutesFor(error.retryAfterSeconds);
    return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  }
  return 'Something went wrong. Please try again.';
}

export function LoginPage() {
  const me = useMe();
  const login = useLogin();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (me.isPending) return <Loading />;
  if (me.data) return <Navigate to="/queue" replace />;

  const sessionEnded = (location.state as { sessionEnded?: boolean } | null)?.sessionEnded === true;
  // The newest outcome wins: after a failed attempt its message replaces the "session ended" notice.
  const message = login.error ? messageFor(login.error) : sessionEnded ? SESSION_ENDED_MESSAGE : '';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (login.isPending) return;
    login.mutate({ email, password });
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-line bg-card p-6 shadow-sm">
        <h1 className="mb-4 text-xl font-semibold">TriageIQ</h1>

        <label htmlFor="email" className="mb-1 block font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-3 w-full rounded border border-line px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent"
        />

        <label htmlFor="password" className="mb-1 block font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-3 w-full rounded border border-line px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent"
        />

        {/* Always in the page, so a screen reader announces the text when it appears. */}
        <p aria-live="polite" className={`mb-3 min-h-5 ${login.error ? 'text-danger' : 'text-ink'}`}>
          {message}
        </p>

        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded bg-accent px-3 py-2 font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        >
          Log in
        </button>
      </form>
    </main>
  );
}
