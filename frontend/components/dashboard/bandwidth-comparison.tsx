import {
  latestBandwidthComparisons,
  type BandwidthMeasurement,
  type DiagnosticSortOrder,
} from "@/lib/diagnostics";

type BandwidthComparisonProps = {
  measurements: BandwidthMeasurement[];
  sortOrder?: DiagnosticSortOrder;
};

export function BandwidthComparison({
  measurements,
  sortOrder = "newest",
}: BandwidthComparisonProps) {
  const rows = latestBandwidthComparisons(measurements, sortOrder);

  if (rows.length === 0) {
    return (
      <div className="rounded-control border border-border bg-bg-base p-4 text-text-secondary">
        Tidak ada pengukuran bandwidth yang cocok dengan filter.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-control border border-border bg-bg-base">
      <div className="hidden md:block">
        <table className="w-full border-collapse text-left text-body">
          <thead className="text-meta font-medium text-text-secondary">
            <tr>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Direction</th>
              <th className="px-4 py-3">Environment</th>
              <th className="px-4 py-3">Latest Mbps</th>
              <th className="px-4 py-3">Measured at</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t border-border" key={row.id}>
                <td className="px-4 py-3">
                  <p>{row.target_label}</p>
                  <p className="mt-1 font-data text-meta text-text-muted">
                    {row.target_host ?? "target legacy tidak tercatat"}
                  </p>
                </td>
                <td className="px-4 py-3">{row.source_label}</td>
                <td className="px-4 py-3">{formatConnection(row.connection_type)}</td>
                <td className="px-4 py-3 capitalize">{row.direction ?? "Legacy"}</td>
                <td className="px-4 py-3">
                  {row.environment === "localhost_demo" ? "TEST / not LAN" : row.environment ?? "Legacy"}
                </td>
                <td className="px-4 py-3 font-data text-accent">
                  {row.bitrate_mbps.toFixed(2)}
                </td>
                <td className="px-4 py-3 font-data text-meta">
                  {formatTimestamp(row.measured_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 p-4 md:hidden">
        {rows.map((row) => (
          <article className="rounded-control border border-border p-3" key={row.id}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-medium">{row.source_label}</p>
                <p className="mt-1 text-meta text-text-secondary">
                  {row.target_label} · {formatConnection(row.connection_type)}
                </p>
                <p className="mt-1 font-data text-meta text-text-muted">
                  {row.target_host ?? "target legacy tidak tercatat"}
                </p>
              </div>
              <p className="font-data text-section font-medium text-accent">
                {row.bitrate_mbps.toFixed(2)} Mbps
              </p>
            </div>
            <time className="mt-3 block font-data text-meta text-text-muted">
              {formatTimestamp(row.measured_at)}
            </time>
            {row.environment === "localhost_demo" ? (
              <p className="mt-2 text-meta font-medium text-severity-medium">TEST ENVIRONMENT · bukan performa LAN</p>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function formatConnection(value: BandwidthMeasurement["connection_type"]) {
  if (value === "wifi") return "WiFi";
  if (value === "ethernet") return "Ethernet";
  return "Legacy / belum dicatat";
}

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(timestamp));
}
