import { Navigate, Route, Routes } from 'react-router';
import { RequireAuth } from './auth/RequireAuth.js';
import { SessionWatcher } from './auth/SessionWatcher.js';
import { LoginPage } from './pages/LoginPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { QueuePage } from './pages/QueuePage.js';

/** UI routes never start with /api (that prefix belongs to the API proxy). */
export function App() {
  return (
    <>
      <SessionWatcher />
      <Routes>
        <Route path="/" element={<Navigate to="/queue" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/queue" element={<QueuePage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}
