-- Freshness (online/offline) compares a SERVER-written device_state.ts against
-- the browser's clock. Any skew between the two — a PC running a couple of
-- minutes behind is common — made fresh telemetry look stale (or vice-versa).
-- Clients call this to measure their offset and correct for it.
create or replace function public.server_now()
returns timestamptz
language sql
stable
as $$ select now() $$;

grant execute on function public.server_now() to anon, authenticated;;
