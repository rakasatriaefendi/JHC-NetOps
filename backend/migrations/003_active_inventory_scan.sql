BEGIN;

ALTER TABLE asset.assets DROP CONSTRAINT IF EXISTS assets_source_check;
ALTER TABLE asset.assets ADD CONSTRAINT assets_source_check CHECK (
  source IN ('manual', 'discovery', 'observed_host', 'device_inspector', 'managed_telemetry', 'active_scan', 'import')
);

CREATE TABLE IF NOT EXISTS asset.scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode varchar(16) NOT NULL CHECK (mode IN ('quick', 'deep')),
  network cidr NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  discovered_count integer NOT NULL DEFAULT 0 CHECK (discovered_count BETWEEN 0 AND 1024),
  fingerprinted_count integer NOT NULL DEFAULT 0 CHECK (fingerprinted_count BETWEEN 0 AND 1024),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count BETWEEN 0 AND 1024),
  current_target inet,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz,
  error_code varchar(64) CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]+$'),
  CHECK (fingerprinted_count + failed_count <= discovered_count),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (cancelled_at IS NULL OR cancelled_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS scan_runs_one_running_idx
  ON asset.scan_runs ((status)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS scan_runs_started_at_idx ON asset.scan_runs (started_at DESC, id DESC);

COMMENT ON TABLE asset.scan_runs IS
  'Bounded active inventory scan lifecycle metadata; raw Nmap output and credentials are never persisted.';

COMMIT;
