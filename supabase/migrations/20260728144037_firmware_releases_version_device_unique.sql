-- The expression index on coalesce(device_id,'*') enforced the right rule but
-- ON CONFLICT cannot infer it, so upserts failed. A plain unique on the two
-- columns is inferrable; NULLS NOT DISTINCT keeps a single universal release
-- per version rather than allowing unlimited NULL duplicates.
drop index if exists firmware_releases_version_device_uidx;

alter table public.firmware_releases
  drop constraint if exists firmware_releases_version_device_key;

alter table public.firmware_releases
  add constraint firmware_releases_version_device_key
  unique nulls not distinct (version, device_id);;
