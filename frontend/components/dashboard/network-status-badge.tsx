"use client";

import { useTranslation } from "react-i18next";
import type { NetworkStatus } from "@/lib/traffic-metrics";

const statusConfig: Record<
  NetworkStatus,
  { labelKey: string; icon: string; className: string }
> = {
  normal: {
    labelKey: "normal",
    icon: "●",
    className: "bg-severity-low/10 text-severity-low",
  },
  low_traffic: {
    labelKey: "lowTraffic",
    icon: "▼",
    className: "bg-severity-medium/10 text-severity-medium",
  },
  high_traffic: {
    labelKey: "highTraffic",
    icon: "▲",
    className: "bg-severity-high/10 text-severity-high",
  },
  down: {
    labelKey: "gatewayDown",
    icon: "×",
    className: "bg-severity-critical/10 text-severity-critical",
  },
  not_internet: {
    labelKey: "internetUnavailable",
    icon: "!",
    className: "bg-severity-critical/10 text-severity-critical",
  },
};

export function NetworkStatusBadge({ status }: { status: NetworkStatus }) {
  const { t } = useTranslation("dashboard");
  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-meta font-medium ${config.className}`}
    >
      <span aria-hidden="true">{config.icon}</span>
      {t(`networkStatus.${config.labelKey}`)}
    </span>
  );
}
