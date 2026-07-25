import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../styles.css';

export const metadata: Metadata = {
  title: 'Kairo — Learn any creative tool',
  description: 'Talk to Kairo, show it what you mean, and get visual guidance directly on your screen.',
  applicationName: 'Kairo',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' }
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]
  },
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: 'Kairo — Learn any creative tool',
    description: 'Talk to Kairo, show it what you mean, and get visual guidance directly on your screen.',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'Kairo logo' }]
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/og-image.png']
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
