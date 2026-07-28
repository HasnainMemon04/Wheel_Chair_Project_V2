-- ===========================================================================
-- Full account record. Everything a rider owns about themselves lives in one
-- RLS-protected row, so it follows the account across devices instead of
-- sitting in that browser's localStorage.
-- ===========================================================================
alter table public.profiles add column if not exists avatar_url        text;
alter table public.profiles add column if not exists locale            text    not null default 'en';
alter table public.profiles add column if not exists marketing_opt_in  boolean not null default false;
alter table public.profiles add column if not exists ride_receipts     boolean not null default true;
alter table public.profiles add column if not exists updated_at        timestamptz not null default now();

alter table public.profiles drop constraint if exists profiles_locale_check;
alter table public.profiles add constraint profiles_locale_check check (locale in ('en','ar'));

create or replace function public.touch_profile_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_profile_updated_at();

-- Carry Google's picture through on OAuth signup so the avatar is populated
-- without the rider having to upload one.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, name, role, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    'rider',
    coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      new.raw_user_meta_data ->> 'picture'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ===========================================================================
-- Avatar storage. Public-read (avatars are shown on the operator console and
-- in-app), but each rider may only write inside a folder named after their own
-- user id — enforced by storage RLS, not by trusting the client's path.
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152,
        array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif'];

drop policy if exists "avatars are publicly readable"  on storage.objects;
drop policy if exists "riders upload own avatar"       on storage.objects;
drop policy if exists "riders replace own avatar"      on storage.objects;
drop policy if exists "riders delete own avatar"       on storage.objects;

create policy "avatars are publicly readable" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "riders upload own avatar" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "riders replace own avatar" on storage.objects
  for update to authenticated
  using      (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "riders delete own avatar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);;
