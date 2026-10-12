import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Recursive } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_INIT_SCRIPT } from "@/lib/theme-script";
import { AuthProvider } from "@/components/AuthProvider";
import { SetupGate } from "@/components/SetupGate";
import { RunStateAnnouncementProvider } from "@/components/RunStateAnnouncement";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const recursive = Recursive({ subsets: ["latin"], axes: ["CASL"], variable: "--font-recursive" });

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" className={`${geist.variable} ${geistMono.variable} ${recursive.variable}`} suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
            </head>
            <body><TooltipProvider><AuthProvider><SetupGate><RunStateAnnouncementProvider>{children}</RunStateAnnouncementProvider></SetupGate></AuthProvider></TooltipProvider></body>
        </html>
    );
}
