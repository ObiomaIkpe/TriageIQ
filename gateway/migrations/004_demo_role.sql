-- Demo mode: a second kind of user, role 'demo'. There is exactly ONE (the shared "Demo Reviewer" account the "Try it as a
-- reviewer" button logs in as): the partial unique index makes the database refuse a second one. It has no usable password:
-- the application never accepts a password for a demo user (see LoginService), and its password_hash is a constant that is not
-- a valid hash of anything. The gateway makes sure the row exists when DEMO_MODE=true.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('reviewer', 'demo'));
CREATE UNIQUE INDEX users_one_demo_idx ON users (role) WHERE role = 'demo';
