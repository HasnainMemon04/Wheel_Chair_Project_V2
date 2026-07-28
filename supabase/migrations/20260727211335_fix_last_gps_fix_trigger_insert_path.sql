-- OLD is unassigned in a BEFORE INSERT trigger, so the previous version could
-- raise "record old is not assigned yet" the first time a brand-new chair was
-- inserted — which would have broken ingest for that device. Branch on TG_OP.
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
  elsif tg_op = 'UPDATE' then
    -- Carry history forward: an upsert that omits these columns must not
    -- erase the last real position.
    new.last_fix_lat := coalesce(new.last_fix_lat, old.last_fix_lat);
    new.last_fix_lng := coalesce(new.last_fix_lng, old.last_fix_lng);
    new.last_fix_at  := coalesce(new.last_fix_at,  old.last_fix_at);
  end if;
  return new;
end;
$$ language plpgsql;;
