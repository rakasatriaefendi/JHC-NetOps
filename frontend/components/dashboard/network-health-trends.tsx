"use client";

import { useMemo, useState } from "react";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Area,
} from "recharts";

import { Button } from "@/components/ui/button";
import type { NetworkHealthTarget, NetworkHealthSample } from "@/lib/network-health";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-panel border border-border bg-bg-surface p-4 md:p-6">
      <h2 className="text-section font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

type HealthTrendsProps = {
  targets: NetworkHealthTarget[];
  samples: NetworkHealthSample[];
};

interface SamplePoint {
  time: string;
  [targetId: string]: string | number | null;
}

function HealthTrendChart({ samples, targets, metric, range, onRangeChange }: {
  samples: { target_id: string; sampled_at: string; latency_ms: number | null; packet_loss_percent: number; status: string; sample_count: number }[];
  targets: { id: string; name: string; ip_address: string }[];
  metric: "latency" | "loss";
  range: string;
  onRangeChange: (range: string) => void;
}) {
  const ranges = [
    { value: "1h", label: "1h" },
    { value: "6h", label: "6h" },
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
  ];

  const isLatency = metric === "latency";
  const yUnit = isLatency ? "ms" : "%";
  const domain = isLatency ? [0, "auto"] : [0, 100];

  function formatTooltipTime(value: string) {
    return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
  }

  if (!samples.length) {
    return (
      <div className="rounded-control border border-border bg-bg-base p-6 text-center">
        <p className="text-text-secondary">Tidak ada data historis untuk rentang ini.</p>
        <p className="mt-2 text-meta text-text-muted">Data akan muncul setelah Health Watch mengumpulkan beberapa sampel.</p>
      </div>
    );
  }

  const targetIds = [...new Set(samples.map((s) => s.target_id))];
  const colorMap = new Map<string, string>();
  const hueStep = 360 / Math.max(1, targetIds.length);
  targetIds.forEach((id, i) => {
    colorMap.set(id, `hsl(${(i * hueStep) % 360}, 70%, 50%)`);
  });

  const dataByTime = new Map<string, SamplePoint>();
  samples.forEach((s) => {
    const bucket = s.sampled_at;
    if (!dataByTime.has(bucket)) {
      dataByTime.set(bucket, { time: bucket });
    }
    const point = dataByTime.get(bucket)!;
    const key = `target_${s.target_id}`;
    if (isLatency) {
      point[key] = s.latency_ms;
    } else {
      point[key] = s.packet_loss_percent;
    }
  });

  const chartData = Array.from(dataByTime.values()).sort((a, b) => a.time.localeCompare(b.time));

  const hasData = chartData.some((d) => targetIds.some((id) => d[`target_${id}`] !== null && d[`target_${id}`] !== undefined));

  if (!hasData) {
    return (
      <div className="rounded-control border border-border bg-bg-base p-6 text-center">
        <p className="text-text-secondary">Tidak ada data {isLatency ? "latency" : "packet loss"} untuk rentang ini.</p>
        <p className="mt-2 text-meta text-text-muted">Data akan muncul setelah Health Watch mengumpulkan beberapa sampel.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="text-meta font-medium text-text-secondary">Target:</span>
          <span className="font-data text-text-primary">All monitored targets ({targets.length})</span>
        </div>
        <div className="flex items-center gap-2">
          {ranges.map((r) => (
            <Button
              key={r.value}
              variant={range === r.value ? "primary" : "secondary"}
              onClick={() => onRangeChange(r.value)}
              className="px-2 py-1 text-sm"
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="rounded-control border border-border bg-bg-base p-4" style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="time"
              tickFormatter={formatTooltipTime}
              tick={{ fill: "hsl(var(--text-secondary))", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickCount={6}
            />
            <YAxis
              domain={domain as [number, number] | [number, "auto"]}
              tickFormatter={(v) => `${v}${yUnit}`}
              tick={{ fill: "hsl(var(--text-secondary))", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={isLatency ? 50 : 40}
            />
            <Tooltip
              contentStyle={{ backgroundColor: "hsl(var(--bg-surface))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
            />
            <Legend
              layout="vertical"
              align="right"
              verticalAlign="top"
              iconType="line"
              iconSize={12}
              formatter={(value: string) => {
                const target = targets.find((t) => `target_${t.id}` === value);
                return target ? `${target.name} (${target.ip_address})` : value;
              }}
            />
            {targetIds.map((targetId) => {
              const target = targets.find((t) => t.id === targetId);
              if (!target) return null;
              const color = colorMap.get(targetId) ?? "hsl(var(--accent))";
              return (
                <Area
                  key={`area-${targetId}`}
                  type="monotone"
                  dataKey={`target_${targetId}`}
                  stroke={color}
                  fill={color.replace("70%, 50%", "70%, 10%")}
                  strokeWidth={2}
                  connectNulls={false}
                  dot={false}
                />
              );
            })}
            {targetIds.map((targetId) => {
              const target = targets.find((t) => t.id === targetId);
              if (!target) return null;
              const color = colorMap.get(targetId) ?? "hsl(var(--accent))";
              return (
                <Line
                  key={`line-${targetId}`}
                  type="monotone"
                  dataKey={`target_${targetId}`}
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                />
              );
            })}
            {!hasData && isLatency && (
              <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle" fill="hsl(var(--text-muted))" fontSize={12}>
                Tidak ada data latency (target offline/timeout)
              </text>
            )}
            {!hasData && !isLatency && (
              <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle" fill="hsl(var(--text-muted))" fontSize={12}>
                Tidak ada packet loss tercatat
              </text>
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-4 text-meta text-text-secondary">
        <span>{isLatency ? "Latency dihitung dari sampel yang merespons ICMP. Gap = target offline/timeout." : "Packet loss dihitung dari window pendek (5 probe)."}</span>
      </div>
    </div>
  );
}

function SingleTargetChart({ samples, target, metric, range, onRangeChange }: {
  samples: { target_id: string; sampled_at: string; latency_ms: number | null; packet_loss_percent: number; status: string; sample_count: number }[];
  target: { name: string; ip_address: string } | null;
  metric: "latency" | "loss";
  range: string;
  onRangeChange: (range: string) => void;
}) {
  const ranges = [
    { value: "1h", label: "1h" },
    { value: "6h", label: "6h" },
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
  ];

  const data = samples
    .filter((s) => s.status !== "offline" || metric === "loss")
    .map((s) => ({
      time: s.sampled_at,
      latency: s.latency_ms,
      loss: s.packet_loss_percent,
      status: s.status,
      sample_count: s.sample_count,
    }));

  const hasLatencyData = data.some((d) => d.latency !== null);
  const hasLossData = data.some((d) => d.loss !== null && d.loss > 0);

  if (!data.length) {
    return (
      <div className="rounded-control border border-border bg-bg-base p-6 text-center">
        <p className="text-text-secondary">Tidak ada data historis untuk rentang ini.</p>
        <p className="mt-2 text-meta text-text-muted">Data akan muncul setelah Health Watch mengumpulkan beberapa sampel.</p>
      </div>
    );
  }

  const isLatency = metric === "latency";
  const yUnit = isLatency ? "ms" : "%";
  const domain = isLatency ? [0, "auto"] : [0, 100];

  function formatTooltipTime(value: string) {
    return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="text-meta font-medium text-text-secondary">Target:</span>
          <span className="font-data text-text-primary">{target?.name ?? "Unknown"} ({target?.ip_address})</span>
        </div>
        <div className="flex items-center gap-2">
          {ranges.map((r) => (
            <Button
              key={r.value}
              variant={range === r.value ? "primary" : "secondary"}
              onClick={() => onRangeChange(r.value)}
              className="px-2 py-1 text-sm"
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="rounded-control border border-border bg-bg-base p-4" style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="time"
              tickFormatter={formatTooltipTime}
              tick={{ fill: "hsl(var(--text-secondary))", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickCount={6}
            />
            <YAxis
              domain={domain as [number, number] | [number, "auto"]}
              tickFormatter={(v) => `${v}${yUnit}`}
              tick={{ fill: "hsl(var(--text-secondary))", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={isLatency ? 50 : 40}
            />
            <Tooltip
              formatter={(value: number, name: string) => [
                name === "latency" ? `${value.toFixed(1)} ms` : `${value.toFixed(1)}%`,
                name === "latency" ? "Latency" : "Loss",
              ]}
            />
            <Legend />
            {isLatency && hasLatencyData && (
              <Area
                type="monotone"
                dataKey="latency"
                stroke="hsl(var(--accent))"
                fill="hsl(var(--accent) / 0.1)"
                strokeWidth={2}
                connectNulls={false}
              />
            )}
            {isLatency && hasLatencyData && (
              <Line
                type="monotone"
                dataKey="latency"
                stroke="hsl(var(--accent))"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            )}
            {!isLatency && hasLossData && (
              <Area
                type="monotone"
                dataKey="loss"
                stroke="hsl(var(--severity-medium))"
                fill="hsl(var(--severity-medium) / 0.1)"
                strokeWidth={2}
                connectNulls={true}
              />
            )}
            {!isLatency && hasLossData && (
              <Line
                type="monotone"
                dataKey="loss"
                stroke="hsl(var(--severity-medium))"
                strokeWidth={2}
                dot={false}
                connectNulls={true}
              />
            )}
            {!hasLatencyData && isLatency && (
              <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle" fill="hsl(var(--text-muted))" fontSize={12}>
                Tidak ada data latency (target offline/timeout)
              </text>
            )}
            {!hasLossData && !isLatency && (
              <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle" fill="hsl(var(--text-muted))" fontSize={12}>
                Tidak ada packet loss tercatat
              </text>
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center gap-4 text-meta text-text-secondary">
        <span>{isLatency ? "Latency dihitung dari sampel yang merespons ICMP. Gap = target offline/timeout." : "Packet loss dihitung dari window pendek (5 probe)."}</span>
      </div>
    </div>
  );
}

interface TargetOption {
  id: string;
  name: string;
  ip_address: string;
}

export function NetworkHealthTrends({ targets, samples }: HealthTrendsProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<string>("__all__");
  const [range, setRange] = useState<"1h" | "6h" | "24h" | "7d">("1h");
  const [metric, setMetric] = useState<"latency" | "loss">("latency");

  const targetOptions = useMemo<TargetOption[]>(() => [
    { id: "__all__", name: "All monitored targets", ip_address: "" },
    ...targets.map((t) => ({ id: t.id, name: t.node.name, ip_address: t.node.ip_address })),
  ], [targets]);

  const selectedTarget = targetOptions.find((t) => t.id === selectedTargetId) ?? targetOptions[0];
  const isAllTargets = selectedTargetId === "__all__";

  const targetSamples = samples.filter((s) => isAllTargets || s.target_id === selectedTargetId);
  const targetListForChart = isAllTargets ? targets.map(t => ({ id: t.id, name: t.node.name, ip_address: t.node.ip_address })) : [selectedTarget];

  return (
    <Section title="Network health trends">
      <p className="mt-2 text-text-secondary">Latency dan packet loss historis untuk target yang dimonitor. Data diambil dari sampel Health Watch (interval 60 detik, retensi 7 hari).</p>

      <div className="mt-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <label className="text-meta text-text-secondary">Target:</label>
            <select
              className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary"
              value={selectedTargetId}
              onChange={(e) => setSelectedTargetId(e.target.value as string)}
            >
              {targetOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id === "__all__" ? "All monitored targets" : `${t.name} (${t.ip_address})`}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-meta text-text-secondary">Metrik:</label>
            <div className="flex gap-2">
              {["latency", "loss"].map((m) => (
                <Button
                  key={m}
                  variant={metric === m ? "primary" : "secondary"}
                  onClick={() => setMetric(m as "latency" | "loss")}
                  className="px-2 py-1 text-sm"
                >
                  {m === "latency" ? "Latency" : "Packet Loss"}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-meta text-text-secondary">Rentang:</label>
            <select
              className="rounded-control border border-border bg-bg-base px-3 py-2 text-text-primary"
              value={range}
              onChange={(e) => setRange(e.target.value as "1h" | "6h" | "24h" | "7d")}
            >
              <option value="1h">1 jam</option>
              <option value="6h">6 jam</option>
              <option value="24h">24 jam</option>
              <option value="7d">7 hari</option>
            </select>
          </div>
        </div>

        {isAllTargets ? (
          <HealthTrendChart
            samples={targetSamples}
            targets={targetListForChart}
            metric={metric}
            range={range}
            onRangeChange={(r) => setRange(r as "1h" | "6h" | "24h" | "7d")}
          />
        ) : (
          <SingleTargetChart
            samples={targetSamples}
            target={selectedTarget ? { name: selectedTarget.name, ip_address: selectedTarget.ip_address } : null}
            metric={metric}
            range={range}
            onRangeChange={(r) => setRange(r as "1h" | "6h" | "24h" | "7d")}
          />
        )}
      </div>
    </Section>
  );
}