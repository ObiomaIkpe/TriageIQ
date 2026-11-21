import { api } from './client.js';
import { UnauthorizedError } from './errors.js';

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: 'reviewer';
}

export interface Me {
  user: User;
  expires_at: string;
}

/** The logged-in user, or null when there is no session (a 401 here is "logged out", not an error). */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>('/auth/me', { sessionEndsOn401: false });
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

export function login(email: string, password: string): Promise<Me> {
  return api<Me>('/auth/login', { method: 'POST', body: { email, password }, sessionEndsOn401: false });
}

export function logout(): Promise<void> {
  return api<void>('/auth/logout', { method: 'POST', sessionEndsOn401: false });
}
