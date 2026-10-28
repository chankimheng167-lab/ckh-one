import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'CKH ONE Sales',
  description: 'Sales force automation for CKH ONE',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1f6feb' };

const apiOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1').origin;
  } catch {
    return '';
  }
})();
/**
 * Content-Security-Policy for the static app: scripts only from this origin
 * (Next.js needs inline bootstrap scripts), API calls only to the CKH ONE
 * API, no plugins, no foreign forms, no <base> hijacking. `next dev` needs
 * eval for hot reload, so 'unsafe-eval' is allowed in development only.
 */
const devEval = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${devEval}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigin}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={CSP} />
        <meta name="referrer" content="no-referrer" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
