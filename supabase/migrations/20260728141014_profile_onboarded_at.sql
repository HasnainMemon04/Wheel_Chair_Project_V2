-- Whether this rider has been through the intro is a fact about the ACCOUNT,
-- not about the browser that happened to show it. Kept in localStorage it
-- reappeared on every new device, in a private window, and after clearing site
-- data — for the same person who had already seen it.
alter table public.profiles add column if not exists onboarded_at timestamptz;

-- Operators never see the rider intro, so backfill them as already done.
update public.profiles set onboarded_at = now()
where role = 'operator' and onboarded_at is null;;
