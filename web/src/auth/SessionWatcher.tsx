import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { setUnauthorizedHandler } from '../api/client.js';

export const SESSION_ENDED_MESSAGE = 'Your session has ended. Please log in again.';

/**
 * Any 401 from an API call after login means the session is gone: forget everything and go to /login, which
 * shows why. (The login call and the /auth/me probe do not trigger this.)
 */
export function SessionWatcher() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void queryClient.cancelQueries();
      queryClient.clear();
      void navigate('/login', { replace: true, state: { sessionEnded: true } });
    });
    return () => setUnauthorizedHandler(undefined);
  }, [queryClient, navigate]);
  return null;
}
