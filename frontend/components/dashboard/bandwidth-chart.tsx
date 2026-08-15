import type { BandwidthMeasurement } from "@/lib/diagnostics";

const CHART_WIDTH = 640;
const CHART_HEIGHT = 220;
const PADDING = { top: 16, right: 16, bottom: 32, left: 48 };
const MAX_POINTS_PER_PATH = 24;

type BandwidthChartProps = {
  measurements: BandwidthMeasurement[];
};

export function BandwidthChart({ measurements }: BandwidthChartProps) {
  const series = groupMeasurements(measurements);

  if (series.length === 0) {
    return <EmptyChart />;
  }

  return (
    <div className="grid gap-4">
      {series.map(({ key, label, points }) => (
        <BandwidthSeries key={key} label={label} points={points} />
      ))}
    </div>
  );
}

function BandwidthSeries({
  label,
  points,
}: {
  label: string;
  points: BandwidthMeasurement[];
}) {
  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;
  const maxBitrate = Math.max(...points.map((point) => point.bitrate_mbps), 1);
  const coordinates = points.map((point, index) => ({
    x:
      PADDING.left +
      (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth),
    y: PADDING.top + plotHeight - (point.bitrate_mbps / maxBitrate) * plotHeight,
    point,
  }));
  const path = coordinates
    .map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");
  const latest = points.at(-1)!;
  const yTicks = [maxBitrate, maxBitrate / 2, 0];

  return (
    <article className="rounded-control border border-border bg-bg-base p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-body font-medium">{label}</h3>
          <p className="mt-1 text-meta text-text-muted">
            Maksimal {MAX_POINTS_PER_PATH} pengukuran terbaru
          </p>
        </div>
        <div className="md:text-right">
          <p className="font-data text-section font-medium text-accent">
            {formatMbps(latest.bitrate_mbps)}
          </p>
          <p className="mt-1 font-data text-meta text-text-muted">
            jitter {latest.jitter_ms === null ? "—" : `${latest.jitter_ms.toFixed(2)} ms`}
          </p>
          <time className="mt-1 block font-data text-meta text-text-muted">
            {formatTimestamp(latest.measured_at)}
          </time>
        </div>
      </div>

      <svg
        aria-label={`Grafik bandwidth ${label}`}
        className="mt-4 w-full"
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      >
        {yTicks.map((tick, index) => {
          const y = PADDING.top + (index / (yTicks.length - 1)) * plotHeight;
          return (
            <g key={`${tick}-${index}`}>
              <line
                className="stroke-border"
                x1={PADDING.left}
                x2={CHART_WIDTH - PADDING.right}
                y1={y}
                y2={y}
              />
              <text
                className="fill-text-muted font-data text-meta"
                textAnchor="end"
                x={PADDING.left - 8}
                y={y + 4}
              >
                {formatAxis(tick)}
              </text>
            </g>
          );
        })}

        <path className="fill-none stroke-accent" d={path} strokeWidth="2" />
        {coordinates.map(({ x, y, point }) => (
          <circle
            key={point.id}
            className="fill-accent"
            cx={x}
            cy={y}
            r="3"
          >
            <title>
              {formatTimestamp(point.measured_at)} — {formatMbps(point.bitrate_mbps)}
            </title>
          </circle>
        ))}

        <text
          className="fill-text-muted font-data text-meta"
          textAnchor="start"
          x={PADDING.left}
          y={CHART_HEIGHT - 8}
        >
          {formatShortTimestamp(points[0].measured_at)}
        </text>
        <text
          className="fill-text-muted font-data text-meta"
          textAnchor="end"
          x={CHART_WIDTH - PADDING.right}
          y={CHART_HEIGHT - 8}
        >
          {formatShortTimestamp(latest.measured_at)}
        </text>
      </svg>
    </article>
  );
}

function EmptyChart() {
  return (
    <div className="rounded-control border border-border bg-bg-base p-4">
      <p className="font-medium">Belum ada pengukuran bandwidth</p>
      <p className="mt-2 text-text-secondary">
        Jalankan command <span className="font-data">bandwidth-test</span> secara on-demand.
      </p>
    </div>
  );
}

function groupMeasurements(measurements: BandwidthMeasurement[]) {
  const grouped = new Map<string, BandwidthMeasurement[]>();

  for (const measurement of measurements) {
    const key = [
      measurement.source_label,
      measurement.target_label,
      measurement.target_host ?? "",
      measurement.connection_type ?? "legacy",
      measurement.direction ?? "legacy",
    ].join("\u0000");
    const values = grouped.get(key) ?? [];
    values.push(measurement);
    grouped.set(key, values);
  }

  return Array.from(grouped.entries()).map(([key, values]) => {
    const points = values
      .sort((left, right) => Date.parse(left.measured_at) - Date.parse(right.measured_at))
      .slice(-MAX_POINTS_PER_PATH);
    return {
      key,
      label: `${points[0].source_label} → ${points[0].target_label} · ${formatConnection(
        points[0].connection_type,
      )} · ${points[0].direction ?? "legacy"}${points[0].environment === "localhost_demo" ? " · TEST / not LAN" : ""}`,
      points,
    };
  });
}

function formatConnection(value: BandwidthMeasurement["connection_type"]) {
  if (value === "wifi") return "WiFi";
  if (value === "ethernet") return "Ethernet";
  return "Legacy / belum dicatat";
}

function formatMbps(value: number) {
  return `${value.toFixed(value >= 100 ? 1 : 2)} Mbps`;
}

function formatAxis(value: number) {
  return value.toFixed(value >= 100 ? 0 : 1);
}

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}

function formatShortTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
