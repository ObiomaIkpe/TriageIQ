import { DuplicateEmailError, type User } from '../users/user.types.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runReviewers, type CliDeps } from './reviewers.js';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const user = (over: Partial<User> = {}): User => ({
  id: 'id-1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  role: 'reviewer',
  disabledAt: null,
  passwordChangedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const GOOD_PASSWORD = 'a long and unusual passphrase';

function setup(options: { existing?: User; interactive?: boolean; passwords?: string[]; dupOnCreate?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const stored: Record<string, unknown>[] = [];
  const passwords = [...(options.passwords ?? [GOOD_PASSWORD, GOOD_PASSWORD])];
  let current = options.existing;
  const deps: CliDeps = {
    users: {
      findByEmail: async (email) => (current && current.email === email ? { ...current, passwordHash: '$argon2id$OLD' } : undefined),
      create: async (input) => {
        if (options.dupOnCreate) throw new DuplicateEmailError();
        stored.push({ op: 'create', ...input });
        current = user({ email: input.email, displayName: input.displayName });
        return current;
      },
      setPassword: async (email, hash) => {
        stored.push({ op: 'setPassword', email, hash });
        return current && current.email === email ? current : undefined;
      },
      setDisabled: async (email, disabled) => {
        if (!current || current.email !== email) return undefined;
        const already = (current.disabledAt !== null) === disabled;
        stored.push({ op: 'setDisabled', email, disabled, changed: !already });
        if (!already) current = { ...current, disabledAt: disabled ? NOW : null };
        return { user: current, changed: !already };
      },
      list: async () => (current ? [current] : []),
    },
    hasher: { hash: async (password: string) => `HASH(${password.length})` },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    askPassword: async (prompt) => {
      asked.push(prompt);
      const next = passwords.shift();
      if (next === undefined) throw new Error('cancelled');
      return next;
    },
    interactive: options.interactive ?? false,
  };
  return { deps, out, err, asked, stored };
}

const run = (argv: string[], options?: Parameters<typeof setup>[0]) => {
  const world = setup(options);
  return runReviewers(argv, world.deps).then((code) => ({ code, ...world }));
};

describe('reviewers create', () => {
  it('creates a reviewer, with the email normalized and the name trimmed; stores only a hash', async () => {
    const { code, out, stored } = await run(['create', '--email', ' Ada@Example.COM ', '--name', '  Ada Lovelace ']);
    expect(code).toBe(EXIT_OK);
    expect(stored).toEqual([{ op: 'create', email: 'ada@example.com', displayName: 'Ada Lovelace', passwordHash: `HASH(${GOOD_PASSWORD.length})` }]);
    expect(out.join('\n')).toBe('Created reviewer ada@example.com (Ada Lovelace).');
    expect(JSON.stringify(stored)).not.toContain(GOOD_PASSWORD);
  });

  it('interactive: asks twice (the second time to confirm) and accepts matching passwords', async () => {
    const { code, asked } = await run(['create', '--email', 'a@b.co', '--name', 'A'], { interactive: true });
    expect(code).toBe(EXIT_OK);
    expect(asked).toEqual(['Password: ', 'Repeat password: ']);
  });

  it('interactive: passwords that differ -> exit 1, nothing stored', async () => {
    const { code, err, stored } = await run(['create', '--email', 'a@b.co', '--name', 'A'], {
      interactive: true,
      passwords: [GOOD_PASSWORD, GOOD_PASSWORD + 'x'],
    });
    expect(code).toBe(EXIT_ERROR);
    expect(err.join('\n')).toContain('do not match');
    expect(stored).toEqual([]);
  });

  it('not a terminal: reads one line only, with no confirmation', async () => {
    const { asked } = await run(['create', '--email', 'a@b.co', '--name', 'A'], { interactive: false });
    expect(asked).toEqual(['Password: ']);
  });

  it('a duplicate email -> clear error, exit 1, and the password is NOT even asked for', async () => {
    const { code, err, asked } = await run(['create', '--email', 'ADA@example.com', '--name', 'Ada'], { existing: user() });
    expect(code).toBe(EXIT_ERROR);
    expect(err.join('\n')).toBe('A reviewer with the email ada@example.com already exists.');
    expect(asked).toEqual([]);
  });

  it('a duplicate that appears between the check and the insert (a race) is the same clean error', async () => {
    const { code, err } = await run(['create', '--email', 'a@b.co', '--name', 'A'], { dupOnCreate: true });
    expect(code).toBe(EXIT_ERROR);
    expect(err.join('\n')).toContain('already exists');
  });

  it.each([
    ['too short', 'short'],
    ['too common', 'password1234'],
    ['the email local part', 'ada.lovelace'],
  ])('a password that is %s -> its reason, exit 1, nothing stored', async (_label, password) => {
    const { code, err, stored } = await run(['create', '--email', 'ada.lovelace@example.com', '--name', 'Ada'], { passwords: [password] });
    expect(code).toBe(EXIT_ERROR);
    expect(err.join('\n')).toMatch(/Nothing was changed\.$/);
    expect(stored).toEqual([]);
    expect(err.join('\n')).not.toContain(password === 'short' ? 'zzzz' : `"${password}"`);
  });

  it('an invalid email or name -> exit 1 before any password is asked', async () => {
    const bad = await run(['create', '--email', 'nope', '--name', 'A']);
    expect(bad.code).toBe(EXIT_ERROR);
    expect(bad.err.join('')).toContain('not a valid email');
    const noName = await run(['create', '--email', 'a@b.co', '--name', '   ']);
    expect(noName.code).toBe(EXIT_ERROR);
    expect(noName.err.join('')).toContain('1 to 100 characters');
    expect(bad.asked).toEqual([]);
    expect(noName.asked).toEqual([]);
  });

  it('cancelling the password prompt changes nothing', async () => {
    const { code, err, stored } = await run(['create', '--email', 'a@b.co', '--name', 'A'], { passwords: [] });
    expect(code).toBe(EXIT_ERROR);
    expect(err.join('')).toContain('Cancelled');
    expect(stored).toEqual([]);
  });
});

describe('reviewers set-password', () => {
  it('changes the password of an existing reviewer', async () => {
    const { code, out, stored } = await run(['set-password', '--email', 'ada@example.com'], { existing: user() });
    expect(code).toBe(EXIT_OK);
    expect(out.join('')).toBe('Password changed for ada@example.com.');
    expect(stored).toEqual([{ op: 'setPassword', email: 'ada@example.com', hash: `HASH(${GOOD_PASSWORD.length})` }]);
  });

  it('an unknown email -> clear error, exit 1, no prompt', async () => {
    const { code, err, asked } = await run(['set-password', '--email', 'who@example.com']);
    expect(code).toBe(EXIT_ERROR);
    expect(err.join('')).toBe('No reviewer with the email who@example.com.');
    expect(asked).toEqual([]);
  });

  it('applies the password rules (against that reviewer\'s email)', async () => {
    const { code, err } = await run(['set-password', '--email', 'ada@example.com'], { existing: user(), passwords: ['ada@example.com'] });
    expect(code).toBe(EXIT_ERROR);
    expect(err.join('')).toContain('must not be the email');
  });
});

describe('reviewers disable and enable', () => {
  it('disable then enable, each with a clear message', async () => {
    const world = setup({ existing: user() });
    expect(await runReviewers(['disable', '--email', 'ada@example.com'], world.deps)).toBe(EXIT_OK);
    expect(await runReviewers(['enable', '--email', 'ada@example.com'], world.deps)).toBe(EXIT_OK);
    expect(world.out).toEqual(['Disabled ada@example.com.', 'Enabled ada@example.com.']);
  });

  it('is idempotent: disabling twice, enabling an enabled account', async () => {
    const world = setup({ existing: user() });
    await runReviewers(['disable', '--email', 'ada@example.com'], world.deps);
    expect(await runReviewers(['disable', '--email', 'ada@example.com'], world.deps)).toBe(EXIT_OK);
    expect(world.out.at(-1)).toBe('ada@example.com is already disabled. Nothing changed.');

    const fresh = setup({ existing: user() });
    expect(await runReviewers(['enable', '--email', 'ada@example.com'], fresh.deps)).toBe(EXIT_OK);
    expect(fresh.out).toEqual(['ada@example.com is already enabled. Nothing changed.']);
  });

  it.each(['disable', 'enable'])('%s on an unknown email -> clear error, exit 1', async (command) => {
    const { code, err } = await run([command, '--email', 'who@example.com']);
    expect(code).toBe(EXIT_ERROR);
    expect(err.join('')).toBe('No reviewer with the email who@example.com.');
  });

  it('never asks for a password', async () => {
    const { asked } = await run(['disable', '--email', 'ada@example.com'], { existing: user() });
    expect(asked).toEqual([]);
  });
});

describe('reviewers list', () => {
  it('prints email, name, role, disabled yes/no and created_at; never a hash', async () => {
    const { code, out } = await run(['list'], { existing: user({ disabledAt: NOW }) });
    expect(code).toBe(EXIT_OK);
    const [header, line] = out.join('\n').split('\n');
    expect(header.split(/\s{2,}/)).toEqual(['EMAIL', 'NAME', 'ROLE', 'DISABLED', 'CREATED']);
    expect(line.split(/\s{2,}/)).toEqual(['ada@example.com', 'Ada Lovelace', 'reviewer', 'yes', '2026-11-21T12:00:00.000Z']);
    expect(out.join('')).not.toMatch(/argon2|hash/i);
  });

  it('shows "no" for an enabled reviewer, and says so when there are none', async () => {
    expect((await run(['list'], { existing: user() })).out.join('\n')).toContain('  no  ');
    expect((await run(['list'])).out).toEqual(['No reviewers yet.']);
  });
});

describe('usage errors (exit 2)', () => {
  it.each([
    [[], 'no command'],
    [['frobnicate'], 'Unknown command "frobnicate".'],
    [['create'], '"create" needs --email.'],
    [['create', '--email', 'a@b.co'], '"create" needs --name.'],
    [['disable'], '"disable" needs --email.'],
    [['disable', '--email', 'a@b.co', '--name', 'x'], 'does not take --name'],
    [['list', '--email', 'a@b.co'], '"list" takes no options.'],
    [['create', '--email', 'a@b.co', '--name', 'A', '--password', 'secret-pass-123'], 'Unknown option'],
    [['create', '--email', 'a@b.co', '--name', 'A', 'extra'], 'Unexpected argument'],
  ])('%j -> exit 2', async (argv) => {
    const { code, err } = await run(argv as string[]);
    expect(code).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('Usage: reviewers');
  });

  it('there is no --password option: a password cannot be passed on the command line (shell history)', async () => {
    const { code, err, stored, asked } = await run(['create', '--email', 'a@b.co', '--name', 'A', '--password', 'secret-pass-123']);
    expect(code).toBe(EXIT_USAGE);
    expect(stored).toEqual([]);
    expect(asked).toEqual([]);
    expect(err.join('')).toContain('Unknown option');
  });

  it('--help prints the usage and exits 0', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(EXIT_OK);
    expect(out.join('')).toContain('Passwords are never arguments');
  });
});

describe('no secret ever reaches the output', () => {
  it('neither the password nor a hash is printed on any path', async () => {
    const world = setup({ interactive: true });
    await runReviewers(['create', '--email', 'a@b.co', '--name', 'A'], world.deps);
    await runReviewers(['set-password', '--email', 'a@b.co'], { ...world.deps, askPassword: async () => GOOD_PASSWORD });
    await runReviewers(['list'], world.deps);
    const everything = [...world.out, ...world.err].join('\n');
    expect(everything).not.toContain(GOOD_PASSWORD);
    expect(everything).not.toMatch(/HASH\(|argon2/);
  });
});
