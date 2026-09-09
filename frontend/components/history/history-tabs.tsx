"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DiagnosticHistoryPanel } from "@/components/history/diagnostic-history-panel";
import { AssetChangeHistoryPanel } from "@/components/assets/asset-change-history-panel";
import { NetworkHealthEventList } from "@/components/network-health-event-list";
import type { AssetChangeData, AssetChangeHistoryQuery } from "@/lib/asset-change-contract";
import type { NetworkHealthEvent } from "@/lib/network-health";

type HistoryTab = "events" | "diagnostics" | "assets";

export function HistoryTabs({ events, assetChanges, assetError, assetQuery, initialTab }: { events: NetworkHealthEvent[]; assetChanges: AssetChangeData | null; assetError: "unconfigured" | "unavailable" | null; assetQuery: AssetChangeHistoryQuery; initialTab: HistoryTab }) {
  const { t } = useTranslation("history");
  const [activeTab, setActiveTab] = useState<HistoryTab>(initialTab);

  return (
    <section className="mt-6">
      <div className="flex flex-wrap gap-2 border-b border-border" role="tablist" aria-label={t("tabs.label")}>
        <TabButton active={activeTab === "events"} onClick={() => setActiveTab("events")}>
          {t("tabs.health")}
        </TabButton>
        <TabButton active={activeTab === "diagnostics"} onClick={() => setActiveTab("diagnostics")}>
          {t("tabs.diagnostics")}
        </TabButton>
        <TabButton active={activeTab === "assets"} onClick={() => setActiveTab("assets")}>
          {t("tabs.assets")}
        </TabButton>
      </div>

      {activeTab === "events" ? (
        <div className="mt-6 rounded-panel border border-border bg-bg-surface p-6" role="tabpanel">
          <h2 className="text-section font-semibold">{t("events.title")}</h2>
          <p className="mt-2 text-text-secondary">{t("events.description")}</p>
          <NetworkHealthEventList events={events} />
        </div>
      ) : activeTab === "diagnostics" ? (
        <div role="tabpanel">
          <DiagnosticHistoryPanel />
        </div>
      ) : <AssetChangeHistoryPanel data={assetChanges} error={assetError} query={assetQuery} />}
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
