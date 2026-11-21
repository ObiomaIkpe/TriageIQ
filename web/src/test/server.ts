import { setupServer } from 'msw/node';

/** The fake gateway. Each test installs the answers it needs with server.use(...). */
export const server = setupServer();
