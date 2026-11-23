import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, ForbiddenError, RateLimitedError, ServerError, ValidationError } from '../api/errors.js';
import { LIMITS, submitPublicTicket, type PublicTicketBody } from '../api/public.js';
import { useTurnstileLoader } from '../turnstile/context.js';
import type { TurnstileWidget } from '../turnstile/types.js';

type Field = 'name' | 'email' | 'subject' | 'message';
type Values = Record<Field, string>;
type Problems = Partial<Record<Field, string>>;

const LABEL: Record<Field, string> = { name: 'Name', email: 'Email', subject: 'Subject', message: 'Message' };
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The same rules as the gateway (text is trimmed before the length is checked). */
export function validate(values: Values): Problems {
  const problems: Problems = {};
  for (const field of ['name', 'email', 'subject', 'message'] as const) {
    const text = values[field].trim();
    if (text === '') problems[field] = `${LABEL[field]} is required.`;
    else if (text.length > LIMITS[field]) problems[field] = `${LABEL[field]} must be at most ${LIMITS[field]} characters.`;
  }
  if (!problems.email && !EMAIL_SHAPE.test(values.email.trim())) problems.email = 'Enter a valid email address.';
  return problems;
}

/** The gateway's field errors, in words for the page. Fields the form does not have are left out. */
function fromGateway(errors: { field: string; problem: string }[]): { problems: Problems; other: boolean } {
  const problems: Problems = {};
  let other = false;
  for (const { field, problem } of errors) {
    if (field !== 'name' && field !== 'email' && field !== 'subject' && field !== 'message') {
      other = true;
    } else if (field === 'email' && problem === 'is invalid') {
      problems.email = 'Enter a valid email address.';
    } else if (problem.startsWith('must be at most')) {
      problems[field] = `${LABEL[field]} must be at most ${LIMITS[field]} characters.`;
    } else if (problem === 'must not be empty' || problem === 'is required') {
      problems[field] = `${LABEL[field]} is required.`;
    } else {
      problems[field] = `Check the ${LABEL[field].toLowerCase()}.`;
    }
  }
  return { problems, other };
}

const minutesFor = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

function messageFor(error: unknown): string {
  if (error instanceof RateLimitedError) {
    if (error.retryAfterSeconds === undefined) return "You've sent several messages recently. Try again later.";
    const minutes = minutesFor(error.retryAfterSeconds);
    return `You've sent several messages recently. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  }
  if (error instanceof ForbiddenError) return 'Verification failed, please try again.';
  if (error instanceof ServerError) return "We're very busy right now. Please try again later.";
  if (error instanceof ApiError && error.status === 404) return 'The contact form is currently unavailable.';
  return 'Something went wrong. Please try again.';
}

export function PublicFormPage() {
  const [sent, setSent] = useState<string | null>(null);
  const [round, setRound] = useState(0); // a new form instance (and so a new idempotency key) after "Send another message"
  if (sent !== null) {
    return (
      <Shell>
        <Success
          reference={sent}
          onAnother={() => {
            setSent(null);
            setRound((n) => n + 1);
          }}
        />
      </Shell>
    );
  }
  return (
    <Shell>
      <ContactForm key={round} onSent={setSent} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border border-line bg-card p-6 shadow-sm">{children}</div>
    </main>
  );
}

function Success({ reference, onAnother }: { reference: string; onAnother: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => heading.current?.focus(), []);

  async function copyReference() {
    try {
      await navigator.clipboard.writeText(reference);
      setCopy('copied');
      window.setTimeout(() => setCopy('idle'), 2000);
    } catch {
      setCopy('failed');
    }
  }

  return (
    <div>
      <h1 ref={heading} tabIndex={-1} className="mb-2 text-xl font-semibold outline-none">
        Thanks, we received your message.
      </h1>
      <p className="text-muted">Your reference is</p>
      <p className="my-2 font-mono text-3xl font-semibold tracking-wide" data-testid="reference">
        {reference}
      </p>
      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={() => void copyReference()} className="rounded border border-line px-3 py-1.5 hover:bg-page focus-visible:outline-2 focus-visible:outline-accent">
          Copy
        </button>
        <span role="status" aria-live="polite" className="text-muted">
          {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Could not copy. Select the reference and copy it yourself.' : ''}
        </span>
      </div>
      <button type="button" onClick={onAnother} className="rounded bg-accent px-3 py-2 font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        Send another message
      </button>
    </div>
  );
}

function ContactForm({ onSent }: { onSent: (reference: string) => void }) {
  const loadWidget = useTurnstileLoader();
  const ids = { name: useId(), email: useId(), subject: useId(), message: useId() };
  const [values, setValues] = useState<Values>({ name: '', email: '', subject: '', message: '' });
  const [honeypot, setHoneypot] = useState('');
  const [problems, setProblems] = useState<Problems>({});
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);

  // Turnstile: a token exists only after the visitor passes the check, and works for one submit.
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<TurnstileWidget | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [widgetState, setWidgetState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [widgetNote, setWidgetNote] = useState('');

  // One idempotency key per form instance, reused for a retry of the SAME message. If the text was changed since the key
  // was used, a new key is made: the gateway refuses a key reused with different content.
  const key = useRef(crypto.randomUUID());
  const keyUsedFor = useRef<string | null>(null);

  useEffect(() => {
    // StrictMode (development) runs this effect, its cleanup, and the effect again. Each run owns an AbortController: the
    // cleanup aborts it, so a run that has been cleaned up never renders a widget, and removes the one it did render.
    const controller = new AbortController();
    if (!container.current) return;
    loadWidget(container.current, {
      onToken: (t) => {
        setToken(t);
        setWidgetNote('');
      },
      onExpired: () => {
        setToken(null);
        setWidgetNote('The verification expired. Please complete it again.');
      },
      onError: () => {
        setToken(null);
        setWidgetNote('The verification could not run. Please try again.');
      },
    }, controller.signal)
      .then((w) => {
        if (controller.signal.aborted) w.remove();
        else {
          widget.current = w;
          setWidgetState('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setWidgetState('failed'); // an aborted run is not a failure
      });
    return () => {
      controller.abort();
      widget.current?.remove();
      widget.current = null;
      setToken(null); // a token belongs to the widget that made it
    };
  }, [loadWidget]);

  const set = (field: Field) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    if (problems[field]) setProblems((p) => ({ ...p, [field]: undefined }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending || token === null) return;
    const found = validate(values);
    setProblems(found);
    if (Object.keys(found).length > 0) {
      setNotice('Please check the highlighted fields.');
      return;
    }

    const content = JSON.stringify([values.name.trim(), values.email.trim().toLowerCase(), values.subject.trim(), values.message.trim()]);
    if (keyUsedFor.current !== null && keyUsedFor.current !== content) key.current = crypto.randomUUID();
    keyUsedFor.current = content;

    const body: PublicTicketBody = {
      name: values.name.trim(),
      email: values.email.trim(),
      subject: values.subject.trim(),
      message: values.message.trim(),
      turnstile_token: token,
      website: honeypot,
    };
    setSending(true);
    setNotice('');
    try {
      const answer = await submitPublicTicket(body, key.current);
      onSent(answer.reference);
    } catch (error) {
      // A token works once: whatever went wrong, ask for a new one.
      setToken(null);
      widget.current?.reset();
      if (error instanceof ValidationError) {
        const { problems: fields, other } = fromGateway(error.fieldErrors);
        setProblems(fields);
        setNotice(Object.keys(fields).length > 0 && !other ? 'Please check the highlighted fields.' : 'Please check the form and try again.');
      } else {
        setNotice(messageFor(error));
      }
      setSending(false);
    }
  }

  const over = values.message.trim().length > LIMITS.message;
  const input = 'mb-1 w-full rounded border border-line bg-card px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent';
  const row = (field: Field, type: string, autoComplete: string) => (
    <div className="mb-3">
      <label htmlFor={ids[field]} className="mb-1 block font-medium">
        {LABEL[field]}
      </label>
      <input
        id={ids[field]}
        name={field}
        type={type}
        autoComplete={autoComplete}
        value={values[field]}
        onChange={(e) => set(field)(e.target.value)}
        aria-invalid={problems[field] ? true : undefined}
        aria-describedby={problems[field] ? `${ids[field]}-error` : undefined}
        className={input}
      />
      {problems[field] ? (
        <p id={`${ids[field]}-error`} className="text-danger">
          {problems[field]}
        </p>
      ) : null}
    </div>
  );

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <h1 className="mb-1 text-xl font-semibold">Contact support</h1>
      <p className="mb-4 text-muted">We usually reply within one working day.</p>

      {row('name', 'text', 'name')}
      {row('email', 'email', 'email')}
      {row('subject', 'text', 'off')}

      <div className="mb-3">
        <label htmlFor={ids.message} className="mb-1 block font-medium">
          Message
        </label>
        <textarea
          id={ids.message}
          name="message"
          rows={7}
          value={values.message}
          onChange={(e) => set('message')(e.target.value)}
          aria-invalid={problems.message ? true : undefined}
          aria-describedby={`${ids.message}-count${problems.message ? ` ${ids.message}-error` : ''}`}
          className={input}
        />
        <p id={`${ids.message}-count`} className={`text-xs ${over ? 'text-danger' : 'text-muted'}`}>
          {values.message.length} / {LIMITS.message}
        </p>
        {problems.message ? (
          <p id={`${ids.message}-error`} className="text-danger">
            {problems.message}
          </p>
        ) : null}
      </div>

      {/* The honeypot: off-screen (not display:none, which bots skip), hidden from assistive technology and the keyboard. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Website
          <input name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
        </label>
      </div>

      <div ref={container} className="mb-3 min-h-[65px]" />
      {widgetState === 'failed' ? <p className="mb-3 text-danger">Verification couldn't load. Check your connection and refresh.</p> : null}
      {widgetNote ? <p className="mb-3 text-danger">{widgetNote}</p> : null}

      <p aria-live="polite" className="mb-3 min-h-5 text-danger">
        {notice}
      </p>

      <button
        type="submit"
        disabled={token === null || sending || widgetState === 'failed'}
        className="w-full rounded bg-accent px-3 py-2 font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}
