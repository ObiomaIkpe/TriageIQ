import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { demoLogin, fetchDemoEnabled, fetchMe, login, logout, type Me } from '../api/auth.js';
import { ApiError, UnauthorizedError } from '../api/errors.js';

export const ME_KEY = ['me'] as const;

/** The session: `data` is the user's Me, null when logged out, undefined while it is still being checked. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    retry: false, // a failed check is shown as an error, not retried in the background
    staleTime: 30_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation<Me, ApiError, { email: string; password: string }>({
    mutationFn: ({ email, password }) => login(email, password),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_KEY, me);
      void navigate('/queue', { replace: true });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  function end() {
    void queryClient.cancelQueries();
    queryClient.clear(); // nothing of the old session (user, later data) may stay in memory
    void navigate('/login', { replace: true });
  }

  return useMutation<void, ApiError>({
    mutationFn: logout,
    onSuccess: end,
    // A 401 means the server has already forgotten the session: the same result for the user.
    onError: (error) => {
      if (error instanceof UnauthorizedError) end();
    },
  });
}

/** Whether the login page offers "Try it as a reviewer". Asked once; the gateway answers 404 when the demo is off. */
export function useDemoEnabled() {
  return useQuery({ queryKey: ['demo-enabled'], queryFn: fetchDemoEnabled, retry: false, staleTime: 5 * 60_000 });
}

export function useDemoLogin() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation<Me, ApiError>({
    mutationFn: demoLogin,
    onSuccess: (me) => {
      queryClient.setQueryData(ME_KEY, me);
      void navigate('/queue', { replace: true });
    },
  });
}

/** True when the logged-in user is the shared demo visitor. */
export const isDemo = (me: Me | null | undefined): boolean => me?.user.role === 'demo';
