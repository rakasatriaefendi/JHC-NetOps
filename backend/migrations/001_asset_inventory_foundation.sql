BEGIN;

CREATE SCHEMA IF NOT EXISTS asset;

CREATE TABLE IF NOT EXISTS asset.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL CHECK (btrim(name) <> ''),
  device_type varchar(64) NOT NULL DEFAULT 'unknown' CHECK (btrim(device_type) <> ''),
  status varchar(16) NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('online', 'offline', 'changed', 'unknown')),
  ip_address inet,
  mac_address macaddr,
  vendor varchar(200),
  platform varchar(200),
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  source varchar(32) NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'discovery', 'observed_host', 'device_inspector', 'managed_telemetry', 'import')),
  classification_confidence varchar(16)
    CHECK (classification_confidence IS NULL OR classification_confidence IN ('low', 'medium', 'high')),
  classification_evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(classification_evidence) = 'array')
    CHECK (octet_length(classification_evidence::text) <= 32768),
  network_node_ref uuid,
  health_target_ref uuid,
  managed_telemetry_target_ref uuid,
  observed_host_target_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (first_seen_at IS NULL OR last_seen_at IS NULL OR first_seen_at <= last_seen_at)
);

CREATE INDEX IF NOT EXISTS assets_name_lower_idx ON asset.assets (lower(name), id);
CREATE INDEX IF NOT EXISTS assets_device_type_idx ON asset.assets (device_type, lower(name), id);
CREATE INDEX IF NOT EXISTS assets_status_idx ON asset.assets (status, lower(name), id);
CREATE INDEX IF NOT EXISTS assets_last_seen_idx ON asset.assets (last_seen_at DESC NULLS LAST, id);
CREATE INDEX IF NOT EXISTS assets_ip_address_idx ON asset.assets (ip_address) WHERE ip_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_network_node_ref_idx ON asset.assets (network_node_ref)
  WHERE network_node_ref IS NOT NULL;

COMMENT ON SCHEMA asset IS 'JHC NetOps local asset domain; isolated from current Supabase domains.';
COMMENT ON COLUMN asset.assets.network_node_ref IS 'Stable Supabase reference only; intentionally not a cross-database foreign key.';
COMMENT ON COLUMN asset.assets.classification_evidence IS 'Bounded normalized evidence; never raw scan output, payload, or credentials.';

COMMIT;
