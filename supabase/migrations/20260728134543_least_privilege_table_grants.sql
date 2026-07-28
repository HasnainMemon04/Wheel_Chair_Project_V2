-- ===========================================================================
-- Table grants sit UNDER row-level security: RLS can only narrow what a grant
-- already allows. Every table here carried blanket DELETE/INSERT/UPDATE/
-- TRUNCATE for both anon and authenticated, so a single dropped policy would
-- have exposed writes with nothing behind it. Grants are now the same shape as
-- the policies.
-- ===========================================================================

-- anon is a pre-login browser. It needs nothing at all: sign-in comes first.
revoke all on public.profiles,        public.device_state, public.wheelchairs,
              public.geofences,       public.commands,     public.events,
              public.rentals,         public.telemetry_history,
              public.firmware_releases, public.payments
  from anon;

revoke all on public.profiles,        public.device_state, public.wheelchairs,
              public.geofences,       public.commands,     public.events,
              public.rentals,         public.telemetry_history,
              public.firmware_releases, public.payments
  from authenticated;

-- Read-only for a rider; RLS narrows the rows.
grant select                   on public.device_state       to authenticated;
grant select                   on public.rentals            to authenticated;
grant select                   on public.telemetry_history  to authenticated;

-- Rider edits their own profile row (policy: id = auth.uid()). No INSERT —
-- the signup trigger owns creation. No DELETE — the auth cascade owns removal.
grant select, update           on public.profiles           to authenticated;

-- Operators flip maintenance mode (policy: is_operator()).
grant select, update           on public.wheelchairs        to authenticated;

-- Operators manage zones; riders read them.
grant select, insert, update, delete on public.geofences    to authenticated;

-- Riders queue fail-safe commands on their own ride; operators any command.
-- UPDATE stays operator-only via policy, and is needed for the console.
grant select, insert, update   on public.commands           to authenticated;

-- Audit log is read-only from the browser; the console may retire queued OTA
-- requests (policy restricts to operators and type='OTA_REQUESTED').
grant select, delete           on public.events             to authenticated;

-- Firmware releases: read for all signed-in, writes gated to operators.
grant select, insert, delete   on public.firmware_releases  to authenticated;

-- public.payments keeps no grants and no policies: service role only.;
