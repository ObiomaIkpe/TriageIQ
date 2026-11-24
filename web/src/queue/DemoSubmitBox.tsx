import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, ForbiddenError, RateLimitedError, ServerError, ValidationError } from '../api/errors.js';
import { DEMO_LIMITS, submitDemoTicket } from '../api/demo.js';
import { useTurnstileLoader } from '../turnstile/context.js';
import type { TurnstileWidget } from '../turnstile/types.js';

function messageFor(error: unknown): string {
  if (error instanceof RateLimitedError) return 'You have sent several test tickets recently. Try again later.';
  if (error instanceof ForbiddenError) return 'Verification failed, please try again.';
  if (error instanceof ServerError) return 'The demo has reached its limit for today, or is busy. Please try again later.';
  if (error instanceof ValidationError) return 'Please check the subject and the message.';
  if (error instanceof ApiError && error.status === 404) return 'Test tickets are not available right now.';
  return 'Something went wrong. Please try again.';
}

/**
 * Demo only. A subject and a message: it makes a REAL triage run (the AI really classifies and drafts), saved as a demo ticket
 * for the fixed customer "Demo Visitor". It then shows up in the queue for every demo visitor until the nightly reset.
 */
export function DemoSubmitBox({ onSent }: { onSent: (reference: string) => void }) {
  const loadWidget = useTurnstileLoader();
  const ids = { subject: useId(), message: useId() };
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);

  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<TurnstileWidget | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [widgetState, setWidgetState] = useState<'loading' | 'ready' | 'failed'>('loading');

  // One key per message: a retry of the SAME text makes one ticket; changed text gets a new key.
  const key = useRef(crypto.randomUUID());
  const keyUsedFor = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    if (!container.current) return;
    loadWidget(
      container.current,
      {
        onToken: (t) => {
          setToken(t);
          setNotice('');
        },
        onExpired: () => {
          setToken(null);
          setNotice('The verification expired. Please complete it again.');
        },
        onError: () => {
          setToken(null);
          setNotice('The verification could not run. Please try again.');
        },
      },
      controller.signal,
    )
      .then((w) => {
        if (controller.signal.aborted) w.remove();
        else {
          widget.current = w;
          setWidgetState('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setWidgetState('failed');
      });
    return () => {
      controller.abort();
      widget.current?.remove();
      widget.current = null;
      setToken(null);
    };
  }, [loadWidget]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending || token === null) return;
    const cleanSubject = subject.trim();
    const cleanMessage = message.trim();
    if (cleanSubject === '' || cleanMessage === '') {
      setNotice('Please fill in both the subject and the message.');
      return;
    }
    if (cleanSubject.length > DEMO_LIMITS.subject || cleanMessage.length > DEMO_LIMITS.message) {
      setNotice(`The subject may have ${DEMO_LIMITS.subject} characters and the message ${DEMO_LIMITS.message}.`);
      return;
    }
    const content = JSON.stringify([cleanSubject, cleanMessage]);
    if (keyUsedFor.current !== null && keyUsedFor.current !== content) key.current = crypto.randomUUID();
    keyUsedFor.current = content;

    setSending(true);
    setNotice('');
    try {
      const answer = await submitDemoTicket({ subject: cleanSubject, message: cleanMessage, turnstile_token: token }, key.current);
      setSubject('');
      setMessage('');
      key.current = crypto.randomUUID();
      keyUsedFor.current = null;
      onSent(answer.reference);
    } catch (error) {
      setNotice(messageFor(error));
    } finally {
      // A token works once, whatever happened.
      setToken(null);
      widget.current?.reset();
      setSending(false);
    }
  }

  const input = 'mb-2 w-full rounded border border-line bg-card px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <details className="mb-3 rounded border border-line bg-card" aria-label="Submit a test ticket">
      <summary className="cursor-pointer px-3 py-2 font-medium">Submit a test ticket</summary>
      <form onSubmit={(event) => void submit(event)} className="border-t border-line p-3" noValidate>
        <p className="mb-2 text-muted">
          Write a support message and watch the AI triage it for real. It will be visible to other demo visitors until the nightly reset.
        </p>
        <label htmlFor={ids.subject} className="mb-1 block font-medium">
          Subject
        </label>
        <input id={ids.subject} value={subject} onChange={(e) => setSubject(e.target.value)} className={input} maxLength={DEMO_LIMITS.subject} />
        <label htmlFor={ids.message} className="mb-1 block font-medium">
          Message
        </label>
        <textarea id={ids.message} value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className={input} maxLength={DEMO_LIMITS.message} />
        <div ref={container} className="mb-2 min-h-[65px]" />
        {widgetState === 'failed' ? <p className="mb-2 text-danger">Verification couldn't load. Check your connection and refresh.</p> : null}
        <p aria-live="polite" className="mb-2 min-h-5 text-danger">
          {notice}
        </p>
        <button
          type="submit"
          disabled={token === null || sending || widgetState === 'failed'}
          className="rounded bg-accent px-3 py-1.5 font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {sending ? 'Sending…' : 'Send test ticket'}
        </button>
      </form>
    </details>
  );
}
