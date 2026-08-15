export type NetworkStatus =
  | "normal"
  | "high_traffic"
  | "low_traffic"
  | "down"
  | "not_internet";

export type TrafficMetric = {
  id: string;
  recorded_at: string;
  interval_seconds: number;
  bytes_in: number;
  bytes_out: number;
  packet_count: number;
  avg_latency_ms: number | null;
  packet_loss_pct: number | null;
  gateway_reachable: boolean;
  dns_reachable: boolean;
  protocol_breakdown: Record<string, number>;
  status: NetworkStatus;
};

