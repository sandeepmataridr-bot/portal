import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installScreenLock } from './lib/screenLock';
import { WindLandingPage } from './pages/landing/WindLandingPage';
import './pages/landing/standalone.css';

// The public home page on its own (vite.landing.config.ts), served by
// Cloudflare Pages at https://0dh.in. No router, auth or API: the staff app
// is a separate deployment at VITE_APP_URL, which the sign-in icon opens.
installScreenLock();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WindLandingPage />
  </StrictMode>,
);
