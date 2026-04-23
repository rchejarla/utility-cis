-- Enable TimescaleDB and convert `meter_read` to a hypertable partitioned
-- by `read_datetime`, one chunk per month. The extension is preloaded by
-- the `timescale/timescaledb` Docker image; the CREATE EXTENSION call is
-- defensive for any Postgres image that doesn't auto-install it.
--
-- This migration must run after init (which creates `meter_read`) and
-- before any rows are inserted — `create_hypertable` only supports
-- empty-table conversion cleanly.

CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT create_hypertable(
  'meter_read',
  'read_datetime',
  chunk_time_interval => INTERVAL '1 month'
);
