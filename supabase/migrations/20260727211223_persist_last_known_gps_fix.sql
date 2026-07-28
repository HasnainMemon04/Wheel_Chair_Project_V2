-- Last known REAL position, kept independently of the live lat/lng.
--
-- lat/lng always carry the chair's best current estimate (which indoors is the
-- device's bounded fallback wander). These columns record the last position
-- that came from an actual satellite fix, so the fleet can still be located
-- after a chair disconnects, and a chair that boots indoors and never gets a
-- fix can still be shown where it genuinely was.
alter table device_state add column if not exists last_fix_lat double precision;
alter table device_state add column if not exists last_fix_lng double precision;
alter table device_state add column if not exists last_fix_at  timestamptz;

-- Maintained by the database so every write path (ingest, ack, manual) keeps
-- them consistent without having to remember to.
create or replace function public.capture_last_gps_fix()
returns trigger as $$
begin
  if new.gps_fix is true
     and new.lat is not null and new.lng is not null
     and not (new.lat = 0 and new.lng = 0)
     and coalesce(new.gps_simulated, false) = false
  then
    new.last_fix_lat := new.lat;
    new.last_fix_lng := new.lng;
    new.last_fix_at  := coalesce(new.ts, now());
  else
    -- Carry the previous value forward; an upsert that omits these columns
    -- must not erase the history.
    new.last_fix_lat := coalesce(new.last_fix_lat, old.last_fix_lat);
    new.last_fix_lng := coalesce(new.last_fix_lng, old.last_fix_lng);
    new.last_fix_at  := coalesce(new.last_fix_at,  old.last_fix_at);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_capture_last_gps_fix on public.device_state;
create trigger trg_capture_last_gps_fix
  before insert or update on public.device_state
  for each row execute function public.capture_last_gps_fix();

-- Seed from whatever each chair currently reports so the map is never blank
-- for a chair that already has a plausible position.
update device_state
set last_fix_lat = lat, last_fix_lng = lng, last_fix_at = ts
where last_fix_lat is null and lat is not null and lng is not null
  and not (lat = 0 and lng = 0);;
