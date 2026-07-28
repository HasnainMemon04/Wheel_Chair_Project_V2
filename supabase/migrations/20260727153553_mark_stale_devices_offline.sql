-- Real online/offline: ingest sets online=true on every telemetry packet, but
-- nothing ever cleared it — a dead chair stayed "online" forever. This sweep
-- marks chairs offline once telemetry goes quiet for 30s (OFFLINE_AFTER_S).
-- The UPDATE flows through supabase_realtime, so every connected client sees
-- the flip live; the next telemetry packet from the device sets it true again.
create or replace function public.mark_stale_devices_offline()
returns void as $$
  update device_state
  set online = false
  where online = true
    and ts < now() - interval '30 seconds';
$$ language sql;

select cron.schedule('mark-stale-offline', '15 seconds', 'select public.mark_stale_devices_offline()');;
