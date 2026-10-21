-- Immutable audit trail, enforced at the database level, not just by
-- application convention. The app connects to Postgres as the same role
-- that owns these tables (a single-role setup), and table ownership always
-- bypasses GRANT/REVOKE in Postgres — so a REVOKE alone would do nothing
-- here. A BEFORE trigger that unconditionally raises fires regardless of
-- ownership, which is what actually makes "admin can access the log but
-- can't modify it" a real guarantee instead of just "no code path happens
-- to do it today."

CREATE OR REPLACE FUNCTION prevent_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Row is part of an immutable audit log — % is not permitted on %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Pure insert-only tables: no UPDATE, no DELETE, ever.
CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_log_mutation();

CREATE TRIGGER infusion_step_events_immutable
  BEFORE UPDATE OR DELETE ON infusion_step_events
  FOR EACH ROW EXECUTE FUNCTION prevent_log_mutation();

CREATE TRIGGER sync_inbox_log_immutable
  BEFORE UPDATE OR DELETE ON sync_inbox_log
  FOR EACH ROW EXECUTE FUNCTION prevent_log_mutation();

CREATE TRIGGER patient_history_immutable
  BEFORE UPDATE OR DELETE ON patient_history
  FOR EACH ROW EXECUTE FUNCTION prevent_log_mutation();

CREATE TRIGGER infusion_telemetry_log_immutable
  BEFORE UPDATE OR DELETE ON infusion_telemetry_log
  FOR EACH ROW EXECUTE FUNCTION prevent_log_mutation();

-- machine_commands is the one exception that needs UPDATE (status,
-- respondedAt, result get filled in after the command is sent) — only
-- DELETE is blocked, since a command attempt must never disappear.
CREATE TRIGGER machine_commands_no_delete
  BEFORE DELETE ON machine_commands
  FOR EACH ROW EXECUTE FUNCTION prevent_log_mutation();