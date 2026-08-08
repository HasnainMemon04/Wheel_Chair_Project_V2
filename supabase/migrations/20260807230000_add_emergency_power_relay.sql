-- Emergency power cut: a THIRD relay that cuts the chair's MAIN power.
-- Distinct from `power`, which is the logical power_state driving the motion
-- lock, and from `emg_unlock`, which frees the wheels for pushing.
--
-- Unlike the brake release this one LATCHES and is persisted on the device, so
-- the console may be displaying it for a long time and must never imply the
-- chair is merely idle.

alter table public.device_state
  add column if not exists has_pwr_relay boolean,   -- power relay fitted
  add column if not exists pwr_cut       boolean;   -- main power held cut

comment on column public.device_state.has_pwr_relay is
  'Device-reported: an emergency main-power relay is fitted (WCHAIR-004 only at present).';
comment on column public.device_state.pwr_cut is
  'Device-reported: main power is being held cut by an operator. Latching and persisted on the device — only an explicit restore turns it back on.';

-- Same rule as the wheel-unlock capability: absence in a FULL packet is
-- positive evidence the running firmware has no power relay, so a rollback
-- clears it instead of leaving the console offering a control that cannot work.
create or replace function public.pwr_capability_patch(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select
    case
      when p_payload ? 'has_pwr_relay' then
        jsonb_build_object(
          'has_pwr_relay', coalesce((p_payload ->> 'has_pwr_relay')::integer, 0) = 1
        )
        || case
             when p_payload ? 'pwr_cut' then jsonb_build_object(
               'pwr_cut', coalesce((p_payload ->> 'pwr_cut')::integer, 0) = 1
             )
             else '{}'::jsonb
           end
      when coalesce(nullif(p_payload ->> 'packet_type', ''), 'legacy') in ('full', 'legacy')
        then jsonb_build_object('has_pwr_relay', false, 'pwr_cut', false)
      else '{}'::jsonb
    end;
$$;

revoke all on function public.pwr_capability_patch(jsonb) from public;
grant execute on function public.pwr_capability_patch(jsonb) to service_role;

-- Wire it into the ingest RPC, and add the two columns to the ON CONFLICT list.
-- Both anchors are verified; a missing anchor RAISES rather than silently
-- succeeding while the field never lands.
do $$
declare
  src text;
  patched text;
  a_call text;
  a_conflict text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'ingest_telemetry_tx';

  if src is null then
    raise exception 'ingest_telemetry_tx not found';
  end if;

  if position('pwr_capability_patch' in src) > 0 then
    raise notice 'already wired; nothing to do';
    return;
  end if;

  a_call := E'  v_patch := v_patch || public.emg_capability_patch(p_payload);\n';
  a_conflict := E'    emg_unlock_s = excluded.emg_unlock_s,\n';

  if position(a_call in src) = 0 then
    raise exception 'capability-patch call anchor not found';
  end if;
  if position(a_conflict in src) = 0 then
    raise exception 'on-conflict anchor not found';
  end if;

  patched := replace(
    src, a_call,
    a_call || E'  v_patch := v_patch || public.pwr_capability_patch(p_payload);\n'
  );
  patched := replace(
    patched, a_conflict,
    a_conflict || E'    has_pwr_relay = excluded.has_pwr_relay,\n    pwr_cut = excluded.pwr_cut,\n'
  );

  execute patched;
  raise notice 'ingest_telemetry_tx now maps the emergency power relay';
end $$;
