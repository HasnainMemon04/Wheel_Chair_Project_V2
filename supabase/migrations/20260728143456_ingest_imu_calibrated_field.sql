do $$
declare
  src text;
  patched text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'ingest_telemetry_tx';

  if src is null then
    raise exception 'ingest_telemetry_tx not found';
  end if;
  if position('imu_calibrated' in src) > 0 then
    return;
  end if;

  patched := replace(
    src,
    E'        (''imu_age_ms'', ''imu_age_ms''),\n',
    E'        (''imu_age_ms'', ''imu_age_ms''),\n        (''imu_calibrated'', ''imu_calibrated''),\n'
  );
  patched := replace(
    patched,
    E'    imu_age_ms = excluded.imu_age_ms,',
    E'    imu_age_ms = excluded.imu_age_ms,\n    imu_calibrated = excluded.imu_calibrated,'
  );

  if patched = src then
    raise exception 'patch anchors not found';
  end if;

  execute patched;
end $$;;
