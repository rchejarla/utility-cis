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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" className={dmSans.variable}>
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
