\set ON_ERROR_STOP on
SET ROLE jhc_netops_owner;
\ir ../../backend/migrations/001_asset_inventory_foundation.sql
\ir ../../backend/migrations/002_asset_intelligence.sql
\ir ../../backend/migrations/003_active_inventory_scan.sql
\ir ../../backend/migrations/004_asset_change_history.sql
\ir ../../backend/migrations/005_scan_network_settings.sql
\ir ../../backend/migrations/006_medical_equipment.sql
GRANT USAGE ON SCHEMA asset TO jhc_netops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA asset TO jhc_netops_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA asset TO jhc_netops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA asset GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jhc_netops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA asset GRANT USAGE, SELECT ON SEQUENCES TO jhc_netops_app;
REVOKE UPDATE, DELETE, TRUNCATE ON asset.change_events FROM jhc_netops_app;
GRANT SELECT, INSERT ON asset.change_events TO jhc_netops_app;
RESET ROLE;
