-- One row per ticket whose approved reply is to be emailed. It records THAT and HOW the delivery went, nothing more:
-- no email address and no reply text (the worker fetches both from the Python service at send time), so this table
-- holds no customer data. ticket_id is the primary key: one ticket, at most one delivery.
-- status: queued (waiting or being sent), sent, failed (see last_error: a short generic phrase), or
-- skipped_no_email (the ticket has no customer email, so there was nobody to send to).
CREATE TABLE reply_deliveries (
  ticket_id  uuid        PRIMARY KEY,
  reference  text        NOT NULL,
  status     text        NOT NULL,
  attempts   integer     NOT NULL DEFAULT 0,
  last_error text,
  queued_at  timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reply_deliveries_status_check CHECK (status IN ('queued', 'sent', 'failed', 'skipped_no_email')),
  CONSTRAINT reply_deliveries_attempts_check CHECK (attempts >= 0)
);
-- The sweep looks for old queued rows.
CREATE INDEX reply_deliveries_status_queued_idx ON reply_deliveries (status, queued_at);
