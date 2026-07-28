-- Seconds remaining on an operator maintenance override (0 = none). Lets the
-- console show that a chair is running in degraded mode, and for how long.
alter table public.device_state add column if not exists maint_override_s int default 0;

-- Patch ingest_telemetry_tx textually rather than restating 200 lines: add the
-- field to the payload->column map and to the upsert's conflict list.
do $$
declare
  src text;
begin
  select pg_get_functiondef(oid) into src
    from pg_proc
   where proname = 'ingest_telemetry_tx'
     and pronamespace = 'public'::regnamespace
   limit 1;

  if src is null then
    raise exception 'ingest_telemetry_tx not found';
  end if;

  if position('maint_override_s' in src) > 0 then
    raise notice 'already patched';
    return;
  end if;

  src := replace(
    src,
    '(''tamper_count'', ''tamper_count''),',
    '(''tamper_count'', ''tamper_count''),' || chr(10) ||
    '        (''maint_override_s'', ''maint_override_s''),'
  );

  src := replace(
    src,
    'tamper_count = excluded.tamper_count,',
    'tamper_count = excluded.tamper_count,' || chr(10) ||
    '    maint_override_s = excluded.maint_override_s,'
  );

  execute src;
end $$;;
