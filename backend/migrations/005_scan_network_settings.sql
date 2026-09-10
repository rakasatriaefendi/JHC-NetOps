BEGIN;

CREATE TABLE IF NOT EXISTS asset.scan_networks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) CHECK (name IS NULL OR btrim(name) <> ''),
  network cidr NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  origin varchar(16) NOT NULL CHECK (origin IN ('manual', 'detected', 'bootstrap')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (family(network) = 4),
  CHECK (masklen(network) BETWEEN 22 AND 32),
  CHECK (
    network <<= '10.0.0.0/8'::cidr
    OR network <<= '172.16.0.0/12'::cidr
    OR network <<= '192.168.0.0/16'::cidr
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS scan_networks_network_unique
  ON asset.scan_networks (network);
CREATE INDEX IF NOT EXISTS scan_networks_active_idx
  ON asset.scan_networks (enabled, network) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS asset.scan_network_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  initialized_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE asset.scan_networks IS
  'Operator-managed bounded RFC1918 scan allowlist. Route state is derived live and is not persisted.';
COMMENT ON COLUMN asset.scan_networks.deleted_at IS
  'Soft deletion prevents environment bootstrap from resurrecting operator-deleted networks.';
COMMENT ON TABLE asset.scan_network_bootstrap IS
  'Durable one-time ASSET_SCAN_NETWORKS bootstrap marker; contains no network or credential data.';

COMMIT;
