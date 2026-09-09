BEGIN;

CREATE TABLE IF NOT EXISTS asset.change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid REFERENCES asset.assets(id) ON DELETE SET NULL,
  scan_run_id uuid REFERENCES asset.scan_runs(id) ON DELETE SET NULL,
  asset_stable_key varchar(300) NOT NULL CHECK (btrim(asset_stable_key) <> ''),
  event_key char(64) NOT NULL UNIQUE CHECK (event_key ~ '^[0-9a-f]{64}$'),
  event_type varchar(16) NOT NULL CHECK (event_type IN ('created', 'changed')),
  source varchar(32) NOT NULL CHECK (
    source IN ('manual', 'discovery', 'observed_host', 'device_inspector', 'managed_telemetry', 'active_scan', 'import')
  ),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (
    cardinality(changed_fields) <= 10
    AND changed_fields <@ ARRAY[
      'name', 'hostname', 'ip_address', 'mac_address', 'vendor', 'platform',
      'device_type', 'status', 'open_ports', 'detected_services'
    ]::text[]
  ),
  before_state jsonb,
  after_state jsonb NOT NULL,
  CHECK (before_state IS NULL OR jsonb_typeof(before_state) = 'object'),
  CHECK (jsonb_typeof(after_state) = 'object'),
  CHECK (before_state IS NULL OR before_state - ARRAY[
    'name', 'hostname', 'ip_address', 'mac_address', 'vendor', 'platform',
    'device_type', 'status', 'open_ports', 'detected_services'
  ]::text[] = '{}'::jsonb),
  CHECK (after_state - ARRAY[
    'name', 'hostname', 'ip_address', 'mac_address', 'vendor', 'platform',
    'device_type', 'status', 'open_ports', 'detected_services'
  ]::text[] = '{}'::jsonb),
  CHECK (before_state IS NULL OR octet_length(before_state::text) <= 32768),
  CHECK (octet_length(after_state::text) <= 32768),
  CHECK (
    (event_type = 'created' AND before_state IS NULL AND cardinality(changed_fields) = 0)
    OR (event_type = 'changed' AND before_state IS NOT NULL AND cardinality(changed_fields) > 0)
  )
);

CREATE INDEX IF NOT EXISTS change_events_recorded_at_idx
  ON asset.change_events (recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS change_events_asset_idx
  ON asset.change_events (asset_id, recorded_at DESC, id DESC)
  WHERE asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS change_events_stable_key_idx
  ON asset.change_events (asset_stable_key, recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS change_events_type_idx
  ON asset.change_events (event_type, recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS change_events_source_idx
  ON asset.change_events (source, recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS change_events_fields_idx
  ON asset.change_events USING gin (changed_fields);

COMMENT ON TABLE asset.change_events IS
  'Append-only meaningful Asset Inventory changes; normalized snapshots only, never raw scanner output or credentials.';
COMMENT ON COLUMN asset.change_events.event_key IS
  'Deterministic retry-deduplication key derived from normalized event facts.';
COMMENT ON COLUMN asset.change_events.asset_stable_key IS
  'Stable historical identity retained if the current asset row is later removed.';

COMMIT;
