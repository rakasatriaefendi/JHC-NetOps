import type { NetworkStatus } from "@/lib/traffic-metrics";

const statusConfig: Record<
  NetworkStatus,
  { label: string; icon: string; className: string }
> = {
  normal: {
    label: "Normal",
    icon: "●",
    className: "bg-severity-low/10 text-severity-low",
  },
  low_traffic: {
    label: "Low traffic",
    icon: "▼",
    className: "bg-severity-medium/10 text-severity-medium",
  },
  high_traffic: {
    label: "High traffic",
    icon: "▲",
    className: "bg-severity-high/10 text-severity-high",
  },
  down: {
    label: "Gateway down",
    icon: "×",
    className: "bg-severity-critical/10 text-severity-critical",
  },
  not_internet: {
    label: "DNS / internet unavailable",
    icon: "!",
    className: "bg-severity-critical/10 text-severity-critical",
  },
};

export function NetworkStatusBadge({ status }: { status: NetworkStatus }) {
  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-meta font-medium ${config.className}`}
    >
      <span aria-hidden="true">{config.icon}</span>
      {config.label}
    </span>
  );
}

