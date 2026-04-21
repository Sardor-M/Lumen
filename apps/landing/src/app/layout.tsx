import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import { SITE_NAME, TAGLINE, DESCRIPTION } from '@lumen/brand';
import './globals.css';

const jetbrainsMono = JetBrains_Mono({
    subsets: ['latin'],
    weight: ['400', '500', '600', '700'],
    variable: '--font-mono',
    display: 'swap',
});

export const metadata: Metadata = {
    title: `${SITE_NAME} — ${TAGLINE}`,
    description: DESCRIPTION.long,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning className={jetbrainsMono.variable}>
            <body>{children}</body>
        </html>
    );
}
