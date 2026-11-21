import { http, HttpResponse } from 'msw';

export const ADA = {
  user: { id: '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34', email: 'tony@triageiq.local', display_name: 'Ọbiọma Ụzọ', role: 'reviewer' },
  expires_at: '2026-11-21T20:00:00.000Z',
};

/** What the gateway answers, by name. */
export const answers = {
  loggedIn: () => http.get('/api/auth/me', () => HttpResponse.json(ADA)),
  loggedOut: () => http.get('/api/auth/me', () => HttpResponse.json({ message: 'Not authenticated' }, { status: 401 })),
  loginOk: () => http.post('/api/auth/login', () => HttpResponse.json(ADA)),
  loginStatus: (status: number, headers: Record<string, string> = {}) =>
    http.post('/api/auth/login', () => HttpResponse.json({ message: 'x' }, { status, headers })),
  loginNetworkError: () => http.post('/api/auth/login', () => HttpResponse.error()),
  logoutOk: () => http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })),
};
