"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { logoutAction } from "@/app/actions/auth";
import { LanguageSelector } from "@/components/language-selector";
import { Button } from "@/components/ui/button";
import type { ProfileRole } from "@/lib/auth";

const navigation = [
  { href: "/dashboard", key: "dashboard" },
  { href: "/traffic", key: "traffic" },
  { href: "/history", key: "history" },
  { href: "/alerts", key: "alerts" },
  { href: "/devices", key: "devices" },
  { href: "/snmp", key: "snmp" },
  { href: "/diagnostics", key: "diagnostics" },
];

type AppNavigationProps = {
  fullName: string;
  role: ProfileRole;
};

export function AppNavigation({ fullName, role }: AppNavigationProps) {
  const { t } = useTranslation("common");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const links =
    role === "admin"
      ? [...navigation, { href: "/admin", key: "admin" }]
      : navigation;

  const sidebar = (
    <div className="flex h-full flex-col bg-bg-surface p-4">
      <div className="border-b border-border pb-4">
        <p className="text-section font-semibold">{t("appName")}</p>
        <p className="mt-1 text-meta text-text-muted">{t("networkVisibility")}</p>
      </div>

      <nav className="mt-4 flex flex-1 flex-col gap-1" aria-label={t("nav.main")}>
        {links.map((link) => {
          const active = pathname === link.href;

          return (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={`rounded-control border px-3 py-2 text-body font-medium transition-colors ${
                active
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-transparent text-text-secondary hover:border-border hover:text-text-primary"
              }`}
            >
              {t(`nav.${link.key}`)}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border pt-4">
        <LanguageSelector />
        <p className="truncate text-body font-medium">{fullName}</p>
        <p className="mt-1 text-meta capitalize text-text-muted">{t(`roles.${role}`)}</p>
        <form action={logoutAction} className="mt-3">
          <Button className="w-full" variant="secondary" type="submit">
            {t("actions.signOut")}
          </Button>
        </form>
      </div>
    </div>
  );

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-border md:block">
        {sidebar}
      </aside>

      <header className="flex items-center justify-between border-b border-border bg-bg-surface p-4 md:hidden">
        <p className="font-semibold">{t("appName")}</p>
        <button
          type="button"
          aria-label={t("nav.open")}
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="rounded-control border border-border px-3 py-2 text-section"
        >
          ☰
        </button>
      </header>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label={t("nav.close")}
            className="absolute inset-0 bg-bg-base/80"
            onClick={() => setOpen(false)}
          />
          <aside className="relative h-full w-64 border-r border-border">
            <button
              type="button"
              aria-label={t("nav.close")}
              onClick={() => setOpen(false)}
              className="absolute right-4 top-4 z-10 text-section text-text-secondary"
            >
              ×
            </button>
            {sidebar}
          </aside>
        </div>
      ) : null}
    </>
  );
}
