import type { ProfileStatus } from "@/lib/auth";

const statusStyles: Record<ProfileStatus, string> = {
  pending: "bg-severity-medium/10 text-severity-medium",
  approved: "bg-severity-low/10 text-severity-low",
  rejected: "bg-severity-critical/10 text-severity-critical",
};

const statusLabels: Record<ProfileStatus, string> = {
  pending: "Menunggu persetujuan",
  approved: "Disetujui",
  rejected: "Ditolak",
};

export function StatusBadge({ status }: { status: ProfileStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-meta font-medium ${statusStyles[status]}`}
    >
      <span aria-hidden="true">●</span>
      {statusLabels[status]}
    </span>
  );
}

