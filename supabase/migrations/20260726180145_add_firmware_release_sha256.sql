alter table public.firmware_releases
add column if not exists sha256 text;

alter table public.firmware_releases
drop constraint if exists firmware_releases_sha256_format;

alter table public.firmware_releases
add constraint firmware_releases_sha256_format
check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');

comment on column public.firmware_releases.sha256 is
'Lowercase SHA-256 digest of the exact firmware binary, verified by the ESP32 before boot partition activation.';;
