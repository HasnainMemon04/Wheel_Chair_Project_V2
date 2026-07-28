-- 1. Fix "permission denied for sequence events_id_seq": browser clients had
--    table INSERT but no sequence USAGE, and no RLS insert policy behind it.
--    TODO(prod): restrict to authenticated operator role.
grant usage, select on sequence public.events_id_seq to anon, authenticated;
drop policy if exists "web clients can insert audit events" on public.events;
create policy "web clients can insert audit events" on public.events for insert with check (true);

-- 2. Rental session supervisor (was in cloud/schema.sql but never applied —
--    pg_cron was not enabled). Set-based; device-authoritative session end.
create extension if not exists pg_cron;

create or replace function public.check_rental_sessions()
returns void as $$
begin
  -- Expired active/expiring rentals -> 'ending' + queue END_SESSION.
  with expired as (
    update rentals r
    set state = 'ending'
    where r.state in ('active', 'expiring') and r.end_at <= now()
    returning r.id, r.wheelchair_id
  ),
  cmds as (
    insert into commands (wheelchair_id, cmd, req_id, status, args)
    select e.wheelchair_id, 'END_SESSION', 'end-' || e.id::text, 'pending', '{}'::jsonb
    from expired e
    where not exists (select 1 from commands c where c.req_id = 'end-' || e.id::text)
    returning 1
  )
  insert into events (wheelchair_id, type, detail, lat, lng)
  select e.wheelchair_id, 'SESSION_LOCKED', jsonb_build_object('rental_id', e.id), ds.lat, ds.lng
  from expired e
  left join device_state ds on ds.wheelchair_id = e.wheelchair_id;

  -- Grace fallback: no END_SESSION ack within 2 minutes (device offline).
  with overdue as (
    update rentals r
    set state = 'ended'
    where r.state = 'ending'
      and r.end_at <= now() - interval '2 minutes'
      and not exists (
        select 1 from commands c
        where c.req_id = 'end-' || r.id::text and c.status = 'acked'
      )
    returning r.id, r.wheelchair_id
  )
  insert into events (wheelchair_id, type, detail, lat, lng)
  select o.wheelchair_id, 'SESSION_END_OFFLINE',
         jsonb_build_object('rental_id', o.id,
                            'reason', 'device did not ack END_SESSION within grace period'),
         ds.lat, ds.lng
  from overdue o
  left join device_state ds on ds.wheelchair_id = o.wheelchair_id;

  -- Warning window (<= 120s left) -> 'expiring' + WARN_EXPIRY.
  with warned as (
    update rentals r
    set state = 'expiring'
    where r.state = 'active' and r.end_at <= now() + interval '120 seconds' and r.end_at > now()
    returning r.id, r.wheelchair_id, greatest(0, extract(epoch from (r.end_at - now()))::int) as tl
  ),
  wcmds as (
    insert into commands (wheelchair_id, cmd, req_id, status, args)
    select w.wheelchair_id, 'WARN_EXPIRY', 'warn-' || w.id::text, 'pending',
           jsonb_build_object('time_left', w.tl)
    from warned w
    where not exists (select 1 from commands c where c.req_id = 'warn-' || w.id::text)
    returning 1
  )
  insert into events (wheelchair_id, type, detail, lat, lng)
  select w.wheelchair_id, 'EXPIRY_WARNING', jsonb_build_object('time_left', w.tl), ds.lat, ds.lng
  from warned w
  left join device_state ds on ds.wheelchair_id = w.wheelchair_id;

  -- Reconciler: an 'active' rental with NO UNLOCK dispatched since it was
  -- created means a partial webhook failure — repair it.
  insert into commands (wheelchair_id, cmd, args, status, req_id)
  select r.wheelchair_id, 'UNLOCK',
         jsonb_build_object('duration_s', r.duration_s), 'pending',
         'unlock-' || r.id::text
  from rentals r
  where r.state = 'active'
    and r.end_at > now()
    and not exists (
      select 1 from commands c
      where c.wheelchair_id = r.wheelchair_id
        and c.cmd = 'UNLOCK'
        and c.created_at >= r.created_at
    );
end;
$$ language plpgsql;

create index if not exists idx_rentals_state_end on rentals (state, end_at);

select cron.schedule('check-sessions', '* * * * *', 'select public.check_rental_sessions()');;
