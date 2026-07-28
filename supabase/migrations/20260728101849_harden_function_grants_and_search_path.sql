-- ===========================================================================
-- 1. activate_rental_tx marks a rental PAID and releases the chair. It is
--    SECURITY DEFINER, so a direct call bypasses RLS entirely — and it was
--    executable by `anon`, i.e. by anyone holding the public key that ships in
--    the browser bundle. Both webapps only ever call it from their server-side
--    payment webhook on the service role, so no client needs this grant.
-- ===========================================================================
revoke execute on function public.activate_rental_tx(uuid, integer, text, text, text) from public, anon, authenticated;

-- Trigger functions are invoked by the trigger, never over the REST surface.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.guard_profile_role() from public, anon, authenticated;
do $$
begin
  revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
exception when undefined_function then null;
end $$;
do $$
begin
  revoke execute on function public.capture_last_gps_fix() from public, anon, authenticated;
exception when undefined_function then null;
end $$;

-- is_operator() is only meaningful for a signed-in caller.
revoke execute on function public.is_operator() from anon;

-- ===========================================================================
-- 2. Pin search_path on the remaining SECURITY DEFINER / cron functions so a
--    caller cannot shadow a referenced object with one of their own.
-- ===========================================================================
alter function public.activate_rental_tx(uuid, integer, text, text, text) set search_path = public, pg_temp;
alter function public.server_now() set search_path = public, pg_temp;
do $$
begin
  alter function public.check_rental_sessions() set search_path = public, pg_temp;
exception when undefined_function then null;
end $$;
do $$
begin
  alter function public.mark_stale_devices_offline() set search_path = public, pg_temp;
exception when undefined_function then null;
end $$;
do $$
begin
  alter function public.capture_last_gps_fix() set search_path = public, pg_temp;
exception when undefined_function then null;
end $$;

-- ===========================================================================
-- 3. Neither webapp writes events from the browser — the Edge Functions and
--    database triggers do, on the service role. An unrestricted client INSERT
--    was therefore pure attack surface: it let any signed-in user forge
--    entries in the safety audit log.
-- ===========================================================================
drop policy if exists "signed-in clients write audit events" on public.events;;
