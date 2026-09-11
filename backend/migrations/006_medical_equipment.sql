BEGIN;

CREATE TABLE IF NOT EXISTS asset.medical_equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_code varchar(80) NOT NULL,
  name varchar(200) NOT NULL,
  manufacturer varchar(160),
  model varchar(160),
  serial_number varchar(160),
  department varchar(120),
  location varchar(160),
  operational_status varchar(32) NOT NULL DEFAULT 'active'
    CHECK (operational_status IN ('active', 'in_maintenance', 'out_of_service', 'retired')),
  network_asset_id uuid REFERENCES asset.assets(id) ON DELETE SET NULL,
  calibration_required boolean NOT NULL DEFAULT false,
  calibration_interval_months smallint
    CHECK (calibration_interval_months IS NULL OR calibration_interval_months BETWEEN 1 AND 120),
  maintenance_interval_months smallint
    CHECK (maintenance_interval_months IS NULL OR maintenance_interval_months BETWEEN 1 AND 120),
  notes varchar(4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (btrim(equipment_code) <> ''),
  CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS medical_equipment_code_unique_idx
  ON asset.medical_equipment (lower(equipment_code));
CREATE UNIQUE INDEX IF NOT EXISTS medical_equipment_network_asset_unique_idx
  ON asset.medical_equipment (network_asset_id) WHERE network_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS medical_equipment_department_idx
  ON asset.medical_equipment (department) WHERE department IS NOT NULL;
CREATE INDEX IF NOT EXISTS medical_equipment_location_idx
  ON asset.medical_equipment (location) WHERE location IS NOT NULL;
CREATE INDEX IF NOT EXISTS medical_equipment_status_idx
  ON asset.medical_equipment (operational_status);
CREATE INDEX IF NOT EXISTS medical_equipment_name_lower_idx
  ON asset.medical_equipment (lower(name), id);

CREATE SEQUENCE IF NOT EXISTS asset.medical_calibration_record_number_seq;
CREATE SEQUENCE IF NOT EXISTS asset.medical_service_record_number_seq;

CREATE TABLE IF NOT EXISTS asset.medical_calibration_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medical_equipment_id uuid NOT NULL REFERENCES asset.medical_equipment(id) ON DELETE RESTRICT,
  record_number varchar(24) NOT NULL UNIQUE,
  performed_on date NOT NULL,
  due_on date,
  provider varchar(200),
  certificate_number varchar(240),
  result varchar(24) NOT NULL CHECK (result IN ('passed', 'conditional', 'failed')),
  notes varchar(4000),
  source varchar(24) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'integration')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_on IS NULL OR due_on >= performed_on)
);

CREATE INDEX IF NOT EXISTS medical_calibration_equipment_latest_idx
  ON asset.medical_calibration_records (medical_equipment_id, performed_on DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS medical_calibration_due_idx
  ON asset.medical_calibration_records (due_on) WHERE due_on IS NOT NULL;

CREATE TABLE IF NOT EXISTS asset.medical_service_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medical_equipment_id uuid NOT NULL REFERENCES asset.medical_equipment(id) ON DELETE RESTRICT,
  record_number varchar(24) NOT NULL UNIQUE,
  service_type varchar(32) NOT NULL
    CHECK (service_type IN ('preventive_maintenance', 'corrective_maintenance', 'inspection', 'repair', 'other')),
  performed_on date NOT NULL,
  next_due_on date,
  provider varchar(200),
  technician varchar(200),
  result varchar(32) NOT NULL
    CHECK (result IN ('completed', 'follow_up_required', 'failed')),
  notes varchar(4000),
  source varchar(24) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'integration')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (next_due_on IS NULL OR next_due_on >= performed_on)
);

CREATE INDEX IF NOT EXISTS medical_service_equipment_latest_idx
  ON asset.medical_service_records (medical_equipment_id, performed_on DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS medical_service_due_idx
  ON asset.medical_service_records (next_due_on) WHERE next_due_on IS NOT NULL;

COMMIT;
