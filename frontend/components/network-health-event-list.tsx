import type { NetworkHealthEvent } from "@/lib/network-health";

export function NetworkHealthEventList({ events, empty = "Belum ada event network health." }: { events: NetworkHealthEvent[]; empty?: string }) {
  if (!events.length) return <p className="mt-4 text-text-muted">{empty}</p>;
  return <div className="mt-4 grid gap-3">{events.map((event) => <article className="rounded-control border border-border bg-bg-base p-4" key={event.id}><div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between"><div><p className="font-medium"><span className={tone(event.severity)}>●</span> {event.title}</p><p className="mt-2 text-text-secondary">{event.description}</p><p className="mt-2 text-meta text-text-muted">{event.resolved_at ? `Resolved ${format(event.resolved_at)}` : "Masih aktif"}</p></div><time className="shrink-0 font-data text-meta text-text-muted">{format(event.created_at)}</time></div></article>)}</div>;
}
function tone(value: NetworkHealthEvent["severity"]) { return value === "low" ? "text-severity-low" : value === "medium" ? "text-severity-medium" : value === "high" ? "text-severity-high" : "text-severity-critical"; }
function format(value: string) { return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
