-- Whether the chair's pitch/roll are referenced to a stored level, or are
-- still relative to whatever pose it happened to boot in. Without this the
-- console cannot tell "on a slope" from "never calibrated".
alter table public.device_state add column if not exists imu_calibrated boolean;;
