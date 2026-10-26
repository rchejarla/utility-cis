-- The field work a delinquency tier dispatches (#198, #199).
--
-- By service-request type code, and null for a tier that dispatches
-- none. Configuration rather than something inferred from action_type: a
-- utility whose crews work off their own system wants the notice tiers
-- and no work orders at all, and the codes are the tenant's own —
-- "SHUT_OFF" for one, "TURN_OFF_NONPAY" for the next.
--
-- No foreign key, deliberately. service_request_type_def admits global
-- rows with a null utility_id, so a tenant-scoped composite key cannot
-- reference it, and a single-column key to a table whose rows may be
-- global would let one tenant's rule point at another's private type.
-- `assertServiceRequestTypeCode` validates the code when the rule is
-- saved, and the sweep skips a code that has since been deactivated
-- rather than failing the tenant's whole pass over one account.
--
-- VARCHAR(100) matches service_request_type_def.code and the Zod
-- validator's own max, rather than the 50 used for action_type.
ALTER TABLE delinquency_rule
  ADD COLUMN service_request_type_code   VARCHAR(100),
  ADD COLUMN reconnect_request_type_code VARCHAR(100);
