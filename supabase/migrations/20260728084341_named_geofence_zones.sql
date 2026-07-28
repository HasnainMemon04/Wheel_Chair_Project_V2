-- Operator-drawn, NAMED geofence zones.
--
-- Circles, deliberately: the device's SET_GEOFENCE command takes
-- (lat, lng, radius), so a circle is the only shape a chair can actually
-- enforce on-board. Anything else would be a map decoration the hardware
-- could not honour.
--
-- Crossing a boundary NEVER locks a chair — locking a moving wheelchair could
-- throw its rider. The device reports GEOFENCE_EXIT and the operator decides.
create table if not exists public.geofences (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  center_lat  double precision not null,
  center_lng  double precision not null,
  radius_m    real not null default 300,
  color       text not null default '#5b62d8',
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint geofences_radius_sane check (radius_m >= 25 and radius_m <= 5000),
  constraint geofences_lat_sane check (center_lat between -90 and 90),
  constraint geofences_lng_sane check (center_lng between -180 and 180)
);

create index if not exists idx_geofences_active on public.geofences (active);

alter table public.geofences enable row level security;

-- TODO(prod): restrict writes to the authenticated operator role (M7), the
-- same follow-up the other tables carry.
drop policy if exists "anyone can read geofences" on public.geofences;
create policy "anyone can read geofences" on public.geofences for select using (true);
drop policy if exists "anyone can write geofences" on public.geofences;
create policy "anyone can write geofences" on public.geofences for all using (true) with check (true);

grant select, insert, update, delete on public.geofences to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated;

-- Live updates so a zone drawn in ops appears in the rider app immediately.
do $$
begin
  alter publication supabase_realtime add table public.geofences;
exception when duplicate_object then null;
end $$;

-- Seed the three operating sites the prototype ships with, so the map is not
-- empty on first load.
insert into public.geofences (name, center_lat, center_lng, radius_m, color)
select * from (values
  ('Makkah — Al Haram',            21.4225, 39.8262, 900::real,  '#5b62d8'),
  ('Makkah — Jabal Omar',          21.4184, 39.8203, 700::real,  '#2a9d8f'),
  ('Madinah — Al Masjid an Nabawi',24.4672, 39.6112, 900::real,  '#e07a3f')
) as seed(name, center_lat, center_lng, radius_m, color)
where not exists (select 1 from public.geofences);;
