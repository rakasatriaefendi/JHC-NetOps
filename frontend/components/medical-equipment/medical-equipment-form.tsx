"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslation } from "react-i18next";

import { createMedicalEquipmentAction, searchMedicalNetworkAssetsAction, updateMedicalEquipmentAction } from "@/app/actions/medical-equipment";
import { Button } from "@/components/ui/button";
import type { MedicalEquipmentInput, MedicalEquipmentRecord, NetworkAssetOption, OperationalStatus } from "@/lib/medical-equipment-contract";

export function MedicalEquipmentForm({ equipment = null, departments, locations, onCancel }: {
  equipment?: MedicalEquipmentRecord | null; departments: readonly string[]; locations: readonly string[]; onCancel: () => void;
}) {
  const { t } = useTranslation("medical");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [networkSearch, setNetworkSearch] = useState(equipment?.network_asset?.name ?? "");
  const [networkOptions, setNetworkOptions] = useState<readonly NetworkAssetOption[]>(equipment?.network_asset ? [equipment.network_asset] : []);
  const [networkAssetId, setNetworkAssetId] = useState(equipment?.network_asset_id ?? "");
  const [calibrationRequired, setCalibrationRequired] = useState(equipment?.calibration_required ?? false);

  const searchNetworkAssets = () => startTransition(async () => {
    setError(null);

    const result = await searchMedicalNetworkAssetsAction(networkSearch);

    if (result.error) {
      setNetworkOptions([]);
      setError(t("errors.unavailable"));
      return;
    }

    const options = result.data ?? [];
    setNetworkOptions(options);

    const normalizedSearch = networkSearch.trim().toLowerCase();

    const exactMatch = options.find((asset) => {
      return (
        asset.ip_address?.trim().toLowerCase() === normalizedSearch ||
        asset.mac_address?.trim().toLowerCase() === normalizedSearch ||
        asset.hostname?.trim().toLowerCase() === normalizedSearch ||
        asset.name.trim().toLowerCase() === normalizedSearch
      );
    });

    const automaticSelection =
      exactMatch ?? (options.length === 1 ? options[0] : null);

    if (automaticSelection) {
      setNetworkAssetId(automaticSelection.id);
    }
  });

  const submit = (formData: FormData) => startTransition(async () => {
    setError(null);
    const interval = numberOrNull(formData.get("calibration_interval_months"));
    const maintenance = numberOrNull(formData.get("maintenance_interval_months"));
    const input: MedicalEquipmentInput = {
      equipment_code: text(formData, "equipment_code"), name: text(formData, "name"),
      manufacturer: optionalText(formData, "manufacturer"), model: optionalText(formData, "model"),
      serial_number: optionalText(formData, "serial_number"), department: optionalText(formData, "department"),
      location: optionalText(formData, "location"), operational_status: text(formData, "operational_status") as OperationalStatus,
      network_asset_id: networkAssetId || null, calibration_required: calibrationRequired,
      calibration_interval_months: interval, maintenance_interval_months: maintenance, notes: optionalText(formData, "notes"),
    };
    const result = equipment ? await updateMedicalEquipmentAction(equipment.id, input) : await createMedicalEquipmentAction(input);
    if (!result.data) { setError(t(`errors.${result.error ?? "save"}`, { defaultValue: t("errors.save") })); return; }
    onCancel();
    router.push(`/medical-equipment/${result.data.id}`);
    router.refresh();
  });

  return <form action={submit} className="space-y-5">
    <div className="grid gap-4 md:grid-cols-2">
      <Field label={t("field.code")} required><input className={inputClass} name="equipment_code" required maxLength={80} defaultValue={equipment?.equipment_code ?? ""} /></Field>
      <Field label={t("field.name")} required><input className={inputClass} name="name" required maxLength={200} defaultValue={equipment?.name ?? ""} /></Field>
      <Field label={t("field.manufacturer")}><input className={inputClass} name="manufacturer" maxLength={160} defaultValue={equipment?.manufacturer ?? ""} /></Field>
      <Field label={t("field.model")}><input className={inputClass} name="model" maxLength={160} defaultValue={equipment?.model ?? ""} /></Field>
      <Field label={t("field.serial")}><input className={inputClass} name="serial_number" maxLength={160} defaultValue={equipment?.serial_number ?? ""} /></Field>
      <Field label={t("field.operational")}><select className={inputClass} name="operational_status" defaultValue={equipment?.operational_status ?? "active"}>{["active", "in_maintenance", "out_of_service", "retired"].map((value) => <option value={value} key={value}>{t(`status.${value}`)}</option>)}</select></Field>
      <Field label={t("field.department")}><input className={inputClass} name="department" list="medical-departments" maxLength={120} defaultValue={equipment?.department ?? ""} /><datalist id="medical-departments">{departments.map((value) => <option key={value} value={value} />)}</datalist></Field>
      <Field label={t("field.location")}><input className={inputClass} name="location" list="medical-locations" maxLength={160} defaultValue={equipment?.location ?? ""} /><datalist id="medical-locations">{locations.map((value) => <option key={value} value={value} />)}</datalist></Field>
      <label className="flex items-center gap-3 text-body text-text-primary md:col-span-2"><input type="checkbox" checked={calibrationRequired} onChange={(event) => setCalibrationRequired(event.target.checked)} />{t("field.calibrationRequired")}</label>
      <Field label={t("field.calibrationInterval")}><input className={inputClass} name="calibration_interval_months" type="number" min={1} max={120} disabled={!calibrationRequired} defaultValue={equipment?.calibration_interval_months ?? ""} /></Field>
      <Field label={t("field.maintenanceInterval")}><input className={inputClass} name="maintenance_interval_months" type="number" min={1} max={120} defaultValue={equipment?.maintenance_interval_months ?? ""} /></Field>
    </div>
    <div className="rounded-panel border border-border bg-bg-base p-4">
      <p className="text-body font-medium">
        {t("field.networkAsset")}
      </p>

      <p className="mt-1 text-meta text-text-muted">
        {t("network.linkHelp")}
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          className={`${inputClass} flex-1`}
          value={networkSearch}
          maxLength={100}
          placeholder={t("network.searchHint")}
          onChange={(event) => setNetworkSearch(event.target.value)}
        />

        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={searchNetworkAssets}
        >
          {t("network.search")}
        </Button>
      </div>

      <select
        className={`${inputClass} mt-2`}
        value={networkAssetId}
        onChange={(event) => setNetworkAssetId(event.target.value)}
      >
        <option value="">
          {t("network.unlinked")}
        </option>

        {networkOptions.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.name}
            {" · "}
            {asset.ip_address ?? asset.hostname ?? "-"}
            {" · "}
            {asset.vendor ?? "-"}
            {" · "}
            {t(`status.${asset.status}`)}
          </option>
        ))}
      </select>
    </div>
    <Field label={t("field.notes")}><textarea className={`${inputClass} min-h-24`} name="notes" maxLength={4000} defaultValue={equipment?.notes ?? ""} /></Field>
    {error ? <p role="alert" className="text-body text-severity-critical">{error}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
    <Button
      type="button"
      variant="secondary"
      disabled={pending}
      onClick={onCancel}
    >
      {t("common:actions.cancel")}
    </Button>

    <Button type="submit" disabled={pending}>
      {pending ? t("saving") : t("save")}
    </Button>
  </div>
  </form>;
}

function Field({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) { return <label className="block text-meta text-text-secondary"><span className="mb-1 block">{label}{required ? " *" : ""}</span>{children}</label>; }
const inputClass = "w-full rounded-control border border-border bg-bg-surface px-3 py-2 text-body text-text-primary outline-none focus:border-accent disabled:opacity-50";
function text(data: FormData, key: string): string { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function optionalText(data: FormData, key: string): string | null { return text(data, key) || null; }
function numberOrNull(value: FormDataEntryValue | null): number | null { if (typeof value !== "string" || !value) return null; const number = Number(value); return Number.isSafeInteger(number) ? number : null; }
