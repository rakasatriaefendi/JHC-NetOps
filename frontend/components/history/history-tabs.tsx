"use client";

import { useState } from "react";

import { DiagnosticHistoryPanel } from "@/components/history/diagnostic-history-panel";
import { NetworkHealthEventList } from "@/components/network-health-event-list";
import type { NetworkHealthEvent } from "@/lib/network-health";

type HistoryTab = "events" | "diagnostics";

export function HistoryTabs({ events }: { events: NetworkHealthEvent[] }) {
  const [activeTab, setActiveTab] = useState<HistoryTab>("diagnostics");

  return (
    <section className="mt-6">
      <div className="flex gap-2 border-b border-border" role="tablist" aria-label="Jenis history">
        <TabButton active={activeTab === "events"} onClick={() => setActiveTab("events")}>
          Network Events
        </TabButton>
        <TabButton active={activeTab === "diagnostics"} onClick={() => setActiveTab("diagnostics")}>
          Diagnostic Tests
        </TabButton>
      </div>

      {activeTab === "events" ? (
        <div className="mt-6 rounded-panel border border-border bg-bg-surface p-6" role="tabpanel">
          <h2 className="text-section font-semibold">Network Events</h2>
          <p className="mt-2 text-text-secondary">Transisi degraded, offline, dan recovery dari known-target monitoring.</p>
          <NetworkHealthEventList events={events} />
        </div>
      ) : (
        <div role="tabpanel">
          <DiagnosticHistoryPanel />
        </div>
      )}
    </section>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      aria-selected={active}
      className={`border-b-2 px-3 py-3 text-body font-medium transition-colors ${
        active
          ? "border-accent text-accent"
          : "border-transparent text-text-secondary hover:text-text-primary"
      }`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {children}
    </button>
  );
}
