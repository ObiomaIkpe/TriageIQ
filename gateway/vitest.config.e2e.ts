import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // The files that use a real Redis share one queue, and the app now runs a worker on it.
    // One file at a time, so one file's worker can never take another file's jobs.
    fileParallelism: false,
  },
});
