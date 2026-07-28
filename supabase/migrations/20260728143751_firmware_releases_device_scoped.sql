-- DEVICE_ID and DEVICE_KEY are compiled into the image, so a binary built for
-- one chair turns any other chair it lands on into a duplicate of that chair —
-- which is exactly how WCHAIR-004 lost its identity and went offline. Release
-- 0.5.0 already pointed at firmware_v0.5.0_wchair-003.bin with nothing
-- stopping a fleet-wide deploy of it.
--
-- Releases are therefore device-scoped. NULL means "universal", for a future
-- build that reads its identity from NVS instead of the binary.
alter table public.firmware_releases add column if not exists device_id text;

alter table public.firmware_releases
  add constraint firmware_releases_device_fk
  foreign key (device_id) references public.wheelchairs(id) on delete cascade
  not valid;

-- A version alone is no longer unique; a version *for a device* is.
alter table public.firmware_releases drop constraint if exists firmware_releases_version_key;
drop index if exists firmware_releases_version_key;

create unique index if not exists firmware_releases_version_device_uidx
  on public.firmware_releases (version, coalesce(device_id, '*'));

-- Existing 0.5.0 artefact is the WCHAIR-003 build; label it so it can never be
-- pushed to another chair.
update public.firmware_releases
set device_id = 'WCHAIR-003'
where version = '0.5.0' and url like '%wchair-003%' and device_id is null;;
