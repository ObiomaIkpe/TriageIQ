import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * The fake gateway. Each test installs the answers it needs with server.use(...).
 * The one standing answer: the demo is OFF (404), which is what the real gateway says without DEMO_MODE, so the login page
 * shows no demo button unless a test turns it on.
 */
export const server = setupServer(http.get('/api/demo/status', () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })));
