\set ON_ERROR_STOP on

BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'jhc_netops' THEN
    RAISE EXCEPTION 'P10C rollback is permitted only in jhc_netops';
  END IF;
END
$guard$;

LOCK TABLE asset.assets IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM asset.assets) THEN
    RAISE EXCEPTION 'P10C rollback refused because asset.assets contains data';
  END IF;
END
$guard$;

REVOKE ALL ON ALL TABLES IN SCHEMA asset FROM jhc_netops_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA asset FROM jhc_netops_app;
REVOKE USAGE ON SCHEMA asset FROM jhc_netops_app;
DROP SCHEMA asset CASCADE;
COMMIT;
