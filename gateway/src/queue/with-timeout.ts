/** The queue could not be reached in time, or the call failed. Carries no details on purpose. */
export class QueueUnavailableError extends Error {
  constructor() {
    super('Queue unavailable');
    this.name = 'QueueUnavailableError';
  }
}

class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with a TimeoutError if `work` takes longer than `ms`. Never leaves a timer running.
 * `onTimeout` runs at the moment the deadline passes, before the rejection.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // If the timeout wins, a later failure of `work` must not become an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new TimeoutError());
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
