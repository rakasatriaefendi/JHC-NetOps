"use client";

import { useTranslation } from "react-i18next";
import type { ProfileStatus } from "@/lib/auth";

const statusStyles: Record<ProfileStatus, string> = {
  pending: "bg-severity-medium/10 text-severity-medium",
  approved: "bg-severity-low/10 text-severity-low",
  rejected: "bg-severity-critical/10 text-severity-critical",
  disabled: "border border-border bg-bg-base text-text-muted",
};

export function StatusBadge({ status }: { status: ProfileStatus }) {
  const { t } = useTranslation("common");
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-meta font-medium ${statusStyles[status]}`}
    >
      <span aria-hidden="true">●</span>
      {t(`status.${status}`)}
    </span>
  );
}
