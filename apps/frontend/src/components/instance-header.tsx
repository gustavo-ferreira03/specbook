"use client";

import { ArrowLeft, Settings } from "lucide-react";
import Link from "next/link";

import { useAuth } from "@/components/auth-provider";
import { Brand } from "@/components/logo-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { UserMenu } from "@/components/user-menu";

export const InstanceHeader = function InstanceHeader({
  setup = false,
}: {
  setup?: boolean;
}) {
  const { isAdmin } = useAuth();
  return (
    <header className="border-line bg-surface flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-2 sm:px-6">
      <Link href="/" className="rounded-sm">
        <Brand />
      </Link>
      <div className="flex items-center gap-2">
        {!setup && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/">
              <ArrowLeft size={14} /> Projects
            </Link>
          </Button>
        )}
        {setup && isAdmin && (
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label="Instance settings"
          >
            <Link href="/settings">
              <Settings size={16} />
            </Link>
          </Button>
        )}
        <UserMenu />
        <ThemeToggle />
      </div>
    </header>
  );
};
