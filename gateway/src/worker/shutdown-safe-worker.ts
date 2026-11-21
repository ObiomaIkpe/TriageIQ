import { Worker } from 'bullmq';

/** How long to wait for a connection that is not up before treating it as unreachable. */
const CONNECT_CHECK_MS = 250;
const DISCONNECT_WAIT_MS = 1000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The one thing needed from BullMQ's Redis connection: the ioredis client and its status. */
interface ConnectionLike {
  client: Promise<{ status?: string }>;
}

/**
 * A BullMQ Worker whose close() cannot hang when Redis is unreachable.
 *
 * The stock Worker waits for its main loop to finish, and that loop is stuck on a Redis
 * connection that never comes up, so close() never returns and the whole app hangs on
 * shutdown. (Tried with Redis pointing at a closed port: close() and close(true) both hung.)
 *
 * Here the hard path (drop the connections) is taken ONLY when the connection is seen to be
 * not ready. In every other case, including when the connection cannot be inspected, the
 * normal graceful close runs and waits for jobs that are running. Getting this wrong would
 * abandon running jobs, so the default is deliberately the graceful one.
 */
export class ShutdownSafeWorker extends Worker {
  override async close(force = false): Promise<void> {
    if (await this.connectionIsDown()) {
      await Promise.race([this.disconnect().catch(() => undefined), pause(DISCONNECT_WAIT_MS)]);
      return;
    }
    return super.close(force);
  }

  /** True only when the Redis connection is positively known to be not ready. */
  private async connectionIsDown(): Promise<boolean> {
    const connection = (this.backend as unknown as { connection?: ConnectionLike }).connection;
    if (!connection) return false; // cannot tell: use the graceful close
    try {
      const client = await Promise.race([
        connection.client,
        pause(CONNECT_CHECK_MS).then(() => 'not-connected' as const),
      ]);
      return client === 'not-connected' || client.status !== 'ready';
    } catch {
      return true; // the connection failed to initialise
    }
  }
}
