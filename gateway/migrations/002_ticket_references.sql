-- Every ticket reference (TKT-XXXXXX) the gateway hands out is reserved here first, so two tickets can
-- never be given the same one (the customer is told the reference before Python has seen the ticket).
-- A reference is reserved once and never released: one reserved for a ticket that then failed to queue
-- is simply never used again. References Python generated before the gateway took over are not in this
-- table (Python's own unique constraint still refuses a clash with them: its 409 reference_conflict).
CREATE TABLE ticket_references (
  reference  text        PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
