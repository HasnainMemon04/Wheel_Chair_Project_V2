-- Emergency wheel unlock: a SECOND relay that cuts power to the
-- electromagnetic wheel brake so a chair can be pushed by hand. Distinct from
-- `locked`, which is the motion lock (may the chair drive itself).
--
-- No provisioning column is added on `wheelchairs` on purpose: the device
-- itself reports whether the relay is fitted, so the console describes the
-- hardware that exists rather than a list someone has to remember to update.
-- device_state rows persist while a chair is offline, so the capability is
-- still known when the chair is powered down.

alter table public.device_state
  add column if not exists has_emg_unlock boolean,   -- relay fitted on this chair
  add column if not exists emg_unlock     boolean,   -- wheels currently free
  add column if not exists emg_unlock_s   integer;   -- seconds left on the hold

comment on column public.device_state.has_emg_unlock is
  'Device-reported: an emergency wheel-unlock relay is fitted (WCHAIR-004 only at present).';
comment on column public.device_state.emg_unlock is
  'Device-reported: the wheel brake is currently released, so the chair free-wheels.';
comment on column public.device_state.emg_unlock_s is
  'Seconds remaining on the time-boxed brake release; 0 when the brake is engaged.';
