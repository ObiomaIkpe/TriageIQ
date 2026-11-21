import { useLogout, useMe } from '../auth/useAuth.js';

/** M4.3a placeholder: the shell the real queue (M4.3b) will fill. */
export function QueuePage() {
  const me = useMe();
  const logout = useLogout();
  const name = me.data?.user.display_name ?? '';
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-line bg-card px-4 py-2">
        <span className="font-semibold">TriageIQ · Review queue</span>
        <div className="flex items-center gap-3">
          <span>{name}</span>
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="rounded border border-line px-3 py-1 hover:bg-page focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
          >
            Log out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl p-4">
        <p role="alert" className="min-h-5 text-danger">
          {logout.isError ? 'Could not log out. Please try again.' : ''}
        </p>
        <p>The review queue arrives in the next step.</p>
      </main>
    </div>
  );
}
