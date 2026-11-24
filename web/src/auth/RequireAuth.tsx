import { Navigate, Outlet } from 'react-router';
import { Loading } from '../pages/Loading.js';
import { DemoBanner } from './DemoBanner.js';
import { isDemo, useMe } from './useAuth.js';

/** Routes inside need a session. While it is being checked nothing else is shown (no flash of the login page). */
export function RequireAuth() {
  const me = useMe();
  if (me.isPending) return <Loading />;
  if (me.isError) return <FailedCheck onRetry={() => void me.refetch()} />;
  if (me.data === null) return <Navigate to="/login" replace />;
  return (
    <>
      {isDemo(me.data) ? <DemoBanner /> : null}
      <Outlet />
    </>
  );
}

function FailedCheck({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="mx-auto mt-24 max-w-sm px-4 text-center">
      <p role="alert">Something went wrong. Please try again.</p>
      <button type="button" onClick={onRetry} className="mt-3 rounded bg-accent px-3 py-1.5 text-on-accent hover:bg-accent-hover">
        Retry
      </button>
    </main>
  );
}
