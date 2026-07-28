-- Account deletion (rider self-service, Uber-style) removes auth.users →
-- cascades to profiles. Rentals are billing/audit records and must outlive
-- the account — anonymised, not destroyed. Without this the FK (RESTRICT by
-- default) would block deletion for any rider who ever took a ride.
alter table public.rentals drop constraint rentals_user_id_fkey;
alter table public.rentals add constraint rentals_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete set null;;
