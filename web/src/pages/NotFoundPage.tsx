import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="mx-auto mt-24 max-w-sm px-4 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-2 text-muted">There is nothing at this address.</p>
      <Link to="/queue" className="mt-4 inline-block text-accent underline hover:text-accent-hover">
        Go to the review queue
      </Link>
    </main>
  );
}
