BEGIN;

ALTER TABLE asset.assets
  ADD COLUMN IF NOT EXISTS stable_source_key varchar(300),
  ADD COLUMN IF NOT EXISTS hostname varchar(255),
  ADD COLUMN IF NOT EXISTS os_confidence varchar(16)
    CHECK (os_confidence IS NULL OR os_confidence IN ('low', 'medium', 'high')),
  ADD COLUMN IF NOT EXISTS open_ports jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS detected_services jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS latency_ms numeric(10, 3),
  ADD COLUMN IF NOT EXISTS evidence_updated_at timestamptz;

UPDATE asset.assets
SET stable_source_key = 'manual:' || id::text
WHERE stable_source_key IS NULL;

ALTER TABLE asset.assets
  ALTER COLUMN stable_source_key SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assets_stable_source_key_unique'
      AND conrelid = 'asset.assets'::regclass
  ) THEN
    ALTER TABLE asset.assets
      ADD CONSTRAINT assets_stable_source_key_unique UNIQUE (stable_source_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS assets_vendor_idx ON asset.assets (vendor, lower(name), id)
  WHERE vendor IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_platform_idx ON asset.assets (platform, lower(name), id)
  WHERE platform IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assets_open_ports_shape_check'
      AND conrelid = 'asset.assets'::regclass
  ) THEN
    ALTER TABLE asset.assets ADD CONSTRAINT assets_open_ports_shape_check CHECK (
      jsonb_typeof(open_ports) = 'array'
      AND jsonb_array_length(open_ports) <= 32
      AND octet_length(open_ports::text) <= 512
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assets_detected_services_shape_check'
      AND conrelid = 'asset.assets'::regclass
  ) THEN
    ALTER TABLE asset.assets ADD CONSTRAINT assets_detected_services_shape_check CHECK (
      jsonb_typeof(detected_services) = 'array'
      AND jsonb_array_length(detected_services) <= 32
      AND octet_length(detected_services::text) <= 8192
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assets_latency_ms_check'
      AND conrelid = 'asset.assets'::regclass
  ) THEN
    ALTER TABLE asset.assets ADD CONSTRAINT assets_latency_ms_check CHECK (
      latency_ms IS NULL OR (latency_ms >= 0 AND latency_ms <= 60000)
    );
  END IF;
END $$;

COMMENT ON COLUMN asset.assets.stable_source_key IS
  'Idempotent producer key. Node-backed evidence uses node:<uuid>; unlinked observations remain source-scoped.';
COMMENT ON COLUMN asset.assets.open_ports IS
  'Bounded normalized port numbers from existing Device Inspector evidence; never an arbitrary scan result.';
COMMENT ON COLUMN asset.assets.detected_services IS
  'Bounded normalized service evidence from the existing fixed-port Device Inspector contract.';

COMMIT;
