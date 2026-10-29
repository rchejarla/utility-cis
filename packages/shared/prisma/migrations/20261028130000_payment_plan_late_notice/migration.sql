-- How far the late notices have got.
--
-- A plan that is behind has to be told once per instalment, not once
-- per sweep: the sweep runs nightly, so a notice keyed on "is late"
-- alone would mail the customer every night until they paid or
-- defaulted. Nobody is defaulted silently, and nobody is told five
-- times.
--
-- Holds the highest instalment number already noticed — 0 for the down
-- payment, n for instalment n — so a second instalment going late
-- notifies again while the first one going late again does not. NULL
-- means nothing has been noticed yet, which is every plan agreed before
-- this column existed and every plan being kept.
--
-- A column rather than a query over the notification log, because the
-- log records what was *dispatched* and a template the tenant has not
-- configured dispatches nothing: `sendNotification` answers null, and
-- the sweep would then re-ask every night forever. What matters here is
-- that the sweep has already decided to tell them.
ALTER TABLE payment_plan
  ADD COLUMN late_notice_installment INTEGER;

ALTER TABLE payment_plan
  ADD CONSTRAINT payment_plan_late_notice_installment_not_negative CHECK (
    late_notice_installment IS NULL OR late_notice_installment >= 0
  );
