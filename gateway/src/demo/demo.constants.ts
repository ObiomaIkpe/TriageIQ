/**
 * The demo room's fixed facts. The demo user is one shared account: everyone who clicks "Try it as a reviewer" is this user,
 * so nothing here may depend on who is asking.
 */
export const DEMO_EMAIL = 'demo@triageiq.invalid'; // .invalid can never be a real mailbox
export const DEMO_DISPLAY_NAME = 'Demo Reviewer';
/** Not a valid hash of any password: a demo user cannot log in with a password. (LoginService also refuses the role outright.) */
export const DEMO_PASSWORD_HASH = '!demo-account-has-no-password';
/** A demo session lasts one hour from the click, however busy it is. */
export const DEMO_SESSION_SECONDS = 60 * 60;

/** Who owns tickets a demo visitor submits (the BullMQ job's owner and the idempotency namespace). */
export const DEMO_FORM_CLIENT = 'demo-form';
export const DEMO_FORM_PRINCIPAL_ID = `client:${DEMO_FORM_CLIENT}`;
export const DEMO_CUSTOMER_ID = 'demo';
/** Every ticket a visitor submits has this fixed, obviously fake customer: the visitor's own address is never asked for or stored. */
export const DEMO_CUSTOMER_NAME = 'Demo Visitor';
export const DEMO_CUSTOMER_EMAIL = 'visitor@example.com';

export const DEMO_LOGIN_IP_PREFIX = 'demo:login:ip:';
export const DEMO_SUBMIT_IP_PREFIX = 'demo:submit:ip:';
export const DEMO_CAP_PREFIX = 'demo:cap:';
export const DEMO_RATE_PREFIX = 'rl:demo:ip:';
