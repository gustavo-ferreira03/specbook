import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Recursive } from "next/font/google";

import { AuthProvider } from "@/components/auth-provider";
import { RunStateAnnouncementProvider } from "@/components/run-state-announcement";
import { SetupGate } from "@/components/setup-gate";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_INIT_SCRIPT } from "@/lib/theme-script";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});
const recursive = Recursive({
  subsets: ["latin"],
  axes: ["CASL"],
  variable: "--font-recursive",
});

export const metadata: Metadata = {
  title: "Specbook",
  description: "Living specs for web applications",
  icons: { icon: "/specbook-icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

const RootLayout = function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable} ${recursive.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* oxlint-disable react/no-danger -- The inserted markup is escaped code highlighting produced by Prism, not raw user HTML. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* oxlint-enable react/no-danger */}
      </head>
      <body>
        <TooltipProvider>
          <AuthProvider>
            <SetupGate>
              <RunStateAnnouncementProvider>
                {children}
              </RunStateAnnouncementProvider>
            </SetupGate>
          </AuthProvider>
        </TooltipProvider>
      </body>
    </html>
  );
};
export default RootLayout;
