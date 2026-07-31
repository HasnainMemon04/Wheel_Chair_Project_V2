import type { ChairStatus, DeviceState, MapUnit } from './types';
import { serverNow } from './clock';

export type { ChairStatus };

// "WCHAIR-074" -> "074"; falls back to the whole id.
export function shortId(id: string): string {
  const m = id.match(/(\d+)\s*$/);
  return m ? m[1] : id;
}


// A chair is ONLINE only if its telemetry is actually fresh. The ingest path
// stamps device_state.ts on every packet; if the ESP32 disconnects, rows simply
// stop updating — so freshness IS the truth, not the sticky `online` column.
//
// This window is derived from the TRANSPORT's worst case, not the happy-path
// cadence, and that distinction is the whole reason chairs used to flap between
// connected and disconnected:
//
//   * the firmware sends every 1000ms idle (TELEMETRY_IDLE_MS), 250ms in a
//     ride, 2000ms during an OTA;
//   * but a single upload may stall for up to HTTPS_TIMEOUT_MS = 7000ms before
//     it even gives up and retries.
//
// So a healthy, well-connected chair can legitimately go ~7-9s between rows.
// Any threshold at or below that guarantees flapping — one slow POST and the
// UI declares a working chair offline, then online again on the next packet.
// Measured on a bench chair at -30dBm with no reboots: median gap under a
// second, worst observed 5.74s.
//
// Worse still, all HTTPS traffic shares one TLS client behind a mutex, so a
// burst of safety events or command acks could starve the heartbeat entirely.
// Measured on a healthy bench chair at -30dBm with zero reboots: a 17s gap.
// Against 90s of live telemetry, a 5s window flipped state 8 times and a 15s
// window still flipped twice.
//
// Firmware v1.2.6 fixes the cause — events and acks now take the uplink with a
// bounded wait and yield to the heartbeat, and HTTPS_TIMEOUT_MS drops 7s -> 4s
// so no single request can hold it as long. On an updated chair the real gap is
// around a second.
//
// v1.2.7 additionally bounds the TLS handshake, which defaulted to 120s and was
// NOT covered by httpClient.setTimeout() — a stalled handshake could hold the
// shared client for two minutes. That was the cause of the long outages.
//
// With both fixes deployed the worst case is now bounded by construction:
// a 5s handshake cap plus the 1s cadence, so roughly 6-7s. Measured on
// WCHAIR-003 and -004 running 1.2.7, over 150-180s each: p50 1.85s, p90 3.48s,
// p99 5.51s, worst 3.69s, and ZERO state changes at an 8s window (against 8
// changes at 5s before the fix, with a 17s worst gap).
//
// 10s is therefore set from the bounded worst case, not from tolerance. It is
// deliberately NOT the 25s that was needed while chairs still ran the old
// firmware — carrying that number forward would have hidden a regression rather
// than reported one. If flapping ever returns at 10s, the transport has broken
// again and the console should say so instead of absorbing it.
export const OFFLINE_AFTER_MS = 10_000;

export function isOnline(d: DeviceState, nowMs: number = serverNow()): boolean {
  const age = nowMs - Date.parse(d.ts);
  if (!Number.isFinite(age)) return false;

  // A timestamp in the future can only mean leftover clock skew — never
  // staleness — so treat it as fresh rather than reporting a live chair
  // offline. (This is what made healthy chairs flap before the skew fix.)
  if (age < 0) return true;

  if (age < OFFLINE_AFTER_MS) return true;

  // Beyond the window the row is stale. The sticky `online` column is only
  // consulted here, as a corroborating signal — it is never allowed to
  // override demonstrably fresh telemetry.
  return false;
}

// The device is the authority; we only classify what it already asserts.
export function statusOf(d: DeviceState, nowMs: number = serverNow()): ChairStatus {
  if (d.out_of_service === true) return 'maintenance';
  if (!isOnline(d, nowMs)) return 'offline';

  // Diagnostic override: If operator override is active (maint_override_s > 0),
  // ignore SAFE_FAULT interlocks (such as missing DS18B20 temp probes on bench test).
  const hasOverride = (d.maint_override_s ?? 0) > 0;
  if (!hasOverride && (d.tamper || d.session_state === 'SAFE_FAULT')) return 'fault';

  const s = d.session_state;
  if (s === 'ACTIVE' || s === 'EXPIRING' || s === 'ENDING' || d.locked === false) return 'rented';
  return 'available';
}

/**
 * GPS speed, but only when it is a real measurement.
 *
 * Without a satellite fix the receiver cannot measure ground speed, so the
 * device reports null rather than inventing one. Returns null whenever the
 * value would be a guess — callers must render "—" rather than "0.0 km/h",
 * because those mean very different things to an operator.
 */
export function realSpeedKmh(d: DeviceState | null | undefined): number | null {
  if (!d) return null;
  if (d.gps_fix !== true || d.gps_simulated === true) return null;
  return typeof d.speed === 'number' && Number.isFinite(d.speed) ? d.speed : null;
}

/**
 * Is the chair stationary? Two independent signals, and indoors only one of
 * them exists:
 *   * GPS speed — precise outdoors, absent without a fix.
 *   * IMU in_motion — works anywhere, and is what the device itself latches on.
 * Returns null when neither can answer, so callers can refuse rather than
 * assume "stopped".
 */
export function isStationary(d: DeviceState | null | undefined): boolean | null {
  if (!d) return null;
  const spd = realSpeedKmh(d);
  const motionKnown = typeof d.in_motion === 'boolean';
  if (spd === null && !motionKnown) return null;
  if (spd !== null && spd >= 0.5) return false;
  if (motionKnown && d.in_motion) return false;
  // Indoors the IMU is the authority; outdoors both agree.
  return motionKnown ? d.in_motion === false : spd !== null && spd < 0.5;
}

export function isRentable(d: DeviceState, nowMs: number = serverNow()): boolean {
  return statusOf(d, nowMs) === 'available' && (d.batt_pct ?? 0) >= 25;
}

export function toUnit(d: DeviceState, nowMs: number = serverNow()): MapUnit | null {
  if (typeof d.lat !== 'number' || typeof d.lng !== 'number' || isNaN(d.lat) || isNaN(d.lng)) return null;
  return {
    id: d.wheelchair_id,
    lat: d.lat,
    lng: d.lng,
    course: d.yaw ?? 0,
    batt: d.batt_pct,
    status: statusOf(d, nowMs),
  };
}

export function toUnits(list: DeviceState[], nowMs: number = serverNow()): MapUnit[] {
  return list.map((d) => toUnit(d, nowMs)).filter((u): u is MapUnit => u !== null);
}

// device_state stores the geofence as a circle {lat,lng,r}. The map wants a
// polygon, so synthesise one so the dashed allowed-area ring still renders.
export function fencePolygon(d: DeviceState | undefined | null): [number, number][] {
  const gf = d?.geofence;
  if (!gf || !gf.on) return [];
  const lat = (gf.lat ?? d?.lat) as number | undefined;
  const lng = (gf.lng ?? d?.lng) as number | undefined;
  const r = gf.r || 300;
  if (typeof lat !== 'number' || typeof lng !== 'number') return [];
  const pts: [number, number][] = [];
  const dLat = r / 111320;
  const dLng = r / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    pts.push([lat + dLat * Math.sin(a), lng + dLng * Math.cos(a)]);
  }
  return pts;
}

export function battLabel(pct: number | null | undefined): string {
  return pct == null ? '—' : `${Math.round(pct)}%`;
}

// Rough usable range from battery %, tuned for the demo.
export function rangeLabel(pct: number | null | undefined): string {
  if (pct == null) return '—';
  return `${((pct / 100) * 18).toFixed(1)} km`;
}

export const STATUS_META: Record<ChairStatus, { label: string; dot: string; tagBg: string; tagFg: string }> = {
  available: { label: 'Available', dot: '#1f9d55', tagBg: '#e8f7ee', tagFg: '#137a45' },
  rented: { label: 'In ride', dot: '#3d7bfd', tagBg: '#eaf1ff', tagFg: '#2a5bd0' },
  fault: { label: 'Attention', dot: '#ff563c', tagBg: '#fff1ee', tagFg: '#c23417' },
  offline: { label: 'Offline', dot: '#9b99a6', tagBg: '#efeef3', tagFg: '#6b6a78' },
  maintenance: { label: 'Maintenance', dot: '#b8860b', tagBg: '#fdf3dc', tagFg: '#8a6100' },
};
