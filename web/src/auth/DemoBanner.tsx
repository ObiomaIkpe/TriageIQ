/** Shown on every page of the demo room (and only there): the visitor must never mistake it for the real system. */
export function DemoBanner() {
  return (
    <div role="note" aria-label="Demo mode" className="border-b border-line bg-info-bg px-4 py-2 text-center font-medium text-info-ink">
      Demo mode — example data, resets nightly. Emails are never sent.
    </div>
  );
}
