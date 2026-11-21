/** The built-in client that owns every ticket from the public form. A GATEWAY_CLIENTS entry may not use this name. */
export const PUBLIC_FORM_CLIENT = 'public-form';
/** The customer_id Python stores on public-form tickets. */
export const PUBLIC_FORM_CUSTOMER_ID = 'public-form';
/** Namespaced like every principal id, so its idempotency keys cannot collide with a real client's. */
export const PUBLIC_FORM_PRINCIPAL_ID = `client:${PUBLIC_FORM_CLIENT}`;

/** The route body limit. A ticket is at most about 5 KB of text, and JSON escaping of Unicode can triple that. */
export const PUBLIC_BODY_LIMIT = '16kb';
export const PUBLIC_BODY_LIMIT_BYTES = 16 * 1024;

export const PUBLIC_IP_WINDOW_SECONDS = 3600;
export const TURNSTILE_DEFAULT_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TIMEOUT_MS = Symbol('TURNSTILE_TIMEOUT_MS');
export const DEFAULT_TURNSTILE_TIMEOUT_MS = 5000;
export const PUBLIC_CLOCK = Symbol('PUBLIC_CLOCK');
export const PUBLIC_STORE = Symbol('PUBLIC_STORE');

/** What the customer sees. Fixed text: nothing about processing, models or why. */
export const MSG_ACCEPTED = 'Thanks, we received your message.';
export const MSG_VERIFICATION_FAILED = 'Verification failed, please try again.';
export const MSG_TURNSTILE_UNAVAILABLE = 'Please try again in a moment.';
export const MSG_DAILY_CAP = "We're receiving too many messages today. Please try again tomorrow.";
export const MSG_RATE_LIMITED = 'Too many messages from your network. Please try again later.';
