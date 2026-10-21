import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";
import "@/lib/fontawesome";
import { AuthSessionProvider } from "@/components/session-provider";
import { QueryProvider } from "@/lib/query-provider";
import { ThemeProvider } from "@/lib/theme-provider";
import { NavProgress } from "@/components/nav-progress";
import { ToastProvider } from "@/components/ui/toast";
import { AppShell } from "@/components/app-shell";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
});

export const metadata: Metadata = {
  title: "Utility CIS",
  description: "Utility Customer Information System",
};

/**
 * Sets `data-theme` before the first paint.
 *
 * The server has no idea which theme this person chose — the choice is in
 * `localStorage`, which only the browser can read — so the markup used to
 * ship `data-theme="dark"` and `ThemeProvider` corrected it in an effect
 * after hydration. Every single load therefore painted dark and then
 * flipped, which is what anyone on the light theme saw on every login.
 *
 * A blocking script in `<head>` is the standard answer and the only one
 * that works: it runs before the body is parsed, so the first paint is
 * already right. It must agree with `getEffectiveMode` in
 * `lib/theme-provider.tsx` — same key, same values, same treatment of
 * "system" — and it fails silently, because a private window can throw on
 * `localStorage` and a missing theme is worth less than a blank page.
 */
const THEME_BOOTSTRAP = `
try {
  var m = localStorage.getItem('theme-mode');
  if (m !== 'dark' && m !== 'light' && m !== 'system') m = 'dark';
  if (m === 'system') {
    m = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', m);
} catch (e) {}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    /* `data-theme` is the default for a browser that never runs the
       script below; the script replaces it before anything is painted. */
    <html lang="en" data-theme="dark" className={dmSans.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body style={{ margin: 0, padding: 0 }}>
        <AuthSessionProvider>
          <QueryProvider>
            <ThemeProvider>
              <ToastProvider>
              <NavProgress />
              <AppShell>{children}</AppShell>
            </ToastProvider>
            </ThemeProvider>
          </QueryProvider>
        </AuthSessionProvider>
      </body>
    </html>
  );
}
