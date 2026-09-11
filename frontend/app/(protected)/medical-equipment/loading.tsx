export default function MedicalEquipmentLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="h-24 animate-pulse rounded-panel border border-border bg-bg-surface" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div className="h-28 animate-pulse rounded-panel border border-border bg-bg-surface" key={index} />)}
      </div>
      <div className="h-64 animate-pulse rounded-panel border border-border bg-bg-surface" />
    </div>
  );
}
