// `node dist/scripts/demo-sessions.js end`: ends every session of the shared demo user (run by the nightly demo reset).
// Needs GATEWAY_DATABASE_URL (to find the demo user's id) and REDIS_URL (where the sessions live). Prints counts only.
import { pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import { DEMO_EMAIL } from '../demo/demo.constants.js';
import { createPool } from '../database/pool.js';
import { revokeUserSessions } from '../sessions/session.store.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

async function main(argv: string[]): Promise<number> {
  if (argv[0] !== 'end') {
    console.error('Usage: demo-sessions end');
    return 2;
  }
  const dbUrl = process.env.GATEWAY_DATABASE_URL?.trim();
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!dbUrl || !redisUrl) {
    console.error('GATEWAY_DATABASE_URL and REDIS_URL must be set.');
    return EXIT_ERROR;
  }
  const pool = createPool(dbUrl, { max: 1 });
  pool.on('error', () => undefined);
  const redis = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2000, retryStrategy: () => null });
  redis.on('error', () => undefined);
  try {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE role = 'demo' AND email = $1`, [DEMO_EMAIL]);
    if (rows.length === 0) {
      console.log('No demo user exists (demo mode was never on). No sessions to end.');
      return EXIT_OK;
    }
    await redis.connect();
    const ended = await revokeUserSessions(redis, rows[0].id);
    console.log(`Ended ${ended} demo session${ended === 1 ? '' : 's'}.`);
    return EXIT_OK;
  } catch (error) {
    // Never the URLs (they hold passwords).
    console.error(`Could not end the demo sessions (${(error as { code?: string }).code ?? (error as Error).name}).`);
    return EXIT_ERROR;
  } finally {
    await pool.end().catch(() => undefined);
    redis.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
