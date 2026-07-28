-- ===========================================================================
--  Smart Rental Wheelchair — Supabase schema (starting migration)
--  Implements the data model in docs/API.md with the hot/cold split from
--  docs/PRODUCTION.md §2 for scalability. Run in the Supabase SQL editor.
-- ===========================================================================

-- profiles: extends Supabase auth.users with a role
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  phone       text,
  role        text not null default 'rider' check (role in ('rider','operator')),
  created_at  timestamptz default now()
);

create table if not exists wheelchairs (
  id          text primary key,                 -- e.g. WCHAIR-001
  fw_version  text,
  device_key  text not null,                    -- per-device key for HMAC verification
  status      text default 'available',
  created_at  timestamptz default now()
);

-- HOT: one row per chair, upserted every telemetry. The live map subscribes here.
create table if not exists device_state (
  wheelchair_id text primary key references wheelchairs(id) on delete cascade,
  ts            timestamptz not null default now(),
  online        boolean default false,
  lat double precision, lng double precision,
  speed real, sats int, hdop real,
  gps_fix boolean default false,
  gps_simulated boolean default false,
  gps_course real, gps_altitude real, gps_age_ms int,
  gps_chars bigint, gps_sentences bigint, gps_checksum_failures bigint,
  gps_nmea_gga text, gps_nmea_rmc text,
  pitch real, roll real, tilt real, yaw real,
  imu_accel_x real, imu_accel_y real, imu_accel_z real,
  imu_gyro_x real, imu_gyro_y real, imu_gyro_z real, imu_age_ms int,
  temp_motor real, temp_batt real, temp_amb real, humidity real,
  batt_v real, batt_pct int, in_motion boolean, rssi int,
  tamper boolean default false, tamper_count int default 0,
  uptime int,          -- device uptime seconds (from telemetry `up`; NOT a timestamp)
  hist_up int,         -- uptime at the last telemetry_history insert (gap-based downsampling)
  power boolean, locked boolean,
  session_state text, time_left int, speed_limit int, over_speed boolean,
  geofence jsonb
);

-- COLD: append-only history. DOWNSAMPLE on ingest + apply retention (30-90d).
-- Consider monthly partitioning at scale.
create table if not exists telemetry_history (
  id            bigserial primary key,
  wheelchair_id text not null references wheelchairs(id) on delete cascade,
  ts            timestamptz not null default now(),
  data          jsonb not null
);
create index if not exists idx_hist_chair_ts on telemetry_history (wheelchair_id, ts desc);

-- Anti-tamper columns (idempotent — safe to re-run on an already-deployed DB).
alter table device_state add column if not exists tamper       boolean default false;
alter table device_state add column if not exists tamper_count int default 0;
alter table device_state add column if not exists yaw          real default 0.0;
alter table device_state add column if not exists gps_fix      boolean default false;
alter table device_state add column if not exists gps_simulated boolean default false;
alter table device_state add column if not exists gps_course   real;
alter table device_state add column if not exists gps_altitude real;
alter table device_state add column if not exists gps_age_ms   int;
alter table device_state add column if not exists gps_chars    bigint;
alter table device_state add column if not exists gps_sentences bigint;
alter table device_state add column if not exists gps_checksum_failures bigint;
alter table device_state add column if not exists gps_nmea_gga text;
alter table device_state add column if not exists gps_nmea_rmc text;
alter table device_state add column if not exists imu_accel_x  real;
alter table device_state add column if not exists imu_accel_y  real;
alter table device_state add column if not exists imu_accel_z  real;
alter table device_state add column if not exists imu_gyro_x   real;
alter table device_state add column if not exists imu_gyro_y   real;
alter table device_state add column if not exists imu_gyro_z   real;
alter table device_state add column if not exists imu_age_ms   int;

-- C1: persist device uptime (seconds) — distinct from the ts wall-clock column.
alter table device_state add column if not exists uptime  int;
-- H2: uptime at the last telemetry_history insert (gap-based downsampling state).
alter table device_state add column if not exists hist_up int;

-- Safe column rename migrations
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='device_state' AND column_name='temp_board') THEN
    ALTER TABLE device_state RENAME COLUMN temp_board TO temp_batt;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='device_state' AND column_name='occupied') THEN
    ALTER TABLE device_state RENAME COLUMN occupied TO in_motion;
  END IF;
END $$;


create table if not exists events (
  id            bigserial primary key,
  wheelchair_id text not null references wheelchairs(id) on delete cascade,
  type          text not null,
  detail        jsonb,
  lat double precision, lng double precision,
  ts            timestamptz not null default now()
);
create index if not exists idx_events_chair_ts on events (wheelchair_id, ts desc);

create table if not exists rentals (
  id            uuid primary key default gen_random_uuid(),
  wheelchair_id text not null references wheelchairs(id),
  user_id       uuid references profiles(id),
  state         text not null default 'reserved',
  start_at      timestamptz,
  end_at        timestamptz,
  duration_s    int,
  speed_limit   int default 6,
  created_at    timestamptz default now()
);
create index if not exists idx_rentals_user_state on rentals (user_id, state);

create table if not exists payments (
  id            uuid primary key default gen_random_uuid(),
  rental_id     uuid not null references rentals(id) on delete cascade,
  amount        int, currency text default 'PKR',
  provider      text, provider_ref text unique,      -- unique => idempotent webhooks
  status        text default 'pending',
  paid_at       timestamptz
);

-- Command queue: operator/web inserts; firmware receives pending rows via ingest and writes ack.
create table if not exists commands (
  id            uuid primary key default gen_random_uuid(),
  wheelchair_id text not null references wheelchairs(id) on delete cascade,
  cmd           text not null,
  args          jsonb default '{}'::jsonb,
  status        text not null default 'pending' check (status in ('pending','acked','failed')),
  req_id        text,
  ack           jsonb,
  created_at    timestamptz default now(),
  acked_at      timestamptz
);
create index if not exists idx_cmd_chair_status on commands (wheelchair_id, status);
create index if not exists idx_cmd_req_id on commands (req_id);

-- ---------------------------------------------------------------------------
-- Realtime: expose the small/live tables to the website.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table device_state;
alter publication supabase_realtime add table events;
alter publication supabase_realtime add table rentals;
alter publication supabase_realtime add table commands;

-- ---------------------------------------------------------------------------
-- Row Level Security (tighten before production — see docs/SECURITY.md).
--  * riders: read their own rentals/payments; read available wheelchairs + state.
--  * operators: full fleet read + command insert.
--  * devices: NOT direct table writers — they go through the /ingest Edge Function
--    (service role), which validates the device key + HMAC.
-- ---------------------------------------------------------------------------
alter table device_state       enable row level security;
alter table events             enable row level security;
alter table rentals            enable row level security;
alter table payments           enable row level security;
alter table commands           enable row level security;
alter table wheelchairs        enable row level security;

-- Example policies (expand per SECURITY.md):
create policy "read available chairs" on wheelchairs for select using (true);
create policy "read device_state"     on device_state for select using (true);
create policy "read events"           on events for select using (true);
create policy "rider reads own rentals" on rentals for select
  using (auth.uid() = user_id);
create policy "operator reads fleet" on rentals for select
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'operator'));
-- TODO(prod): Restrict to authenticated rider/operator roles in M7
create policy "anyone can insert rentals" on rentals for insert with check (true);
-- TODO(prod): Restrict to authenticated rider/operator roles in M7
create policy "anyone can update rentals" on rentals for update using (true);

-- TODO(prod): Restrict to authenticated operator roles in M7
create policy "anyone can insert commands" on commands for insert with check (true);
-- TODO(prod): Restrict to authenticated devices/operators in M7
create policy "anyone can read commands"   on commands for select using (true);
-- TODO(prod): Restrict to authenticated devices/operators in M7
create policy "anyone can update commands" on commands for update using (true);

-- TODO(prod): Restrict to authenticated gateway/stripe webhooks in M7
create policy "anyone can insert payments" on payments for insert with check (true);
-- TODO(prod): Restrict to authenticated rider/operator roles in M7
create policy "anyone can read payments"   on payments for select using (true);

-- ---------------------------------------------------------------------------
-- Table Grants: Allow anon and authenticated roles to query tables
-- ---------------------------------------------------------------------------
grant select on public.profiles to anon, authenticated;
grant select on public.wheelchairs to anon, authenticated;
grant select on public.device_state to anon, authenticated;
grant select on public.events to anon, authenticated;
grant select, insert, update on public.rentals to anon, authenticated;
grant select on public.payments to anon, authenticated;
grant select, insert, update on public.commands to anon, authenticated;

-- Allow service_role (Edge Functions) full control over tables
grant select, insert, update, delete on public.profiles to service_role;
grant select, insert, update, delete on public.wheelchairs to service_role;
grant select, insert, update, delete on public.device_state to service_role;
grant select, insert, update, delete on public.events to service_role;
grant select, insert, update, delete on public.rentals to service_role;
grant select, insert, update, delete on public.payments to service_role;
grant select, insert, update, delete on public.commands to service_role;
-- events.id is a bigserial backed by events_id_seq. Service-role API routes
-- and Edge Functions that insert audit rows need sequence usage in addition to
-- table INSERT privileges.
grant usage, select on sequence public.events_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- C2: Atomic payment → activation → unlock (called by the Vercel webhook).
-- The payment insert, rental activation, and command enqueue commit or roll
-- back as ONE transaction — a webhook crash can no longer leave a rider who
-- paid with an "active" rental and no UNLOCK command ever queued.
-- Command req_ids are DETERMINISTIC (keyed on the rental id) so retries and
-- the reconciler below are idempotent.
-- ---------------------------------------------------------------------------
create or replace function activate_rental_tx(
  p_rental_id   uuid,
  p_amount      int,
  p_provider    text,
  p_provider_ref text,
  p_currency    text default 'PKR'
) returns jsonb as $$
declare
  v_rental rentals%rowtype;
  v_lat double precision;
  v_lng double precision;
  v_unlock_dispatched boolean;
begin
  -- Serialize concurrent webhook retries for the same rental.
  select * into v_rental from rentals where id = p_rental_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'rental_not_found');
  end if;

  if v_rental.state = 'active' then
    -- Idempotency guard that is SAFE: only short-circuit if an UNLOCK was
    -- actually dispatched for this rental. Otherwise fall through and repair
    -- (fixes the historical partial-failure trap).
    select exists (
      select 1 from commands c
      where c.wheelchair_id = v_rental.wheelchair_id
        and c.cmd = 'UNLOCK'
        and c.req_id = 'unlock-' || p_rental_id::text
    ) into v_unlock_dispatched;
    if v_unlock_dispatched then
      return jsonb_build_object('ok', true, 'message', 'already_active');
    end if;
  elsif v_rental.state <> 'reserved' then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'state', v_rental.state);
  end if;

  -- 1. Payment record (idempotent on the unique provider_ref).
  insert into payments (rental_id, amount, currency, provider, provider_ref, status, paid_at)
  values (p_rental_id, p_amount, p_currency, p_provider, p_provider_ref, 'PAID', now())
  on conflict (provider_ref) do nothing;

  -- 2. Activate the rental (coalesce keeps a repair pass from extending it).
  update rentals
  set state    = 'active',
      start_at = coalesce(start_at, now()),
      end_at   = coalesce(end_at, now() + make_interval(secs => duration_s))
  where id = p_rental_id;

  -- 3. Geofence center from the chair's last known position.
  select ds.lat, ds.lng into v_lat, v_lng
  from device_state ds where ds.wheelchair_id = v_rental.wheelchair_id;

  -- 4. Enqueue UNLOCK + SET_SPEED_LIMIT + SET_GEOFENCE (idempotent req_ids).
  insert into commands (wheelchair_id, cmd, args, status, req_id)
  select v_rental.wheelchair_id, c.cmd, c.args, 'pending', c.req_id
  from (values
    ('UNLOCK',
     jsonb_build_object('duration_s', v_rental.duration_s),
     'unlock-' || p_rental_id::text),
    ('SET_SPEED_LIMIT',
     jsonb_build_object('kmh', coalesce(v_rental.speed_limit, 6)),
     'speed-' || p_rental_id::text),
    ('SET_GEOFENCE',
     jsonb_build_object('lat', coalesce(v_lat, 24.860731),
                        'lng', coalesce(v_lng, 67.001142),
                        'radius', 300),
     'geofence-' || p_rental_id::text)
  ) as c(cmd, args, req_id)
  where not exists (
    select 1 from commands k
    where k.wheelchair_id = v_rental.wheelchair_id and k.req_id = c.req_id
  );

  return jsonb_build_object('ok', true, 'unlocked', true);
end;
$$ language plpgsql security definer;

-- Only the service role (webhook) may invoke the money-touching transaction.
revoke execute on function activate_rental_tx(uuid, int, text, text, text) from public, anon, authenticated;
grant execute on function activate_rental_tx(uuid, int, text, text, text) to service_role;

-- Operator/rider session termination. The command and rental state transition
-- are committed together; the device ack remains the authority for "ended".
create or replace function request_session_end_tx(
  p_wheelchair_id text,
  p_reason text default 'operator_cancel'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_command_id uuid;
  v_command text;
  v_locked boolean;
  v_rental_id uuid;
  v_req_id text;
  v_session_state text;
begin
  select ds.locked, ds.session_state
  into v_locked, v_session_state
  from device_state ds
  where ds.wheelchair_id = p_wheelchair_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'device_not_found');
  end if;

  if coalesce(v_locked, false)
     and coalesce(v_session_state, 'LOCKED') in ('LOCKED', 'AVAILABLE') then
    return jsonb_build_object('ok', true, 'message', 'already_available');
  end if;

  select r.id
  into v_rental_id
  from rentals r
  where r.wheelchair_id = p_wheelchair_id
    and r.state in ('active', 'expiring', 'ending')
  order by r.created_at desc
  limit 1
  for update;

  if v_rental_id is not null then
    update rentals
    set state = 'ending'
    where id = v_rental_id
      and state in ('active', 'expiring', 'ending');
    v_req_id := 'end-' || v_rental_id::text;
  else
    v_req_id := 'operator-end-' || gen_random_uuid()::text;
  end if;

  select c.id
  into v_command_id
  from commands c
  where c.wheelchair_id = p_wheelchair_id
    and c.status = 'pending'
    and c.created_at > now() - interval '2 minutes'
    and (c.req_id = v_req_id or c.req_id like 'operator-end-%')
  order by c.created_at desc
  limit 1;

  if v_command_id is not null then
    return jsonb_build_object(
      'ok', true,
      'message', 'already_pending',
      'command_id', v_command_id,
      'rental_id', v_rental_id
    );
  end if;

  v_command := case
    when p_wheelchair_id = 'WCHAIR-001' then 'LOCK'
    else 'END_SESSION'
  end;

  insert into commands (wheelchair_id, cmd, args, status, req_id)
  values (
    p_wheelchair_id,
    v_command,
    jsonb_build_object('reason', p_reason),
    'pending',
    v_req_id
  )
  returning id into v_command_id;

  insert into events (wheelchair_id, type, detail)
  values (
    p_wheelchair_id,
    'SESSION_END_REQUESTED',
    jsonb_build_object(
      'reason', p_reason,
      'rental_id', v_rental_id,
      'command_id', v_command_id,
      'command', v_command
    )
  );

  return jsonb_build_object(
    'ok', true,
    'message', 'queued',
    'command_id', v_command_id,
    'rental_id', v_rental_id,
    'command', v_command
  );
end;
$$;

revoke all on function request_session_end_tx(text, text)
from public, anon, authenticated;
grant execute on function request_session_end_tx(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Rental State Session Supervisor Task (Cron Engine Backend Authority)
-- ---------------------------------------------------------------------------
-- C3 + M4 rewrite. Changes vs the original:
--  * SET-BASED statements (no per-rental loop) so a large fleet can't make a
--    run overlap the next pg_cron minute (overlapping runs get skipped).
--  * Expired rentals go to the intermediate state 'ending' — NOT straight to
--    'ended'. The DEVICE is the authority: the commands/ack handler promotes
--    'ending' → 'ended' when the device acks END_SESSION. If the device never
--    acks (offline) a grace period closes the rental and emits a visible
--    SESSION_END_OFFLINE event instead of silently lying.
--  * C2 reconciler: repairs 'active' rentals whose UNLOCK was never dispatched.
create or replace function check_rental_sessions()
returns void as $$
begin
  -- 1. Expired active/expiring rentals -> 'ending' + queue END_SESSION.
  with expired as (
    update rentals r
    set state = 'ending'
    where r.state in ('active', 'expiring') and r.end_at <= now()
    returning r.id, r.wheelchair_id
  ),
  cmds as (
    insert into commands (wheelchair_id, cmd, req_id, status, args)
    select e.wheelchair_id, 'END_SESSION', 'end-' || e.id::text, 'pending', '{}'::jsonb
    from expired e
    where not exists (select 1 from commands c where c.req_id = 'end-' || e.id::text)
    returning 1
  )
  insert into events (wheelchair_id, type, detail, lat, lng)
  select e.wheelchair_id, 'SESSION_LOCKED', jsonb_build_object('rental_id', e.id), ds.lat, ds.lng
  from expired e
  left join device_state ds on ds.wheelchair_id = e.wheelchair_id;

  -- 2. Grace fallback: device never acked END_SESSION within 2 minutes of
  --    expiry (most likely offline). Close the rental but FLAG it loudly.
  with overdue as (
    update rentals r
    set state = 'ended'
    where r.state = 'ending'
      and r.end_at <= now() - interval '2 minutes'
      and not exists (
        select 1 from commands c
        where c.req_id = 'end-' || r.id::text and c.status = 'acked'
      )
    returning r.id, r.wheelchair_id
  )
  insert into events (wheelchair_id, type, detail, lat, lng)
  select o.wheelchair_id, 'SESSION_END_OFFLINE',
         jsonb_build_object('rental_id', o.id,
                            'reason', 'device did not ack END_SESSION within grace period'),
         ds.lat, ds.lng
  from overdue o
  left join device_state ds on ds.wheelchair_id = o.wheelchair_id;

  -- 3. Warning window (<= 120s left) -> 'expiring' + WARN_EXPIRY.
  with warned as (
    update rentals r
    set state = 'expiring'
    where r.state = 'active' and r.end_at <= now() + interval '120 seconds' and r.end_at > now()
    returning r.id, r.wheelchair_id, greatest(0, extract(epoch from (r.end_at - now()))::int) as tl
  ),
  wcmds as (
    insert into commands (wheelchair_id, cmd, req_id, status, args)
    select w.wheelchair_id, 'WARN_EXPIRY', 'warn-' || w.id::text, 'pending',
           jsonb_build_object('time_left', w.tl)
    from warned w
    where not exists (select 1 from commands c where c.req_id = 'warn-' || w.id::text)
    returning 1
  )
  insert into events (wheelchair_id, type, detail, lat, lng)
  select w.wheelchair_id, 'EXPIRY_WARNING', jsonb_build_object('time_left', w.tl), ds.lat, ds.lng
  from warned w
  left join device_state ds on ds.wheelchair_id = w.wheelchair_id;

  -- 4. C2 reconciler (safety net): an 'active' rental with NO UNLOCK dispatched
  --    since it was created means a partial webhook failure — repair it.
  insert into commands (wheelchair_id, cmd, args, status, req_id)
  select r.wheelchair_id, 'UNLOCK',
         jsonb_build_object('duration_s', r.duration_s), 'pending',
         'unlock-' || r.id::text
  from rentals r
  where r.state = 'active'
    and r.end_at > now()
    and not exists (
      select 1 from commands c
      where c.wheelchair_id = r.wheelchair_id
        and c.cmd = 'UNLOCK'
        and c.req_id = 'unlock-' || r.id::text
    );
end;
$$ language plpgsql;

-- M4: the supervisor filters on (state, end_at) every minute — index it.
create index if not exists idx_rentals_state_end on rentals (state, end_at);

-- Enable pg_cron and schedule task (default schedule runs every minute)
create extension if not exists pg_cron;
select cron.schedule('check-sessions', '* * * * *', 'select check_rental_sessions()');

-- OTA System schema updates
alter table public.wheelchairs add column if not exists target_version  text;
alter table public.wheelchairs add column if not exists ota_status      text default 'idle';
alter table public.wheelchairs add column if not exists ota_progress    int default 0;
alter table public.wheelchairs add column if not exists ota_last_error  text;

alter table public.device_state add column if not exists fw_version      text;
alter table public.device_state add column if not exists target_version  text;
alter table public.device_state add column if not exists ota_status      text default 'idle';
alter table public.device_state add column if not exists ota_progress    int default 0;
alter table public.device_state add column if not exists ota_last_error  text;


create table if not exists public.firmware_releases (
  id          bigserial primary key,
  version     text not null unique,
  url         text not null,
  size        bigint not null,
  notes       text,
  created_at  timestamptz default now()
);

grant select, insert, update, delete on public.firmware_releases to anon, authenticated, service_role;

-- Ensure storage bucket for firmware exists
insert into storage.buckets (id, name, public)
values ('firmware', 'firmware', true)
on conflict (id) do nothing;

-- Create policies to allow public uploads and downloads to the firmware storage bucket in dev mode
create policy "Allow public uploads to firmware bucket"
on storage.objects for insert with check (bucket_id = 'firmware');

create policy "Allow public reads from firmware bucket"
on storage.objects for select using (bucket_id = 'firmware');
