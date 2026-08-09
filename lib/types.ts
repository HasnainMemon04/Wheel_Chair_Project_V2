// Live device shadow written by the ESP32 firmware via the /ingest Edge Function.
// This mirrors the `device_state` table in cloud/schema.sql exactly — the V2 app
// is a viewer over the SAME data the original webapp uses.
export interface DeviceState {
  wheelchair_id: string;
  ts: string;
  online: boolean;
  lat: number | null;
  lng: number | null;
  speed: number | null;
  sats: number | null;
  hdop: number | null;
  // Position provenance, asserted by the device / database.
  gps_fix: boolean | null;        // true = live satellite fix
  gps_simulated: boolean | null;  // true = device's bounded indoor fallback
  last_fix_lat: number | null;    // last position from a REAL fix (DB trigger)
  last_fix_lng: number | null;
  last_fix_at: string | null;
  pitch: number | null;
  roll: number | null;
  tilt: number | null;
  yaw: number | null;
  /** Age of the last IMU sample in ms — the honest IMU-health signal. */
  imu_age_ms: number | null;
  /**
   * True when pitch/roll are referenced to a stored level captured by an
   * operator. False means they are relative to whatever pose the chair booted
   * in, so a few degrees of lean is expected and not a fault.
   */
  imu_calibrated: boolean | null;
  temp_motor: number | null;
  temp_batt: number | null;
  temp_amb: number | null;
  humidity: number | null;
  batt_v: number | null;
  batt_pct: number | null;
  /**
   * False when the ADC could not actually measure the pack, in which case
   * batt_v/batt_pct are a hard-coded fallback rather than a reading. Shown to
   * the operator, because "98%" from an unwired divider is worse than "—".
   */
  batt_valid: boolean | null;
  in_motion: boolean;
  tamper: boolean;
  tamper_count: number;
  /**
   * The siren has been muted by an operator. The latches and the motion cut
   * are UNCHANGED — a silenced chair is still a cut-out chair, and the UI must
   * never let quiet read as resolved.
   */
  alarm_silenced: boolean | null;
  /** Seconds left on an operator maintenance override (0 = none). */
  maint_override_s: number | null;
  /**
   * The chair reports that an emergency wheel-unlock relay is fitted. Only
   * WCHAIR-004 has one at present, but the console reads the CHAIR rather than
   * a hardcoded id, so fitting another one is a firmware flag and nothing else.
   * null on a chair that has never reported (pre-1.2.8 firmware).
   */
  has_emg_unlock: boolean | null;
  /**
   * The wheel brake is released RIGHT NOW, so the chair free-wheels and can be
   * pushed by hand. Independent of `locked`, which is the motion lock: a chair
   * can be locked out of driving and still be pushable, which is the whole
   * point of the relay.
   */
  emg_unlock: boolean | null;
  /**
   * Legacy. The release was time-boxed until firmware 1.3.4; it now latches, so
   * 1.3.4+ pins this at 0. Retained because older rows still carry real values
   * and the device keeps sending it — dropping the key would make the ingest RPC
   * carry the last countdown forward forever.
   */
  emg_unlock_s: number | null;
  /**
   * The chair reports an emergency MAIN-POWER relay. A third relay, separate
   * from both `power` (the logical state driving the motion lock) and
   * `emg_unlock` (frees the wheels for pushing).
   */
  has_pwr_relay: boolean | null;
  /**
   * Main power is being held cut by an operator. Unlike the brake release this
   * LATCHES — it survives a device reboot and only an explicit restore turns it
   * back on — so the console must never let a cut chair read as merely idle.
   */
  pwr_cut: boolean | null;
  uptime: number | null;
  rssi: number | null;
  /**
   * The WiFi network the chair is joined to. Signal strength alone cannot tell
   * an operator whether it is on the RIGHT network — a strong bar on the wrong
   * SSID looks identical to a strong bar on the right one. Null on firmware
   * older than 1.3.5, which never reported it.
   */
  ssid: string | null;
  power: boolean;
  locked: boolean;
  session_state: string;
  time_left: number | null;
  speed_limit: number | null;
  over_speed: boolean;
  fw_version?: string | null;
  target_version?: string | null;
  ota_status?: string | null;
  ota_progress?: number | null;
  ota_last_error?: string | null;
  gps_nmea_gga?: string | null;
  gps_nmea_rmc?: string | null;
  geofence: { on: number; in: number; dist: number; r: number; lat?: number; lng?: number } | null;

  // ---- merged in from public.wheelchairs by useFleetState -------------------
  // Not telemetry: an operator's decision about whether riders may take this
  // chair. It rides along on the device row so that every existing
  // statusOf() / isRentable() caller honours it without having to know it
  // exists — there is no call site left that can forget to check.
  /** Operator has pulled this chair out of service (maintenance mode). */
  out_of_service?: boolean;
  /** Reason the operator gave. Console-only; riders never see it. */
  service_note?: string | null;
  service_since?: string | null;
}

/**
 * An operator-drawn, named geofence zone.
 *
 * Circles only — the device's SET_GEOFENCE command takes (lat, lng, radius),
 * so a circle is the only shape a chair can actually enforce on-board.
 */
export interface Geofence {
  id: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_m: number;
  color: string;
  active: boolean;
  note: string | null;
  created_at: string;
}

export interface FleetEvent {
  id: string | number;
  wheelchair_id: string;
  type: string;
  detail: Record<string, unknown> | null;
  lat: number | null;
  lng: number | null;
  ts: string;
}

// The shape fleet-map.js / FleetMap expects for each marker.
/**
 * How a chair reads to a human. 'maintenance' is the operator's own decision
 * (public.wheelchairs.out_of_service); the rest are derived from telemetry.
 */
export type ChairStatus = 'available' | 'rented' | 'fault' | 'offline' | 'maintenance';

export interface MapUnit {
  id: string;
  lat: number;
  lng: number;
  course: number;
  batt: number | null;
  /** Kept in sync with ChairStatus so a new status cannot be added in one
   *  place and silently forgotten in the other. */
  status: ChairStatus;
}

/** A named zone drawn on the map (circle + label). */
export interface MapZone {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  color: string;
  /** Highlighted while it is being edited in the operator console. */
  editing?: boolean;
}

export interface MapState {
  center?: [number, number];
  /** Named geofence zones to draw. */
  zones?: MapZone[];
  /** When set, a click on the map reports its coordinates (zone placement). */
  pickPoint?: boolean;
  zoom?: number;
  units?: MapUnit[];
  fence?: [number, number][];
  breach?: boolean;
  activeId?: string | null;
  me?: [number, number] | null;
  theme?: 'dark' | 'light';
  markerStyle?: 'pin' | 'arrow';
  follow?: boolean;
  fit?: number;
  recenter?: number;
  trail?: [number, number][];
}
