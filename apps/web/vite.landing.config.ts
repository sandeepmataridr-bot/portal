import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The public home page as a static site of its own, for Cloudflare Pages
 * (https://0dh.in): `pnpm --filter @infusion/web build:landing` writes
 * dist-landing/. The staff app (login, dashboards, /api) is deployed
 * separately at APP_URL; see docs/deployment.md.
 */
const APP_URL = (process.env.VITE_APP_URL ?? 'https://app.0dh.in').replace(/\/$/, '');

/** Staff pages someone may still open at the home page's address; they move to the app. */
const APP_PATHS = ['/login', '/app', '/change-password', '/admin', '/doctor', '/reception', '/pharmacy', '/insurance', '/super', '/central-station'];

/**
 * The security headers infra/docker/Caddyfile sends for the app, for every
 * file of this site. The page loads only its own files and calls nothing.
 */
const HEADERS = `/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'; manifest-src 'self'; upgrade-insecure-requests
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  X-Permitted-Cross-Domain-Policies: none
  Origin-Agent-Cluster: ?1

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

/** Cloudflare Pages reads _headers and _redirects from the site's root. */
function pagesFiles(): Plugin {
  return {
    name: 'cloudflare-pages-files',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: HEADERS });
      this.emitFile({
        type: 'asset',
        fileName: '_redirects',
        source: APP_PATHS.map((path) => `${path} ${APP_URL}${path} 302\n`).join(''),
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./landing-site', import.meta.url)),
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  plugins: [react(), pagesFiles()],
  define: { 'import.meta.env.VITE_APP_URL': JSON.stringify(APP_URL) },
  build: { outDir: fileURLToPath(new URL('./dist-landing', import.meta.url)), emptyOutDir: true },
});
