-- These are consulted by RLS policies, which execute as the invoking role, so
-- `authenticated` must keep EXECUTE. PUBLIC (and therefore anon) does not.
revoke execute on function public.is_operator() from public;
revoke execute on function public.owns_live_rental(text) from public;
grant execute on function public.is_operator() to authenticated;
grant execute on function public.owns_live_rental(text) to authenticated;;
