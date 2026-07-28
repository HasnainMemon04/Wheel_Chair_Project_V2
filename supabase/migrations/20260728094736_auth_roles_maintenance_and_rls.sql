-- ===========================================================================
-- 1. Maintenance mode (operator-only), on the fleet record rather than the
--    device shadow: it is an operator decision, not a telemetry reading.
-- ===========================================================================
alter table public.wheelchairs add column if not exists out_of_service boolean not null default false;
alter table public.wheelchairs add column if not exists service_note   text;
alter table public.wheelchairs add column if not exists service_since  timestamptz;

-- Riders must see the change the instant an operator flips it.
do $$
begin
  alter publication supabase_realtime add table public.wheelchairs;
exception when duplicate_object then null;
end $$;

-- ===========================================================================
-- 2. Profiles are created automatically for every new auth user. Role comes
--    from signup metadata but defaults to 'rider' — a client can never make
--    itself an operator by passing a flag, because the check constraint plus
--    the explicit whitelist below are the only ways in.
-- ===========================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    'rider'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- 3. Role helper. SECURITY DEFINER so policies can consult profiles without
--    recursing through the profiles policies themselves.
-- ===========================================================================
create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'operator'
  );
$$;

grant execute on function public.is_operator() to anon, authenticated;;
