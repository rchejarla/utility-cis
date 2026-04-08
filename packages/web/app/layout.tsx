import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";
import "@/lib/fontawesome";
import { AuthSessionProvider } from "@/components/session-provider";
import { QueryProvider } from "@/lib/query-provider";
import { ThemeProvider } from "@/lib/theme-provider";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { NavProgress } from "@/components/nav-progress";
import { ToastProvider } from "@/components/ui/toast";

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
              <div style={{ display: "flex", height: "100vh" }}>
                <Sidebar />
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                  }}
                >
                  <Topbar />
                  <main
                    style={{
                      flex: 1,
                      overflow: "auto",
                      padding: "24px",
                    }}
                  >
                    {children}
                  </main>
                </div>
              </div>
            </ToastProvider>
            </ThemeProvider>
          </QueryProvider>
        </AuthSessionProvider>
      </body>
    </html>
  );
}
