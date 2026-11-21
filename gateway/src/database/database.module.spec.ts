import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database.module.js';
import { PG_POOL } from './database.constants.js';
import { createPool } from './pool.js';

describe('createPool', () => {
  it('has a small pool, a connect timeout and a statement timeout', async () => {
    const pool = createPool('postgresql://u:p@127.0.0.1:1/db');
    expect(pool.options.max).toBe(10);
    expect(pool.options.connectionTimeoutMillis).toBe(2000);
    expect(pool.options.statement_timeout).toBe(5000);
    expect(pool.options.application_name).toBe('triageiq-gateway');
    await pool.end();
  });

  it('migrations can turn the statement timeout off and use fewer connections', async () => {
    const pool = createPool('postgresql://u:p@127.0.0.1:1/db', { statementTimeoutMs: 0, max: 2 });
    expect(pool.options.statement_timeout).toBe(0);
    expect(pool.options.max).toBe(2);
    await pool.end();
  });

  it('connects lazily: creating it needs no database', async () => {
    const started = Date.now();
    const pool = createPool('postgresql://u:p@127.0.0.1:1/db');
    expect(Date.now() - started).toBeLessThan(100);
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });
});

describe('DatabaseModule', () => {
  async function startApp(url: string) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ GATEWAY_DATABASE_URL: url })] }),
        DatabaseModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return { app, pool: app.get(PG_POOL) as ReturnType<typeof createPool> };
  }

  it('provides a pool from GATEWAY_DATABASE_URL', async () => {
    const { app, pool } = await startApp('postgresql://u:p@127.0.0.1:1/db');
    expect(pool.options.connectionString).toBe('postgresql://u:p@127.0.0.1:1/db');
    await app.close();
  });

  it('app.close() does not hang when the database is unreachable and a query is waiting', async () => {
    const { app, pool } = await startApp('postgresql://u:p@127.0.0.1:1/db');
    const pending = pool.query('SELECT 1').catch(() => undefined); // tries to connect to a closed port
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2600); // bounded by the 2 s close wait
    await pending;
  });

  it('app.close() with an idle pool returns at once', async () => {
    const { app } = await startApp('postgresql://u:p@127.0.0.1:1/db');
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('an error on an idle connection is handled (no unhandled error event that would crash the app)', async () => {
    const { app, pool } = await startApp('postgresql://u:p@127.0.0.1:1/db');
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    expect(() => pool.emit('error', Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).not.toThrow();
    await app.close();
  });
});
