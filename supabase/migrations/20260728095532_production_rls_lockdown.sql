-- ===========================================================================
-- Production RLS. Everything below assumes:
--   * the ESP32 ingest path runs through Edge Functions on the SERVICE ROLE,
--     which bypasses RLS entirely and is therefore unaffected;
--   * the /api/* route handlers also run on the service role;
--   * the browser holds only the anon key plus a signed-in user's JWT.
-- The anon role loses read access to the fleet: sign-in is now required.
-- ===========================================================================

-- Ownership helper: does the caller hold a live rental on this chair?
create or replace function public.owns_live_rental(chair text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.rentals r
    where r.wheelchair_id = chair
      and r.user_id = auth.uid()
      and r.state in ('reserved','active','expiring','ending')
  );
$$;
grant execute on function public.owns_live_rental(text) to authenticated;

-- ---------------------------------------------------------------- profiles
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;

create policy "read own profile" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_operator());

create policy "update own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- A rider must never be able to promote itself by writing profiles.role.
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role is distinct from old.role
     and auth.role() is distinct from 'service_role'
     and not public.is_operator() then
    raise exception 'role changes are not permitted';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ------------------------------------------------------------ device_state
drop policy if exists "read device_state" on public.device_state;
create policy "signed-in clients read fleet telemetry" on public.device_state
  for select to authenticated using (true);

-- ------------------------------------------------------------- wheelchairs
drop policy if exists "read available chairs" on public.wheelchairs;
create policy "signed-in clients read chairs" on public.wheelchairs
  for select to authenticated using (true);

-- Maintenance mode is an operator decision, so only operators may write it.
create policy "operators manage chairs" on public.wheelchairs
  for update to authenticated
  using (public.is_operator()) with check (public.is_operator());

-- --------------------------------------------------------------- geofences
drop policy if exists "anyone can read geofences" on public.geofences;
drop policy if exists "anyone can write geofences" on public.geofences;

create policy "signed-in clients read zones" on public.geofences
  for select to authenticated using (true);
create policy "operators write zones" on public.geofences
  for insert to authenticated with check (public.is_operator());
create policy "operators update zones" on public.geofences
  for update to authenticated
  using (public.is_operator()) with check (public.is_operator());
create policy "operators delete zones" on public.geofences
  for delete to authenticated using (public.is_operator());

-- ---------------------------------------------------------------- commands
drop policy if exists "anyone can insert commands" on public.commands;
drop policy if exists "anyone can read commands" on public.commands;
drop policy if exists "anyone can update commands" on public.commands;
drop policy if exists "Authenticated operators can insert commands" on public.commands;
drop policy if exists "Authenticated operators can read all commands" on public.commands;

create policy "signed-in clients read commands" on public.commands
  for select to authenticated using (true);

-- The security boundary that matters: a rider can issue only fail-safe
-- commands, and only on a chair they are actually renting. UNLOCK is absent
-- on purpose — it is reachable solely from the paid webhook (service role)
-- or from an operator.
create policy "riders issue safe commands on their own ride" on public.commands
  for insert to authenticated
  with check (
    public.is_operator()
    or cmd = 'PING'
    or (cmd in ('LOCK','END_SESSION','CLEAR_SOS') and public.owns_live_rental(wheelchair_id))
  );

create policy "operators update commands" on public.commands
  for update to authenticated
  using (public.is_operator()) with check (public.is_operator());

-- ------------------------------------------------------------------ events
drop policy if exists "anyone_can_read_events" on public.events;
drop policy if exists "web clients can insert audit events" on public.events;
drop policy if exists "remove queued ota requests" on public.events;

create policy "signed-in clients read events" on public.events
  for select to authenticated using (true);
create policy "signed-in clients write audit events" on public.events
  for insert to authenticated with check (true);
create policy "operators remove queued ota requests" on public.events
  for delete to authenticated
  using (public.is_operator() and type = 'OTA_REQUESTED');

-- ------------------------------------------------------- firmware_releases
drop policy if exists "anon_read_releases" on public.firmware_releases;
drop policy if exists "anon_insert_releases" on public.firmware_releases;
drop policy if exists "anon_delete_releases" on public.firmware_releases;

create policy "signed-in clients read releases" on public.firmware_releases
  for select to authenticated using (true);
create policy "operators publish releases" on public.firmware_releases
  for insert to authenticated with check (public.is_operator());
create policy "operators retire releases" on public.firmware_releases
  for delete to authenticated using (public.is_operator());

-- ----------------------------------------------------------------- rentals
drop policy if exists "anyone can read rentals" on public.rentals;
drop policy if exists "Authenticated users can read their own rentals" on public.rentals;
-- ("rider reads own rentals" and "operator reads fleet" are already correct.)

-- ------------------------------------------------------- telemetry_history
drop policy if exists "signed-in clients read history" on public.telemetry_history;
create policy "signed-in clients read history" on public.telemetry_history
  for select to authenticated using (true);

-- payments intentionally keeps zero policies: service role only.;
