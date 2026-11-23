import { focusManager } from '@tanstack/react-query';

/**
 * TanStack Query refetches "on focus" only when the tab becomes visible again (visibilitychange). Clicking from one
 * browser window to another window that is still visible (side by side) fires no such event, only a window "focus".
 * Listen to both, so coming back to the queue always refreshes it.
 */
export function installFocusListener(): void {
  focusManager.setEventListener((handleFocus) => {
    // handleFocus() with no argument means "refetch now" (a boolean would only act when the focused state CHANGES).
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') handleFocus();
    };
    const onFocus = () => handleFocus();
    window.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  });
}
