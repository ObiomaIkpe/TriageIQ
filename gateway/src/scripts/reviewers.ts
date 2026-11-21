import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPool } from '../database/pool.js';
import { parseDisplayName, parseEmail } from '../users/normalize.js';
import { PasswordHasher } from '../users/password-hasher.js';
import { validatePassword } from '../users/password-policy.js';
import { DuplicateEmailError, type User } from '../users/user.types.js';
import { UsersRepository } from '../users/users.repository.js';
import { readPassword } from './read-password.js';

export const USAGE = `Usage: reviewers <command> [options]

Commands:
  create --email <email> --name <display name>   create a reviewer (asks for a password)
  set-password --email <email>                   change a reviewer's password (asks for it)
  disable --email <email>                        stop a reviewer from logging in
  enable --email <email>                         allow a disabled reviewer to log in again
  list                                           show all reviewers (never their password hashes)

Passwords are never arguments: you are asked for them (typing is hidden, twice to confirm).
When input is not a terminal, one line is read from it instead (for scripts).`;

/** What the commands need from the outside. Tests pass fakes. */
export interface CliDeps {
  users: Pick<UsersRepository, 'findByEmail' | 'create' | 'setPassword' | 'setDisabled' | 'list'>;
  hasher: Pick<PasswordHasher, 'hash'>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Asks for a password. `confirm` is true when the person should type it twice. */
  askPassword: (prompt: string) => Promise<string>;
  interactive: boolean;
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => Array.from(row[i]).length)));
  return rows
    .map((row) => row.map((cell, i) => cell + ' '.repeat(widths[i] - Array.from(cell).length)).join('  ').trimEnd())
    .join('\n');
}

const describe = (user: User) => user.email;

/** Runs one command. Returns the exit code; it never throws for an expected problem. */
export async function runReviewers(argv: string[], deps: CliDeps): Promise<number> {
  const { stdout, stderr } = deps;
  const usage = (message: string) => {
    stderr(`${message}\n\n${USAGE}`);
    return EXIT_USAGE;
  };

  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    (command ? stdout : stderr)(USAGE);
    return command ? EXIT_OK : EXIT_USAGE;
  }

  let values: { email?: string; name?: string };
  try {
    ({ values } = parseArgs({ args: rest, options: { email: { type: 'string' }, name: { type: 'string' } }, strict: true, allowPositionals: false }));
  } catch (error) {
    return usage((error as Error).message);
  }

  if (command === 'list') {
    if (values.email !== undefined || values.name !== undefined) return usage('"list" takes no options.');
    const users = await deps.users.list();
    if (users.length === 0) {
      stdout('No reviewers yet.');
      return EXIT_OK;
    }
    stdout(
      table([
        ['EMAIL', 'NAME', 'ROLE', 'DISABLED', 'CREATED'],
        ...users.map((u) => [u.email, u.displayName, u.role, u.disabledAt ? 'yes' : 'no', u.createdAt.toISOString()]),
      ]),
    );
    return EXIT_OK;
  }

  if (!['create', 'set-password', 'disable', 'enable'].includes(command)) {
    return usage(`Unknown command "${command}".`);
  }
  if (values.email === undefined) return usage(`"${command}" needs --email.`);
  if (command === 'create' && values.name === undefined) return usage('"create" needs --name.');
  if (command !== 'create' && values.name !== undefined) return usage(`"${command}" does not take --name.`);

  const email = parseEmail(values.email);
  if (!email) {
    stderr('That is not a valid email address.');
    return EXIT_ERROR;
  }

  if (command === 'disable' || command === 'enable') {
    const disabling = command === 'disable';
    const result = await deps.users.setDisabled(email, disabling);
    if (!result) {
      stderr(`No reviewer with the email ${email}.`);
      return EXIT_ERROR;
    }
    stdout(
      result.changed
        ? `${disabling ? 'Disabled' : 'Enabled'} ${describe(result.user)}.`
        : `${describe(result.user)} is already ${disabling ? 'disabled' : 'enabled'}. Nothing changed.`,
    );
    return EXIT_OK;
  }

  // create and set-password both need a password. Check the account first, so nobody types a
  // password only to be told the email is taken (or unknown).
  const existing = await deps.users.findByEmail(email);
  let name: string | undefined;
  if (command === 'create') {
    name = parseDisplayName(values.name as string);
    if (!name) {
      stderr('The name must be 1 to 100 characters.');
      return EXIT_ERROR;
    }
    if (existing) {
      stderr(`A reviewer with the email ${email} already exists.`);
      return EXIT_ERROR;
    }
  } else if (!existing) {
    stderr(`No reviewer with the email ${email}.`);
    return EXIT_ERROR;
  }

  let password: string;
  try {
    password = await deps.askPassword('Password: ');
    if (deps.interactive) {
      const again = await deps.askPassword('Repeat password: ');
      if (again !== password) {
        stderr('The two passwords do not match. Nothing was changed.');
        return EXIT_ERROR;
      }
    }
  } catch {
    stderr('Cancelled. Nothing was changed.');
    return EXIT_ERROR;
  }
  const check = validatePassword(password, email);
  if (!check.ok) {
    stderr(`${check.reason} Nothing was changed.`);
    return EXIT_ERROR;
  }
  const passwordHash = await deps.hasher.hash(password);

  if (command === 'create') {
    try {
      const user = await deps.users.create({ email, displayName: name as string, passwordHash });
      stdout(`Created reviewer ${describe(user)} (${user.displayName}).`);
      return EXIT_OK;
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        stderr(`A reviewer with the email ${email} already exists.`);
        return EXIT_ERROR;
      }
      throw error;
    }
  }
  const updated = await deps.users.setPassword(email, passwordHash);
  if (!updated) {
    stderr(`No reviewer with the email ${email}.`);
    return EXIT_ERROR;
  }
  stdout(`Password changed for ${describe(updated)}.`);
  return EXIT_OK;
}

/** `node dist/scripts/reviewers.js <command> ...` */
async function main(): Promise<number> {
  const url = process.env.GATEWAY_DATABASE_URL?.trim();
  if (!url) {
    console.error('GATEWAY_DATABASE_URL is not set.');
    return EXIT_ERROR;
  }
  const pool = createPool(url, { max: 2 });
  pool.on('error', () => undefined);
  const interactive = Boolean(process.stdin.isTTY);
  try {
    return await runReviewers(process.argv.slice(2), {
      users: new UsersRepository(pool),
      hasher: new PasswordHasher(),
      stdout: (text) => console.log(text),
      stderr: (text) => console.error(text),
      // Prompts go to stderr so stdout stays clean for scripts.
      askPassword: (prompt) => readPassword(prompt, process.stdin, process.stderr),
      interactive,
    });
  } catch (error) {
    // A database problem. The message never holds the URL (the password is in it).
    const code = (error as { code?: string }).code;
    console.error(`The command failed (${code ?? (error as Error).name}). Is the gateway database reachable and migrated?`);
    return EXIT_ERROR;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
