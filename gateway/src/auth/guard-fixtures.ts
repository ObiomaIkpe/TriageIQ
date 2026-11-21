import { type ExecutionContext, type HttpException, SetMetadata } from '@nestjs/common';
import type { AuthedRequest } from './auth.decorators.js';

export const config = (values: Record<string, unknown>) => ({ get: (name: string) => values[name] }) as never;

/** A handler and a controller class carrying the same metadata Nest decorators would set. */
export function route(metadata: Record<string, unknown> = {}) {
  const handler = () => undefined;
  class Controller {}
  for (const [key, value] of Object.entries(metadata)) {
    SetMetadata(key, value)(Controller.prototype, 'handler', { value: handler });
  }
  return { handler, Controller };
}

export function context(target: ReturnType<typeof route>, request: Partial<AuthedRequest>, headers: Record<string, string> = {}) {
  const request_ = { headers: {}, ...request } as AuthedRequest;
  const response = { headers, setHeader: (name: string, value: string) => (headers[name] = value) };
  const ctx = {
    getHandler: () => target.handler,
    getClass: () => target.Controller,
    switchToHttp: () => ({ getRequest: () => request_, getResponse: () => response }),
  } as unknown as ExecutionContext;
  return { ctx, request: request_, headers };
}

export function thrown(fn: () => unknown): HttpException {
  try {
    fn();
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a throw');
}
