import type { Metadata } from "next";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
