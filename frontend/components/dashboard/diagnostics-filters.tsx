"use client";

import { useTranslation } from "react-i18next";

import type {
  ConnectionType,
  DiagnosticsFilters,
  DiagnosticSortOrder,
} from "@/lib/diagnostics";

type DiagnosticsFiltersProps = {
  filters: DiagnosticsFilters;
  sources: string[];
  targets: string[];
  sortOrder: DiagnosticSortOrder;
  onChange: (filters: DiagnosticsFilters) => void;
  onSortOrderChange: (sortOrder: DiagnosticSortOrder) => void;
};

export function DiagnosticsFilterControls({
  filters,
  sources,
  targets,
  sortOrder,
  onChange,
  onSortOrderChange,
}: DiagnosticsFiltersProps) {
  const { t } = useTranslation("diagnostics");
  return (
    <div className="grid gap-4 rounded-control border border-border bg-bg-base p-4 md:grid-cols-4">
      <FilterSelect
        label={t("filters.source", { defaultValue: t("workspace.source") })}
        value={filters.source}
        options={sources}
        onChange={(source) => onChange({ ...filters, source })}
      />
      <FilterSelect
        label={t("workspace.target")}
        value={filters.target}
        options={targets}
        onChange={(target) => onChange({ ...filters, target })}
      />
      <label className="grid gap-2 text-meta font-medium text-text-secondary">
        {t("filters.connection")}
        <select
          className="rounded-control border border-border bg-bg-surface px-3 py-2 text-body text-text-primary outline-none focus:border-accent"
          value={filters.connectionType}
          onChange={(event) =>
            onChange({
              ...filters,
              connectionType: event.target.value as "all" | ConnectionType,
            })
          }
        >
          <option value="all">{t("filters.all")}</option>
          <option value="wifi">WiFi</option>
          <option value="ethernet">Ethernet</option>
        </select>
      </label>
      <label className="grid gap-2 text-meta font-medium text-text-secondary">
        {t("filters.sort")}
        <select
          className="rounded-control border border-border bg-bg-surface px-3 py-2 text-body text-text-primary outline-none focus:border-accent"
          value={sortOrder}
          onChange={(event) =>
            onSortOrderChange(event.target.value as DiagnosticSortOrder)
          }
        >
          <option value="newest">{t("filters.newest")}</option>
          <option value="oldest">{t("filters.oldest")}</option>
        </select>
      </label>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("diagnostics");
  return (
    <label className="grid gap-2 text-meta font-medium text-text-secondary">
      {label}
      <select
        className="rounded-control border border-border bg-bg-surface px-3 py-2 text-body text-text-primary outline-none focus:border-accent"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="all">{t("filters.all")}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
