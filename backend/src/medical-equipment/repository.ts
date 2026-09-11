import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  CalibrationInput,
  CalibrationRecord,
  MedicalEquipmentDetail,
  MedicalEquipmentInput,
  MedicalEquipmentRecord,
  MedicalListQuery,
  MedicalListResponse,
  NetworkAssetOption,
  ServiceInput,
  ServiceRecord,
} from "./contract.js";

export const MEDICAL_QUERY_TIMEOUT_MS = 7_000;
export const MEDICAL_HISTORY_LIMIT = 200;
export const MEDICAL_NETWORK_OPTION_LIMIT = 25;

export class MedicalRepositoryError extends Error {
  constructor(readonly code: "MEDICAL_EQUIPMENT_DUPLICATE" | "NETWORK_ASSET_ALREADY_LINKED" | "NETWORK_ASSET_NOT_FOUND") {
    super(code);
    this.name = "MedicalRepositoryError";
  }
}

export interface MedicalEquipmentRepository {
  list(query: MedicalListQuery, today: string, dueSoonDays: number, signal: AbortSignal): Promise<MedicalListResponse>;
  detail(id: string, today: string, dueSoonDays: number, signal: AbortSignal): Promise<MedicalEquipmentDetail | null>;
  create(input: MedicalEquipmentInput, today: string, dueSoonDays: number, signal: AbortSignal): Promise<MedicalEquipmentRecord>;
  update(id: string, input: MedicalEquipmentInput, today: string, dueSoonDays: number, signal: AbortSignal): Promise<MedicalEquipmentRecord | null>;
  addCalibration(id: string, input: CalibrationInput, signal: AbortSignal): Promise<CalibrationRecord | null>;
  addService(id: string, input: ServiceInput, signal: AbortSignal): Promise<ServiceRecord | null>;
  networkAssets(search: string, signal: AbortSignal): Promise<readonly NetworkAssetOption[]>;
  networkLinks(assetIds: readonly string[], signal: AbortSignal): Promise<readonly Readonly<{ network_asset_id: string; medical_equipment_id: string; equipment_code: string; name: string; department: string | null; location: string | null }>[]>;
}

export class PostgresMedicalEquipmentRepository implements MedicalEquipmentRepository {
  constructor(private readonly pool: Pool) {}

  async list(query: MedicalListQuery, today: string, dueSoonDays: number, signal: AbortSignal): Promise<MedicalListResponse> {
    signal.throwIfAborted();
    const { where, values } = medicalWhere(query, today, dueSoonDays);
    const offset = (query.page - 1) * query.pageSize;
    const limitIndex = values.length + 1;
    const offsetIndex = values.length + 2;
    const [items, count, summary, filters] = await Promise.all([
      this.pool.query<MedicalRow>(`${medicalView()} SELECT * FROM medical_view ${where}
        ORDER BY lower(name), lower(equipment_code), id LIMIT $${limitIndex} OFFSET $${offsetIndex}`, [...values, query.pageSize, offset]),
      this.pool.query<{ count: string }>(`${medicalView()} SELECT count(*)::text AS count FROM medical_view ${where}`, values),
      this.pool.query<MedicalSummaryRow>(`${medicalView()} SELECT count(*)::text AS total,
        count(*) FILTER (WHERE calibration_status = 'overdue')::text AS calibration_overdue,
        count(*) FILTER (WHERE calibration_status = 'due_soon')::text AS calibration_due_soon,
        count(*) FILTER (WHERE maintenance_status = 'overdue')::text AS maintenance_overdue,
        count(*) FILTER (WHERE maintenance_status = 'due_soon')::text AS maintenance_due_soon,
        count(*) FILTER (WHERE network_asset_id IS NOT NULL)::text AS network_linked FROM medical_view ${where}`, values),
      this.pool.query<FilterRow>(`SELECT
        ARRAY(SELECT DISTINCT department FROM asset.medical_equipment WHERE department IS NOT NULL ORDER BY department LIMIT 256) AS departments,
        ARRAY(SELECT DISTINCT location FROM asset.medical_equipment WHERE location IS NOT NULL ORDER BY location LIMIT 256) AS locations`),
    ]);
    signal.throwIfAborted();
    const total = countValue(count.rows[0]?.count);
    return {
      items: items.rows.map(normalizeMedical),
      summary: normalizeSummary(summary.rows[0]),
      filters: { departments: stringArray(filters.rows[0]?.departments), locations: stringArray(filters.rows[0]?.locations) },
      pagination: { page: query.page, page_size: query.pageSize, total, pages: Math.max(1, Math.ceil(total / query.pageSize)) },
    };
  }

  async detail(id: string, today: string, dueSoonDays: number, signal: AbortSignal): Promise<MedicalEquipmentDetail | null> {
    signal.throwIfAborted();
    const [equipment, calibrations, services] = await Promise.all([
      this.pool.query<MedicalRow>(`${medicalView()} SELECT * FROM medical_view WHERE id = $3::uuid LIMIT 1`, [today, dueSoonDays, id]),
      this.pool.query<CalibrationRow>(`SELECT id::text, record_number, performed_on::text, due_on::text, provider,
        certificate_number, result, notes, source, created_at::text, updated_at::text FROM asset.medical_calibration_records
        WHERE medical_equipment_id = $1 ORDER BY performed_on DESC, created_at DESC LIMIT ${MEDICAL_HISTORY_LIMIT}`, [id]),
      this.pool.query<ServiceRow>(`SELECT id::text, record_number, service_type, performed_on::text, next_due_on::text,
        provider, technician, result, notes, source, created_at::text, updated_at::text FROM asset.medical_service_records
        WHERE medical_equipment_id = $1 ORDER BY performed_on DESC, created_at DESC LIMIT ${MEDICAL_HISTORY_LIMIT}`, [id]),
    ]);
    signal.throwIfAborted();
    const row = equipment.rows[0];
    return row ? { equipment: normalizeMedical(row), calibrations: calibrations.rows.map(normalizeCalibration), services: services.rows.map(normalizeService) } : null;
  }

  async create(input: MedicalEquipmentInput, today: string, dueSoonDays: number, signal: AbortSignal): Promise<MedicalEquipmentRecord> {
    return this.mutate(null, input, today, dueSoonDays, signal) as Promise<MedicalEquipmentRecord>;
  }

  async update(id: string, input: MedicalEquipmentInput, today: string, dueSoonDays: number, signal: AbortSignal): Promise<MedicalEquipmentRecord | null> {
    return this.mutate(id, input, today, dueSoonDays, signal);
  }

  async addCalibration(id: string, input: CalibrationInput, signal: AbortSignal): Promise<CalibrationRecord | null> {
    signal.throwIfAborted();
    const result = await this.pool.query<CalibrationRow>(`INSERT INTO asset.medical_calibration_records (
      medical_equipment_id, record_number, performed_on, due_on, provider, certificate_number, result, notes, source
    ) SELECT $1::uuid,
      'CAL-' || extract(year from $2::date)::int || '-' || lpad(nextval('asset.medical_calibration_record_number_seq')::text, 6, '0'),
      $2::date, $3::date, $4, $5, $6, $7, $8
    WHERE EXISTS (SELECT 1 FROM asset.medical_equipment WHERE id = $1::uuid)
    RETURNING id::text, record_number, performed_on::text, due_on::text, provider, certificate_number, result, notes, source, created_at::text, updated_at::text`,
    [id, input.performed_on, input.due_on, input.provider, input.certificate_number, input.result, input.notes, input.source]);
    signal.throwIfAborted();
    return result.rows[0] ? normalizeCalibration(result.rows[0]) : null;
  }

  async addService(id: string, input: ServiceInput, signal: AbortSignal): Promise<ServiceRecord | null> {
    signal.throwIfAborted();
    const result = await this.pool.query<ServiceRow>(`INSERT INTO asset.medical_service_records (
      medical_equipment_id, record_number, service_type, performed_on, next_due_on, provider, technician, result, notes, source
    ) SELECT $1::uuid,
      'SRV-' || extract(year from $3::date)::int || '-' || lpad(nextval('asset.medical_service_record_number_seq')::text, 6, '0'),
      $2, $3::date, $4::date, $5, $6, $7, $8, $9
    WHERE EXISTS (SELECT 1 FROM asset.medical_equipment WHERE id = $1::uuid)
    RETURNING id::text, record_number, service_type, performed_on::text, next_due_on::text, provider, technician, result, notes, source, created_at::text, updated_at::text`,
    [id, input.service_type, input.performed_on, input.next_due_on, input.provider, input.technician, input.result, input.notes, input.source]);
    signal.throwIfAborted();
    return result.rows[0] ? normalizeService(result.rows[0]) : null;
  }

  async networkAssets(search: string, signal: AbortSignal): Promise<readonly NetworkAssetOption[]> {
    signal.throwIfAborted();
    const pattern = `%${escapeLike(search.trim())}%`;
    const result = await this.pool.query<NetworkAssetRow>(`SELECT id::text, name, hostname, host(ip_address) AS ip_address,
      mac_address::text AS mac_address, device_type, vendor, status FROM asset.assets
      WHERE ($1 = '%%' OR name ILIKE $1 ESCAPE '\\' OR hostname ILIKE $1 ESCAPE '\\'
        OR host(ip_address) ILIKE $1 ESCAPE '\\' OR mac_address::text ILIKE $1 ESCAPE '\\' OR vendor ILIKE $1 ESCAPE '\\')
      ORDER BY (device_type = 'medical_device') DESC, lower(name), id LIMIT ${MEDICAL_NETWORK_OPTION_LIMIT}`, [pattern]);
    signal.throwIfAborted();
    return result.rows.map(normalizeNetworkAsset);
  }

  async networkLinks(assetIds: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    if (!assetIds.length) return [];
    const result = await this.pool.query<MedicalLinkRow>(`SELECT network_asset_id::text, id::text AS medical_equipment_id,
      equipment_code, name, department, location FROM asset.medical_equipment WHERE network_asset_id = ANY($1::uuid[]) LIMIT 50`, [assetIds]);
    signal.throwIfAborted();
    return result.rows.map((row) => ({ ...row }));
  }

  private async mutate(id: string | null, input: MedicalEquipmentInput, today: string, dueSoonDays: number, signal: AbortSignal): Promise<MedicalEquipmentRecord | null> {
    signal.throwIfAborted();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await validateNetworkLink(client, input.network_asset_id, id);
      const values = equipmentValues(input);
      const result = id
        ? await client.query<{ id: string }>({
          text: `UPDATE asset.medical_equipment SET equipment_code=$2, name=$3, manufacturer=$4, model=$5,
            serial_number=$6, department=$7, location=$8, operational_status=$9, network_asset_id=$10::uuid,
            calibration_required=$11, calibration_interval_months=$12, maintenance_interval_months=$13,
            notes=$14, updated_at=now() WHERE id=$1::uuid RETURNING id::text`, values: [id, ...values],
        })
        : await client.query<{ id: string }>({
          text: `INSERT INTO asset.medical_equipment (equipment_code, name, manufacturer, model, serial_number,
            department, location, operational_status, network_asset_id, calibration_required,
            calibration_interval_months, maintenance_interval_months, notes)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12,$13) RETURNING id::text`, values,
        });
      const changedId = result.rows[0]?.id;
      if (!changedId) { await client.query("ROLLBACK"); return null; }
      const selected = await client.query<MedicalRow>(`${medicalView()} SELECT * FROM medical_view WHERE id = $3::uuid`, [today, dueSoonDays, changedId]);
      await client.query("COMMIT");
      const row = selected.rows[0];
      if (!row) throw new Error("MEDICAL_EQUIPMENT_NOT_RETURNED");
      return normalizeMedical(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw normalizeWriteError(error);
    } finally { client.release(); }
  }
}

async function validateNetworkLink(client: PoolClient, networkAssetId: string | null, equipmentId: string | null): Promise<void> {
  if (!networkAssetId) return;
  const result = await client.query<{ linked_id: string | null }>(`SELECT linked.id::text AS linked_id FROM asset.assets a
    LEFT JOIN asset.medical_equipment linked ON linked.network_asset_id = a.id
    WHERE a.id = $1::uuid FOR SHARE OF a`, [networkAssetId]);
  const row = result.rows[0];
  if (!row) throw new MedicalRepositoryError("NETWORK_ASSET_NOT_FOUND");
  if (row.linked_id && row.linked_id !== equipmentId) throw new MedicalRepositoryError("NETWORK_ASSET_ALREADY_LINKED");
}

function normalizeWriteError(error: unknown): Error {
  if (error instanceof MedicalRepositoryError) return error;
  if (record(error) && error.code === "23505") {
    return new MedicalRepositoryError(String(error.constraint).includes("network_asset") ? "NETWORK_ASSET_ALREADY_LINKED" : "MEDICAL_EQUIPMENT_DUPLICATE");
  }
  return error instanceof Error ? error : new Error("MEDICAL_WRITE_FAILED");
}

function medicalView(): string {
  return `
    WITH medical_view AS (
      SELECT
        e.id::text,
        e.equipment_code,
        e.name,
        e.manufacturer,
        e.model,
        e.serial_number,
        e.department,
        e.location,
        e.operational_status,
        e.network_asset_id::text,
        e.calibration_required,
        e.calibration_interval_months,
        e.maintenance_interval_months,
        e.notes,
        e.created_at::text,
        e.updated_at::text,

        /* Calibration lifecycle */
        cal.performed_on::text AS latest_calibration_on,
        cal.due_on::text AS calibration_due_on,

        /* Latest service of ANY type */
        service.performed_on::text AS latest_service_on,

        /* Maintenance schedule comes ONLY from latest preventive maintenance */
        maintenance.next_due_on::text AS maintenance_due_on,

        /* Derived calibration schedule status */
        CASE
          WHEN NOT e.calibration_required THEN 'not_required'
          WHEN cal.id IS NULL OR cal.due_on IS NULL THEN 'not_recorded'
          WHEN cal.due_on < $1::date THEN 'overdue'
          WHEN cal.due_on <= $1::date + $2::int THEN 'due_soon'
          ELSE 'valid'
        END AS calibration_status,

        /* Derived maintenance schedule status */
        CASE
          WHEN maintenance.id IS NULL
            OR maintenance.next_due_on IS NULL
            THEN 'not_scheduled'

          WHEN maintenance.next_due_on < $1::date
            THEN 'overdue'

          WHEN maintenance.next_due_on <= $1::date + $2::int
            THEN 'due_soon'

          ELSE 'ok'
        END AS maintenance_status,

        /* Current linked network asset context */
        a.id::text AS asset_id,
        a.name AS asset_name,
        a.hostname AS asset_hostname,
        host(a.ip_address) AS asset_ip_address,
        a.mac_address::text AS asset_mac_address,
        a.device_type AS asset_device_type,
        a.vendor AS asset_vendor,
        a.status AS asset_status

      FROM asset.medical_equipment e

      /*
       * Latest calibration record.
       *
       * This drives:
       * - latest_calibration_on
       * - calibration_due_on
       * - calibration_status
       */
      LEFT JOIN LATERAL (
        SELECT
          c.id,
          c.performed_on,
          c.due_on,
          c.created_at
        FROM asset.medical_calibration_records c
        WHERE c.medical_equipment_id = e.id
        ORDER BY
          c.performed_on DESC,
          c.created_at DESC
        LIMIT 1
      ) cal ON true

      /*
       * Latest service record of ANY service type.
       *
       * This is intentionally separate from maintenance scheduling.
       *
       * Examples:
       * - preventive_maintenance
       * - corrective_maintenance
       * - inspection
       * - repair
       * - other
       *
       * This drives only:
       * - latest_service_on
       */
      LEFT JOIN LATERAL (
        SELECT
          s.id,
          s.service_type,
          s.performed_on,
          s.next_due_on,
          s.created_at
        FROM asset.medical_service_records s
        WHERE s.medical_equipment_id = e.id
        ORDER BY
          s.performed_on DESC,
          s.created_at DESC
        LIMIT 1
      ) service ON true

      /*
       * Latest PREVENTIVE MAINTENANCE record.
       *
       * Only preventive maintenance is allowed to drive the
       * next maintenance schedule.
       *
       * A newer repair/corrective-service record must NOT erase
       * the preventive-maintenance due date.
       *
       * This drives:
       * - maintenance_due_on
       * - maintenance_status
       */
      LEFT JOIN LATERAL (
        SELECT
          s.id,
          s.performed_on,
          s.next_due_on,
          s.created_at
        FROM asset.medical_service_records s
        WHERE s.medical_equipment_id = e.id
          AND s.service_type = 'preventive_maintenance'
        ORDER BY
          s.performed_on DESC,
          s.created_at DESC
        LIMIT 1
      ) maintenance ON true

      /*
       * Network identity remains owned by Asset Inventory.
       *
       * Medical Equipment stores only network_asset_id.
       * IP/MAC/vendor/status below are read dynamically.
       */
      LEFT JOIN asset.assets a
        ON a.id = e.network_asset_id
    )
  `;
}

function medicalWhere(query: MedicalListQuery, today: string, dueSoonDays: number) {
  const values: unknown[] = [today, dueSoonDays];
  const clauses: string[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
  if (query.search) {
    values.push(`%${escapeLike(query.search)}%`);
    const index = `$${values.length}`;
    clauses.push(`(name ILIKE ${index} ESCAPE '\\' OR equipment_code ILIKE ${index} ESCAPE '\\' OR manufacturer ILIKE ${index} ESCAPE '\\' OR model ILIKE ${index} ESCAPE '\\' OR serial_number ILIKE ${index} ESCAPE '\\' OR department ILIKE ${index} ESCAPE '\\' OR location ILIKE ${index} ESCAPE '\\')`);
  }
  if (query.department) add("department = ?", query.department);
  if (query.location) add("location = ?", query.location);
  if (query.operationalStatus) add("operational_status = ?", query.operationalStatus);
  if (query.calibrationStatus) add("calibration_status = ?", query.calibrationStatus);
  if (query.maintenanceStatus) add("maintenance_status = ?", query.maintenanceStatus);
  if (query.networkLink) clauses.push(query.networkLink === "linked" ? "network_asset_id IS NOT NULL" : "network_asset_id IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, values };
}

function equipmentValues(input: MedicalEquipmentInput): unknown[] {
  return [input.equipment_code, input.name, input.manufacturer, input.model, input.serial_number, input.department,
    input.location, input.operational_status, input.network_asset_id, input.calibration_required,
    input.calibration_interval_months, input.maintenance_interval_months, input.notes];
}

type MedicalRow = QueryResultRow & MedicalEquipmentInput & {
  id: string; created_at: string; updated_at: string; calibration_status: MedicalEquipmentRecord["calibration_status"];
  maintenance_status: MedicalEquipmentRecord["maintenance_status"]; latest_calibration_on: string | null;
  calibration_due_on: string | null; latest_service_on: string | null; maintenance_due_on: string | null;
  asset_id: string | null; asset_name: string | null; asset_hostname: string | null; asset_ip_address: string | null;
  asset_mac_address: string | null; asset_device_type: string | null; asset_vendor: string | null;
  asset_status: NetworkAssetOption["status"] | null;
};
type CalibrationRow = QueryResultRow & CalibrationRecord;
type ServiceRow = QueryResultRow & ServiceRecord;
type NetworkAssetRow = QueryResultRow & NetworkAssetOption;
type MedicalSummaryRow = QueryResultRow & { total: string; calibration_overdue: string; calibration_due_soon: string; maintenance_overdue: string; maintenance_due_soon: string; network_linked: string };
type FilterRow = QueryResultRow & { departments: unknown; locations: unknown };
type MedicalLinkRow = QueryResultRow & { network_asset_id: string; medical_equipment_id: string; equipment_code: string; name: string; department: string | null; location: string | null };

function normalizeMedical(row: MedicalRow): MedicalEquipmentRecord {
  return {
    id: row.id, equipment_code: row.equipment_code, name: row.name, manufacturer: row.manufacturer, model: row.model,
    serial_number: row.serial_number, department: row.department, location: row.location,
    operational_status: row.operational_status, network_asset_id: row.network_asset_id,
    calibration_required: row.calibration_required, calibration_interval_months: row.calibration_interval_months,
    maintenance_interval_months: row.maintenance_interval_months, notes: row.notes, created_at: row.created_at,
    updated_at: row.updated_at, calibration_status: row.calibration_status, maintenance_status: row.maintenance_status,
    latest_calibration_on: row.latest_calibration_on, calibration_due_on: row.calibration_due_on,
    latest_service_on: row.latest_service_on, maintenance_due_on: row.maintenance_due_on,
    network_asset: row.asset_id && row.asset_name && row.asset_device_type ? normalizeNetworkAsset({
      id: row.asset_id, name: row.asset_name, hostname: row.asset_hostname, ip_address: row.asset_ip_address,
      mac_address: row.asset_mac_address, device_type: row.asset_device_type, vendor: row.asset_vendor,
      status: row.asset_status ?? "unknown",
    }) : null,
  };
}
function normalizeCalibration(row: CalibrationRow): CalibrationRecord { return { ...row }; }
function normalizeService(row: ServiceRow): ServiceRecord { return { ...row }; }
function normalizeNetworkAsset(row: NetworkAssetRow): NetworkAssetOption { return { id: row.id, name: row.name, hostname: row.hostname, ip_address: row.ip_address, mac_address: row.mac_address, device_type: row.device_type, vendor: row.vendor, status: row.status }; }
function normalizeSummary(row: MedicalSummaryRow | undefined) { return { total: countValue(row?.total), calibration_overdue: countValue(row?.calibration_overdue), calibration_due_soon: countValue(row?.calibration_due_soon), maintenance_overdue: countValue(row?.maintenance_overdue), maintenance_due_soon: countValue(row?.maintenance_due_soon), network_linked: countValue(row?.network_linked) }; }
function countValue(value: string | undefined): number { const number = Number(value ?? 0); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 256) : []; }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, "\\$&"); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
