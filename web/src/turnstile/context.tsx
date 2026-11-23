import { createContext, useContext, type ReactNode } from 'react';
import { realTurnstile } from './real.js';
import type { TurnstileLoader } from './types.js';

const TurnstileContext = createContext<TurnstileLoader>(realTurnstile);

/** Lets a test (or a story) put a fake widget in place of Cloudflare's. */
export function TurnstileProvider({ loader, children }: { loader: TurnstileLoader; children: ReactNode }) {
  return <TurnstileContext.Provider value={loader}>{children}</TurnstileContext.Provider>;
}

export const useTurnstileLoader = (): TurnstileLoader => useContext(TurnstileContext);
