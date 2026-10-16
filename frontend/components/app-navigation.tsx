"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { logoutAction } from "@/app/actions/auth";
import { LanguageSelector } from "@/components/language-selector";
import { Button } from "@/components/ui/button";
import type { ProfileRole } from "@/lib/auth";
import { profileDisplayLabel, profileInitials } from "@/lib/profile-display";

const navigation = [
  { key: "networkOperations", items: [
    { href: "/dashboard", key: "dashboard" },
    { href: "/traffic", key: "traffic" },
    { href: "/history", key: "history" },
    { href: "/alerts", key: "alerts" },
    { href: "/devices", key: "devices" },
    { href: "/snmp", key: "snmp" },
    { href: "/diagnostics", key: "diagnostics" },
  ] },
  { key: "assetManagement", items: [
    { href: "/assets", key: "assets" },
    { href: "/medical-equipment", key: "medicalEquipment" },
  ] },
] as const;

type AppNavigationProps = {
  fullName: string;
  email: string;
  role: ProfileRole;
};

export function AppNavigation({ fullName, email, role }: AppNavigationProps) {
  const { t } = useTranslation("common");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const initials = profileInitials(fullName, email);
  const groups = role === "admin"
    ? [...navigation, { key: "administration", items: [{ href: "/admin", key: "admin" }] }] as const
    : navigation;

  const sidebar = (
    <div data-sidebar="shell" className="flex h-full min-h-0 flex-col overflow-y-auto sidebar-scrollbar bg-bg-surface p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="shrink-0 border-b border-border pb-4 pr-8">
        <p className="text-section font-semibold">{t("appName")}</p>
        <p className="mt-1 text-meta text-text-muted">{t("networkVisibility")}</p>
      </div>

      <nav data-sidebar="navigation" className="mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto sidebar-scrollbar overscroll-contain [@media(max-height:480px)]:flex-none [@media(max-height:480px)]:overflow-visible" aria-label={t("nav.main")}>
        {groups.map((group, groupIndex) => <div className={groupIndex ? "mt-4" : ""} key={group.key}>
          <p className="mb-1 px-3 text-meta font-medium uppercase tracking-wide text-text-muted">{t(`nav.${group.key}`)}</p>
          <div className="flex flex-col gap-1">{group.items.map((link) => {
            const active = link.href === "/snmp"
              ? pathname === "/snmp" || /^\/snmp\/[^/]+\/hosts$/.test(pathname)
              : link.href === "/medical-equipment" ? pathname === link.href || pathname.startsWith(`${link.href}/`) : pathname === link.href;
            const className = `rounded-control border px-3 py-2 text-left text-body font-medium transition-colors ${active ? "border-accent bg-accent/10 text-accent" : "border-transparent text-text-secondary hover:border-border hover:text-text-primary"}`;
            return <Link href={link.href} onClick={() => setOpen(false)} className={className} key={link.key}>{t(`nav.${link.key}`)}</Link>;
          })}</div>
        </div>)}
      </nav>

      <div data-sidebar="account" className="mt-4 shrink-0 border-t border-border pt-4">
        <div className="mb-3 flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-bg-base text-meta font-semibold">
            {initials ?? <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg>}
          </span>
          <div className="min-w-0">
            <p className="truncate text-body font-medium">{profileDisplayLabel(fullName, email, null, t("profile.title"))}</p>
            <p className="mt-1 text-meta capitalize text-text-muted">{t(`roles.${role}`)}</p>
          </div>
        </div>
        <LanguageSelector />
        <Link href="/profile" onClick={() => setOpen(false)} aria-label={t("profile.title")}
          aria-current={pathname === "/profile" ? "page" : undefined}
          className={`flex w-full items-center gap-2 rounded-control border px-4 py-2 text-body font-medium transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent ${pathname === "/profile" ? "border-accent bg-accent/10 text-accent" : "border-border bg-bg-base text-text-primary hover:border-accent hover:bg-accent/10 hover:text-accent"}`}>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg>
          <span>{t("profile.title")}</span>
        </Link>
        <form action={logoutAction} className="mt-2">
          <Button className="flex w-full items-center gap-2 bg-bg-base hover:bg-accent/10" variant="secondary" type="submit">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H4V3h5M14 7l5 5-5 5M8 12h11" /></svg>
            {t("actions.signOut")}
          </Button>
        </form>
      </div>
    </div>
  );

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-40 hidden h-dvh min-h-0 w-64 border-r border-border md:block">
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
        <div className="fixed inset-0 z-50 h-dvh md:hidden">
          <button
            type="button"
            aria-label={t("nav.close")}
            className="absolute inset-0 bg-bg-base/80"
            onClick={() => setOpen(false)}
          />
          <aside className="relative h-full min-h-0 w-64 max-w-full border-r border-border">
            <button
              type="button"
              aria-label={t("nav.close")}
              onClick={() => setOpen(false)}
              className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 text-section text-text-secondary"
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
