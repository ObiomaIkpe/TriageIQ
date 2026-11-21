-- Reviewer accounts. Emails are stored trimmed and lowercased by the application; the CHECK
-- makes the database refuse anything else, so the unique index really is case-insensitive.
-- password_hash is an Argon2id PHC string (its parameters are inside it).
-- password_changed_at and disabled_at will be used to end old sessions (M4.1b).
CREATE TABLE users (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text        NOT NULL,
  display_name        text        NOT NULL,
  password_hash       text        NOT NULL,
  role                text        NOT NULL,
  disabled_at         timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 100),
  CONSTRAINT users_role_check CHECK (role IN ('reviewer'))
);
