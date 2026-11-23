import { Route, Routes } from 'react-router';
import { RequireAuth } from './auth/RequireAuth.js';
import { SessionWatcher } from './auth/SessionWatcher.js';
import { LoginPage } from './pages/LoginPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { PublicFormPage } from './pages/PublicFormPage.js';
import { QueuePage } from './pages/QueuePage.js';

/** "/" is the customers' contact form; reviewers use /login and /queue. UI routes never start with /api (that prefix belongs to the API proxy). */
export function App() {
  return (
    <>
      <SessionWatcher />
      <Routes>
        {/* The public contact form: no login, and it never asks /api/auth/me who you are. */}
        <Route path="/" element={<PublicFormPage />} />
        <Route path="/submit" element={<PublicFormPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/queue" element={<QueuePage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}
