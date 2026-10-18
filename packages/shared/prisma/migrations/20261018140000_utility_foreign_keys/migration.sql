-- utility_id becomes a foreign key on every table that carries it.
--
-- Added after the Utility row exists in both seeds and in the test
-- fixtures, so the constraint is applied to data that already satisfies
-- it. No backfill: the product is in development, and data that does not
-- fit is reseeded rather than repaired.
--
-- ON DELETE RESTRICT, not CASCADE. A cascade would let one mistaken
-- delete erase a utility's entire history — every customer, bill and
-- ledger entry — from a single call. Seven of these are nullable: the
-- global reference rows (account_type_def, premise_type_def,
-- suspension_type_def and friends) carry utility_id IS NULL and are
-- readable by every tenant.
--
-- Generated with `prisma migrate diff` and then filtered: the diff also
-- wanted to drop and recreate 27 unrelated constraints whose
-- hand-written names predate Prisma's naming convention. That drift is
-- pre-existing and is not this migration's business.

ALTER TABLE "commodity" ADD CONSTRAINT "commodity_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_of_measure" ADD CONSTRAINT "unit_of_measure_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "premise_type_def" ADD CONSTRAINT "premise_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_type_def" ADD CONSTRAINT "account_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "measure_type_def" ADD CONSTRAINT "measure_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "premise" ADD CONSTRAINT "premise_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meter" ADD CONSTRAINT "meter_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account" ADD CONSTRAINT "account_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_agreement" ADD CONSTRAINT "service_agreement_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_point" ADD CONSTRAINT "service_point_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_point_meter" ADD CONSTRAINT "service_point_meter_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_schedule" ADD CONSTRAINT "rate_schedule_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_component" ADD CONSTRAINT "rate_component_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sa_rate_schedule_assignment" ADD CONSTRAINT "sa_rate_schedule_assignment_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_index" ADD CONSTRAINT "rate_index_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_cycle" ADD CONSTRAINT "billing_cycle_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bill_segment" ADD CONSTRAINT "bill_segment_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bill_segment_line" ADD CONSTRAINT "bill_segment_line_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bill" ADD CONSTRAINT "bill_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meter_read" ADD CONSTRAINT "meter_read_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "utility_theme" ADD CONSTRAINT "utility_theme_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer" ADD CONSTRAINT "customer_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contact" ADD CONSTRAINT "contact_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_address" ADD CONSTRAINT "billing_address_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meter_register" ADD CONSTRAINT "meter_register_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role" ADD CONSTRAINT "role_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cis_user" ADD CONSTRAINT "cis_user_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "utility_module" ADD CONSTRAINT "utility_module_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meter_event" ADD CONSTRAINT "meter_event_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "container" ADD CONSTRAINT "container_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "custom_field_schema" ADD CONSTRAINT "custom_field_schema_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "utility_config" ADD CONSTRAINT "utility_config_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "suspension_type_def" ADD CONSTRAINT "suspension_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_suspension" ADD CONSTRAINT "service_suspension_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_event" ADD CONSTRAINT "service_event_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "in_app_notification" ADD CONSTRAINT "in_app_notification_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification" ADD CONSTRAINT "notification_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delinquency_rule" ADD CONSTRAINT "delinquency_rule_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delinquency_action" ADD CONSTRAINT "delinquency_action_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_request_type_def" ADD CONSTRAINT "service_request_type_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sla" ADD CONSTRAINT "sla_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_request_counter" ADD CONSTRAINT "service_request_counter_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_request" ADD CONSTRAINT "service_request_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_component_kind" ADD CONSTRAINT "rate_component_kind_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_assignment_role" ADD CONSTRAINT "rate_assignment_role_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_service_class" ADD CONSTRAINT "rate_service_class_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "utility_setting" ADD CONSTRAINT "utility_setting_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wqa_value" ADD CONSTRAINT "wqa_value_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_application" ADD CONSTRAINT "ledger_application_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_reason_def" ADD CONSTRAINT "ledger_reason_def_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bill_message" ADD CONSTRAINT "bill_message_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bill_document" ADD CONSTRAINT "bill_document_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_run" ADD CONSTRAINT "billing_run_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_run_item" ADD CONSTRAINT "billing_run_item_utility_id_fkey" FOREIGN KEY ("utility_id") REFERENCES "utility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
