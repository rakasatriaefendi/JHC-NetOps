\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'jhc_netops'
     OR current_setting('port')::integer <> 5433
     OR (inet_server_addr() IS NOT NULL AND host(inet_server_addr()) NOT IN ('127.0.0.1', '::1'))
     OR current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999
     OR current_setting('data_directory') <> '/var/lib/postgresql/16/jhcnetops'
     OR session_user <> 'postgres'
     OR to_regclass('asset.assets') IS NULL
     OR to_regclass('public.network_nodes') IS NULL
     OR to_regclass('public.managed_telemetry_targets') IS NULL
     OR to_regclass('public.managed_device_latest') IS NULL
     OR to_regclass('public.application_schema_migrations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.application_schema_migrations WHERE version = 18)
     OR (SELECT max(version) FROM public.application_schema_migrations) <> 18
  THEN
    RAISE EXCEPTION 'Stable device identity requires migration 018 on PostgreSQL 16/jhcnetops:5433';
  END IF;
  -- An explicit binding cannot arbitrarily choose between duplicate canonical rows.
  IF EXISTS (
    SELECT a.network_node_ref FROM asset.assets a JOIN public.network_nodes n ON n.id=a.network_node_ref
    GROUP BY a.network_node_ref HAVING count(*) > 1
  ) OR EXISTS (
    SELECT n.ip_address FROM asset.assets a JOIN public.network_nodes n ON n.id=a.network_node_ref
    GROUP BY n.ip_address HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Ambiguous explicit endpoint bindings require operator review; no assets were merged';
  END IF;
END $$;
SET ROLE jhc_netops_owner;

ALTER TABLE asset.assets ADD COLUMN identity_state text NOT NULL DEFAULT 'provisional'
  CHECK (identity_state IN ('resolved','provisional','conflict'));

CREATE TABLE asset.identity_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES asset.assets(id) ON DELETE CASCADE,
  evidence_type text NOT NULL CHECK (evidence_type IN (
    'network_node_binding','global_mac','local_mac','snmp_serial','sys_object_id',
    'manufacturer','model','hostname','sys_name','netbios_name')),
  normalized_value varchar(256) NOT NULL CHECK (btrim(normalized_value) <> ''
    AND normalized_value !~ '[[:cntrl:]]'),
  strength text NOT NULL CHECK (strength IN ('strong','corroborating','weak')),
  source varchar(64) NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  CHECK (first_seen_at <= last_seen_at),
  CHECK ((evidence_type IN ('network_node_binding','global_mac','snmp_serial') AND strength='strong')
    OR (evidence_type IN ('sys_object_id','manufacturer','model') AND strength='corroborating')
    OR (evidence_type IN ('local_mac','hostname','sys_name','netbios_name') AND strength='weak')),
  CHECK (CASE WHEN evidence_type IN ('global_mac','local_mac') THEN
    CASE WHEN normalized_value ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$'
      AND normalized_value NOT IN ('00:00:00:00:00:00','FF:FF:FF:FF:FF:FF') THEN
      (get_byte(decode(replace(normalized_value,':',''),'hex'),0) & 1)=0
      AND ((evidence_type='global_mac' AND (get_byte(decode(replace(normalized_value,':',''),'hex'),0) & 2)=0)
        OR (evidence_type='local_mac' AND (get_byte(decode(replace(normalized_value,':',''),'hex'),0) & 2)=2))
    ELSE false END ELSE true END),
  CHECK (evidence_type <> 'network_node_binding' OR normalized_value ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (evidence_type <> 'sys_object_id' OR normalized_value ~ '^[0-9]+(\.[0-9]+)+$'),
  UNIQUE (asset_id,evidence_type,normalized_value,source)
);
-- Duplicate evidence across assets is intentionally retained, not made globally unique.
CREATE INDEX identity_evidence_lookup_idx ON asset.identity_evidence(evidence_type,normalized_value,asset_id);
CREATE INDEX identity_evidence_asset_idx ON asset.identity_evidence(asset_id,last_seen_at DESC,id);

CREATE TABLE asset.endpoint_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES asset.assets(id) ON DELETE CASCADE,
  ip_address inet NOT NULL CHECK (family(ip_address)=4 AND masklen(ip_address)=32),
  state text NOT NULL CHECK (state IN ('current','historical','unresolved')),
  confidence text NOT NULL CHECK (confidence IN ('authoritative','high','medium','low')),
  source varchar(64) NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  ended_at timestamptz,
  network_node_ref uuid REFERENCES public.network_nodes(id) ON DELETE SET NULL,
  -- Provenance of a move: different interface identities can retain multiple endpoints.
  identity_key varchar(300),
  CHECK (identity_key IS NULL OR (btrim(identity_key) <> '' AND identity_key !~ '[[:cntrl:]]')),
  CHECK (first_seen_at <= last_seen_at),
  CHECK ((state='historical' AND ended_at IS NOT NULL AND ended_at >= last_seen_at)
    OR (state IN ('current','unresolved') AND ended_at IS NULL)),
  CHECK (state <> 'current' OR (confidence IN ('authoritative','high') AND identity_key IS NOT NULL))
);
CREATE UNIQUE INDEX endpoint_current_ip_unique ON asset.endpoint_assignments(ip_address) WHERE state='current';
CREATE INDEX endpoint_asset_timeline_idx ON asset.endpoint_assignments(asset_id,first_seen_at DESC,id);

UPDATE asset.assets a SET identity_state='resolved'
WHERE EXISTS (SELECT 1 FROM public.network_nodes n WHERE n.id=a.network_node_ref);
INSERT INTO asset.identity_evidence(asset_id,evidence_type,normalized_value,strength,source,first_seen_at,last_seen_at)
SELECT a.id,'network_node_binding',n.id::text,'strong','network_node',
  coalesce(a.first_seen_at,a.created_at),greatest(coalesce(a.first_seen_at,a.created_at),coalesce(a.last_seen_at,a.updated_at))
FROM asset.assets a JOIN public.network_nodes n ON n.id=a.network_node_ref;
INSERT INTO asset.endpoint_assignments(asset_id,ip_address,state,confidence,source,first_seen_at,last_seen_at,network_node_ref,identity_key)
SELECT a.id,n.ip_address,'current','authoritative','network_node',
  coalesce(a.first_seen_at,a.created_at),greatest(coalesce(a.first_seen_at,a.created_at),coalesce(a.last_seen_at,a.updated_at)),
  n.id,'network_node_binding:' || n.id::text
FROM asset.assets a JOIN public.network_nodes n ON n.id=a.network_node_ref;

INSERT INTO asset.identity_evidence(asset_id,evidence_type,normalized_value,strength,source,first_seen_at,last_seen_at)
SELECT id,CASE WHEN (get_byte(decode(replace(mac_address::text,':',''),'hex'),0) & 2)=0 THEN 'global_mac' ELSE 'local_mac' END,
  upper(mac_address::text),CASE WHEN (get_byte(decode(replace(mac_address::text,':',''),'hex'),0) & 2)=0 THEN 'strong' ELSE 'weak' END,
  'legacy_asset',coalesce(first_seen_at,created_at),greatest(coalesce(first_seen_at,created_at),coalesce(last_seen_at,updated_at))
FROM asset.assets WHERE mac_address IS NOT NULL AND mac_address::text <> '00:00:00:00:00:00'
  AND (get_byte(decode(replace(mac_address::text,':',''),'hex'),0) & 1)=0;

-- Non-explicit endpoint observations do not establish current ownership, even when IPs repeat.
INSERT INTO asset.endpoint_assignments(asset_id,ip_address,state,confidence,source,first_seen_at,last_seen_at)
SELECT a.id,a.ip_address,'unresolved','low','legacy_asset',coalesce(a.first_seen_at,a.created_at),
  greatest(coalesce(a.first_seen_at,a.created_at),coalesce(a.last_seen_at,a.updated_at))
FROM asset.assets a WHERE a.ip_address IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.network_nodes n WHERE n.id=a.network_node_ref AND n.ip_address=a.ip_address);

WITH snmp AS (
  SELECT a.id, v.kind, regexp_replace(btrim(v.value),'[[:space:]]+',' ','g') AS value,
    coalesce(d.last_success_at,d.last_polled_at,a.updated_at) AS seen_at
  FROM asset.assets a JOIN public.managed_telemetry_targets t ON t.node_id=a.network_node_ref
  JOIN public.managed_device_latest d ON d.target_id=t.id
  CROSS JOIN LATERAL (VALUES ('snmp_serial',d.serial_number),('sys_object_id',d.sys_object_id),
    ('manufacturer',d.manufacturer),('model',d.model),('sys_name',d.sys_name)) AS v(kind,value)
), valid AS (
  SELECT * FROM snmp WHERE length(value) BETWEEN 1 AND 256 AND value !~ '[[:cntrl:]]'
    AND lower(value) NOT IN ('-','unknown','n/a','na','none','null','not available','not specified','unspecified','to be filled by o.e.m.')
    AND lower(value) !~ '^(0+|0x[0-9a-f]*|[-?]+)$'
    AND value ~ '[[:alnum:]]'
    AND value !~* '(password|community|authorization|session_token|access_token|refresh_token|api_key|client_secret|private_key|database_url|service_role|secret)[[:space:]]*[:=]|bearer[[:space:]]+[^[:space:]]+'
    AND (kind <> 'sys_object_id' OR value ~ '^\.?[0-9]+(\.[0-9]+)+$')
)
INSERT INTO asset.identity_evidence(asset_id,evidence_type,normalized_value,strength,source,first_seen_at,last_seen_at)
SELECT id,kind,CASE WHEN kind='snmp_serial' THEN upper(value)
  WHEN kind='sys_object_id' THEN ltrim(value,'.') ELSE lower(value) END,
  CASE WHEN kind='snmp_serial' THEN 'strong' WHEN kind='sys_name' THEN 'weak' ELSE 'corroborating' END,
  'managed_telemetry',min(seen_at),max(seen_at)
FROM valid GROUP BY id,kind,CASE WHEN kind='snmp_serial' THEN upper(value)
  WHEN kind='sys_object_id' THEN ltrim(value,'.') ELSE lower(value) END;

-- Surface ambiguity without consolidating any legacy rows or changing their source keys.
UPDATE asset.assets a SET identity_state='conflict'
WHERE a.network_node_ref IS NULL AND EXISTS (
  SELECT 1 FROM asset.identity_evidence e WHERE e.asset_id=a.id AND e.strength='strong'
    AND EXISTS (SELECT 1 FROM asset.identity_evidence other
      WHERE other.evidence_type=e.evidence_type AND other.normalized_value=e.normalized_value AND other.asset_id<>a.id));

REVOKE ALL ON asset.identity_evidence,asset.endpoint_assignments FROM PUBLIC,jhc_netops_app;
GRANT SELECT,INSERT,UPDATE ON asset.identity_evidence,asset.endpoint_assignments TO jhc_netops_app;
COMMENT ON COLUMN asset.assets.identity_state IS 'Durable identity resolution, independent of classification and reachability.';
COMMENT ON COLUMN asset.endpoint_assignments.identity_key IS 'Normalized evidence anchor for endpoint moves; not an IP-derived identity.';
INSERT INTO public.application_schema_migrations(version) VALUES (19);
RESET ROLE;
COMMIT;
