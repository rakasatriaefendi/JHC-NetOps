type MetricCardProps = {
  label: string;
  value: string;
  detail: string;
};

export function MetricCard({ label, value, detail }: MetricCardProps) {
  return (
    <article className="rounded-panel border border-border bg-bg-surface p-4">
      <p className="text-meta font-medium text-text-secondary">{label}</p>
      <p className="mt-3 font-data text-heading font-semibold">{value}</p>
      <p className="mt-2 text-meta text-text-muted">{detail}</p>
    </article>
  );
}

