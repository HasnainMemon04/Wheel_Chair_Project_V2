-- Lets the signup route tell a rider "you already have an account" instead of
-- the stock endpoint's decoy 200 + silent confirmation resend, which is what
-- rate-limited people out of accounts they already owned.
--
-- Service role only. Exposing this to anon/authenticated would hand out an
-- email-enumeration oracle; the route that calls it is itself IP-throttled.
create or replace function public.email_is_registered(p_email text)
returns boolean
language sql
stable
security definer
set search_path = auth, pg_temp
as $$
  select exists (select 1 from auth.users where lower(email) = lower(p_email));
$$;

revoke execute on function public.email_is_registered(text) from public, anon, authenticated;
grant  execute on function public.email_is_registered(text) to service_role;;
