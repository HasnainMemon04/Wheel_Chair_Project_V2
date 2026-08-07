-- A capability flag must describe the firmware that is RUNNING, not the newest
-- firmware that ever ran.
--
-- The RPC merges each packet over the existing row, so any key the payload omits
-- carries its old value forward. That is right for a sensor reading that only
-- arrives on full packets; it is wrong for has_emg_unlock. WCHAIR-004 installed
-- 1.2.8, reported has_emg_unlock=true, then rolled back to 1.2.7 - which has no
-- wheel-unlock code at all. The flag stayed true, so the console kept offering a
-- release button that the running firmware could only answer with "failed".
--
-- Fix: a FULL packet carries the complete field set, so has_emg_unlock missing
-- from a full packet is positive evidence that this firmware does not support
-- it. Partial packets are left alone - they omit plenty of fields by design.

create or replace function public.emg_capability_patch(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select
    case
      -- Firmware that reports the capability at all: take both booleans from
      -- the payload, each only when actually present. (Both must be mapped
      -- here; an earlier revision built only has_emg_unlock, which left the
      -- live "wheels are free" state stuck on its carried-forward value.)
      when p_payload ? 'has_emg_unlock' then
        jsonb_build_object(
          'has_emg_unlock', coalesce((p_payload ->> 'has_emg_unlock')::integer, 0) = 1
        )
        || case
             when p_payload ? 'emg_unlock' then jsonb_build_object(
               'emg_unlock', coalesce((p_payload ->> 'emg_unlock')::integer, 0) = 1
             )
             else '{}'::jsonb
           end
      -- Silent on a FULL packet => firmware without the feature, or rolled back
      -- to firmware that has no wheel-unlock code. Clear the live state too:
      -- firmware that cannot report the brake cannot be trusted to be holding
      -- it released either.
      when coalesce(nullif(p_payload ->> 'packet_type', ''), 'legacy') in ('full', 'legacy')
        then jsonb_build_object(
          'has_emg_unlock', false,
          'emg_unlock', false,
          'emg_unlock_s', 0
        )
      -- Partial packet: keep whatever the last full packet asserted.
      else '{}'::jsonb
    end;
$$;

revoke all on function public.emg_capability_patch(jsonb) from public;
grant execute on function public.emg_capability_patch(jsonb) to service_role;

comment on function public.emg_capability_patch(jsonb) is
  'Derives has_emg_unlock/emg_unlock from a telemetry payload so a firmware rollback clears the capability instead of leaving it asserted forever.';

-- Wire it into the ingest RPC, replacing the two standalone blocks. Anchored
-- patch that RAISES if the anchor is missing, rather than silently doing nothing
-- and reporting success.
do $$
declare
  src text;
  patched text;
  anchor text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'ingest_telemetry_tx';

  if src is null then
    raise exception 'ingest_telemetry_tx not found';
  end if;

  if position('emg_capability_patch' in src) > 0 then
    raise notice 'already using emg_capability_patch; nothing to do';
    return;
  end if;

  anchor := E'  if p_payload ? ''has_emg_unlock'' then\n'
         || E'    v_patch := v_patch || jsonb_build_object(\n'
         || E'      ''has_emg_unlock'', coalesce((p_payload ->> ''has_emg_unlock'')::integer, 0) = 1\n'
         || E'    );\n'
         || E'  end if;\n'
         || E'  if p_payload ? ''emg_unlock'' then\n'
         || E'    v_patch := v_patch || jsonb_build_object(\n'
         || E'      ''emg_unlock'', coalesce((p_payload ->> ''emg_unlock'')::integer, 0) = 1\n'
         || E'    );\n'
         || E'  end if;\n';

  if position(anchor in src) = 0 then
    raise exception 'anchor not found - refusing to guess; ingest_telemetry_tx was edited';
  end if;

  patched := replace(
    src,
    anchor,
    E'  v_patch := v_patch || public.emg_capability_patch(p_payload);\n'
  );

  execute patched;
  raise notice 'ingest_telemetry_tx now derives the emergency-unlock capability';
end $$;
