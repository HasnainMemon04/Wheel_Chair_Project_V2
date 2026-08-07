-- Map the emergency wheel-unlock telemetry fields through the ingest RPC.
--
-- Recorded as the FULL function body rather than the string-patch style used by
-- earlier ingest migrations: a patch that no longer finds its anchor silently
-- does nothing, which is how a field ends up missing in production while the
-- migration still reports success. This replays identically on any database.
--
--   emg_unlock_s    integer, copied straight through
--   has_emg_unlock  0/1 -> boolean (the chair describing its own hardware)
--   emg_unlock      0/1 -> boolean (brake released right now)

CREATE OR REPLACE FUNCTION public.ingest_telemetry_tx(p_device_id text, p_ts timestamp with time zone, p_payload jsonb, p_auth_ms integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_received_at timestamptz := clock_timestamp();
  v_current public.device_state%rowtype;
  v_next public.device_state%rowtype;
  v_target_version text;
  v_packet_type text := coalesce(nullif(p_payload ->> 'packet_type', ''), 'legacy');
  v_up integer;
  v_last_hist_up integer;
  v_next_hist_up integer;
  v_persist_history boolean := false;
  v_patch jsonb := '{}'::jsonb;
  v_field_patch jsonb;
  v_commands jsonb := '[]'::jsonb;
  v_db_ms integer;
begin
  if p_device_id is null or p_device_id = '' then
    raise exception 'device id is required';
  end if;

  select target_version
    into v_target_version
    from public.wheelchairs
   where id = p_device_id;

  if not found then
    raise exception 'device is not registered';
  end if;

  select *
    into v_current
    from public.device_state
   where wheelchair_id = p_device_id
   for update;

  v_last_hist_up := v_current.hist_up;
  v_up := case
    when jsonb_typeof(p_payload -> 'up') = 'number'
      then (p_payload ->> 'up')::integer
    else null
  end;

  v_persist_history :=
    v_packet_type in ('full', 'legacy')
    and v_up is not null
    and (
      v_last_hist_up is null
      or v_up < v_last_hist_up
      or v_up - v_last_hist_up >= 10
    );
  v_next_hist_up := case when v_persist_history then v_up else v_last_hist_up end;

  if v_packet_type in ('full', 'legacy') and p_payload ? 'fw' then
    update public.wheelchairs
       set fw_version = p_payload ->> 'fw',
           ota_status = coalesce(p_payload ->> 'ota_status', ota_status, 'idle'),
           ota_progress = coalesce((p_payload ->> 'ota_progress')::integer, ota_progress, 0),
           ota_last_error = case
             when p_payload ? 'ota_last_error' then p_payload ->> 'ota_last_error'
             else ota_last_error
           end
     where id = p_device_id
       and (
         fw_version is distinct from p_payload ->> 'fw'
         or (
           p_payload ? 'ota_status'
           and ota_status is distinct from p_payload ->> 'ota_status'
         )
         or (
           p_payload ? 'ota_progress'
           and ota_progress is distinct from (p_payload ->> 'ota_progress')::integer
         )
         or (
           p_payload ? 'ota_last_error'
           and ota_last_error is distinct from p_payload ->> 'ota_last_error'
         )
       );
  end if;

  if v_persist_history then
    insert into public.telemetry_history (wheelchair_id, ts, data)
    values (p_device_id, p_ts, p_payload);
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'cmd', cmd,
        'req_id', req_id,
        'args', args
      )
      order by created_at
    ),
    '[]'::jsonb
  )
    into v_commands
    from public.commands
   where wheelchair_id = p_device_id
     and status = 'pending';

  select coalesce(jsonb_object_agg(target_key, p_payload -> source_key), '{}'::jsonb)
    into v_field_patch
    from (
      values
        ('lat', 'lat'),
        ('lng', 'lng'),
        ('spd', 'speed'),
        ('sats', 'sats'),
        ('hdop', 'hdop'),
        ('gps_course', 'gps_course'),
        ('gps_altitude', 'gps_altitude'),
        ('gps_age_ms', 'gps_age_ms'),
        ('gps_chars', 'gps_chars'),
        ('gps_sentences', 'gps_sentences'),
        ('gps_checksum_failures', 'gps_checksum_failures'),
        ('gps_nmea_gga', 'gps_nmea_gga'),
        ('gps_nmea_rmc', 'gps_nmea_rmc'),
        ('pitch', 'pitch'),
        ('roll', 'roll'),
        ('tilt', 'tilt'),
        ('yaw', 'yaw'),
        ('imu_accel_x', 'imu_accel_x'),
        ('imu_accel_y', 'imu_accel_y'),
        ('imu_accel_z', 'imu_accel_z'),
        ('imu_gyro_x', 'imu_gyro_x'),
        ('imu_gyro_y', 'imu_gyro_y'),
        ('imu_gyro_z', 'imu_gyro_z'),
        ('imu_age_ms', 'imu_age_ms'),
        ('imu_calibrated', 'imu_calibrated'),
        ('temp_motor', 'temp_motor'),
        ('temp_batt', 'temp_batt'),
        ('temp_amb', 'temp_amb'),
        ('humidity', 'humidity'),
        ('batt_v', 'batt_v'),
        ('batt_pct', 'batt_pct'),
        ('batt_valid', 'batt_valid'),
        ('tamper_count', 'tamper_count'),
        ('alarm_silenced', 'alarm_silenced'),
        ('maint_override_s', 'maint_override_s'),
        -- Emergency wheel unlock: seconds remaining on the brake release.
        ('emg_unlock_s', 'emg_unlock_s'),
        ('up', 'uptime'),
        ('rssi', 'rssi'),
        ('session_state', 'session_state'),
        ('time_left', 'time_left'),
        ('speed_limit', 'speed_limit'),
        ('gf', 'geofence'),
        ('fw', 'fw_version'),
        ('ota_status', 'ota_status'),
        ('ota_progress', 'ota_progress'),
        ('ota_last_error', 'ota_last_error'),
        ('seq', 'packet_seq'),
        ('packet_type', 'packet_type'),
        ('captured_at_ms', 'captured_at_ms'),
        ('queue_ms', 'device_queue_ms'),
        ('serialize_ms', 'device_serialize_ms'),
        ('prev_hmac_ms', 'device_hmac_ms'),
        ('prev_http_ms', 'device_http_ms'),
        ('payload_bytes', 'payload_bytes')
    ) as field_map(source_key, target_key)
   where p_payload ? source_key;

  v_patch := v_field_patch || jsonb_build_object(
    'wheelchair_id', p_device_id,
    'ts', p_ts,
    'online', true,
    'hist_up', v_next_hist_up,
    'target_version', v_target_version,
    'packet_type', v_packet_type,
    'server_received_at', v_received_at,
    'server_auth_ms', p_auth_ms
  );

  if p_payload ? 'gps_fix' then
    v_patch := v_patch || jsonb_build_object(
      'gps_fix', coalesce((p_payload ->> 'gps_fix')::integer, 0) = 1
    );
  end if;
  if p_payload ? 'gps_simulated' then
    v_patch := v_patch || jsonb_build_object(
      'gps_simulated', coalesce((p_payload ->> 'gps_simulated')::integer, 0) = 1
    );
  end if;
  if p_payload ? 'in_motion' then
    v_patch := v_patch || jsonb_build_object(
      'in_motion', coalesce((p_payload ->> 'in_motion')::integer, 0) = 1
    );
  end if;
  if p_payload ? 'tamper' then
    v_patch := v_patch || jsonb_build_object(
      'tamper', coalesce((p_payload ->> 'tamper')::integer, 0) = 1
    );
  end if;
  if p_payload ? 'power' then
    v_patch := v_patch || jsonb_build_object(
      'power', coalesce((p_payload ->> 'power')::integer, 0) = 1
    );
  end if;
  if p_payload ? 'locked' then
    v_patch := v_patch || jsonb_build_object(
      'locked', coalesce((p_payload ->> 'locked')::integer, 0) = 1
    );
  end if;
  if p_payload ? 'over_speed' then
    v_patch := v_patch || jsonb_build_object(
      'over_speed', coalesce((p_payload ->> 'over_speed')::integer, 0) = 1
    );
  end if;
  -- Emergency wheel unlock, sent as 0/1 like every other device boolean.
  -- has_emg_unlock is the chair describing its own hardware, so the console
  -- never has to hardcode which chair has the relay.
  if p_payload ? 'has_emg_unlock' then
    v_patch := v_patch || jsonb_build_object(
      'has_emg_unlock', coalesce((p_payload ->> 'has_emg_unlock')::integer, 0) = 1
    );
  end if;
  if p_payload ? 'emg_unlock' then
    v_patch := v_patch || jsonb_build_object(
      'emg_unlock', coalesce((p_payload ->> 'emg_unlock')::integer, 0) = 1
    );
  end if;

  v_db_ms := greatest(
    0,
    floor(extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::integer
  );
  v_patch := v_patch || jsonb_build_object('server_db_ms', v_db_ms);

  select *
    into v_next
    from jsonb_populate_record(
      null::public.device_state,
      coalesce(to_jsonb(v_current), '{}'::jsonb) || v_patch
    );

  insert into public.device_state
  select (v_next).*
  on conflict (wheelchair_id) do update set
    ts = excluded.ts,
    online = excluded.online,
    lat = excluded.lat,
    lng = excluded.lng,
    speed = excluded.speed,
    sats = excluded.sats,
    hdop = excluded.hdop,
    pitch = excluded.pitch,
    roll = excluded.roll,
    tilt = excluded.tilt,
    temp_motor = excluded.temp_motor,
    temp_batt = excluded.temp_batt,
    temp_amb = excluded.temp_amb,
    humidity = excluded.humidity,
    batt_v = excluded.batt_v,
    batt_pct = excluded.batt_pct,
    batt_valid = excluded.batt_valid,
    occupied = excluded.occupied,
    rssi = excluded.rssi,
    power = excluded.power,
    locked = excluded.locked,
    session_state = excluded.session_state,
    time_left = excluded.time_left,
    speed_limit = excluded.speed_limit,
    over_speed = excluded.over_speed,
    geofence = excluded.geofence,
    tamper = excluded.tamper,
    tamper_count = excluded.tamper_count,
    alarm_silenced = excluded.alarm_silenced,
    maint_override_s = excluded.maint_override_s,
    has_emg_unlock = excluded.has_emg_unlock,
    emg_unlock = excluded.emg_unlock,
    emg_unlock_s = excluded.emg_unlock_s,
    uptime = excluded.uptime,
    hist_up = excluded.hist_up,
    fw_version = excluded.fw_version,
    target_version = excluded.target_version,
    ota_status = excluded.ota_status,
    ota_progress = excluded.ota_progress,
    ota_last_error = excluded.ota_last_error,
    in_motion = excluded.in_motion,
    yaw = excluded.yaw,
    gps_fix = excluded.gps_fix,
    gps_course = excluded.gps_course,
    gps_altitude = excluded.gps_altitude,
    gps_age_ms = excluded.gps_age_ms,
    gps_chars = excluded.gps_chars,
    gps_sentences = excluded.gps_sentences,
    gps_checksum_failures = excluded.gps_checksum_failures,
    gps_nmea_gga = excluded.gps_nmea_gga,
    gps_nmea_rmc = excluded.gps_nmea_rmc,
    imu_accel_x = excluded.imu_accel_x,
    imu_accel_y = excluded.imu_accel_y,
    imu_accel_z = excluded.imu_accel_z,
    imu_gyro_x = excluded.imu_gyro_x,
    imu_gyro_y = excluded.imu_gyro_y,
    imu_gyro_z = excluded.imu_gyro_z,
    imu_age_ms = excluded.imu_age_ms,
    imu_calibrated = excluded.imu_calibrated,
    gps_simulated = excluded.gps_simulated,
    packet_seq = excluded.packet_seq,
    packet_type = excluded.packet_type,
    captured_at_ms = excluded.captured_at_ms,
    device_queue_ms = excluded.device_queue_ms,
    device_serialize_ms = excluded.device_serialize_ms,
    device_hmac_ms = excluded.device_hmac_ms,
    device_http_ms = excluded.device_http_ms,
    payload_bytes = excluded.payload_bytes,
    server_received_at = excluded.server_received_at,
    server_auth_ms = excluded.server_auth_ms,
    server_db_ms = excluded.server_db_ms;

  return jsonb_build_object(
    'ok', true,
    'commands', v_commands,
    'server', jsonb_build_object(
      'received_at_ms', floor(extract(epoch from v_received_at) * 1000)::bigint,
      'auth_ms', p_auth_ms,
      'db_ms', v_db_ms
    )
  );
end;
$function$;
