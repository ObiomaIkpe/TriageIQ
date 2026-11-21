const POLL_MS = 20;

/**
 * Waits for an ioredis connection to be up, but only within the caller's deadline. Polling (not
 * a listener) so a request that gives up leaves nothing behind. With the connection down this
 * ends in the usual 503 after the deadline.
 */
export async function waitUntilReady(
  redis: { readonly status: string },
  expired: () => boolean,
): Promise<void> {
  while (redis.status !== 'ready') {
    if (expired()) throw new Error('Redis connection is not ready');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
