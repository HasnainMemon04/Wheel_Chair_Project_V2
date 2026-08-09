'use client';

// ---------------------------------------------------------------------------
// Zettamight ops — operator console.
//
// Ported from the prototype's "10 Operator console" section plus its overlays,
// but every value on this page comes from the live ESP32 telemetry in Supabase
// (`device_state`, `events`, `rentals`). Nothing is simulated.
//
// Per HANDOFF.md the browser is a viewer and a request-issuer:
//   * physical actions go through sendCommand() and render the DEVICE ack,
//   * hold-to-confirm guards anything physical,
//   * the incident stack sits clear of the e-stop so the e-stop always
//     hit-tests to itself,
//   * alarm audio is unlocked by the operator's first gesture.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTheme } from '../providers';
import { serverNow } from '../../lib/clock';
import { PositionSmoother, SOURCE_COLOR, SOURCE_LABEL, type ResolvedPosition } from '../../lib/position';
import { supabase } from '../../lib/supabase';
import { useFleetState, setServiceMode } from '../../lib/useFleetState';
import { useAuth } from '../../lib/useAuth';
import { useGeofences, nearestZone } from '../../lib/useGeofences';
import { useHold } from '../../lib/useHold';
import { sendCommand } from '../../lib/commands';
import { UNLOCK_FEE, PER_MIN, DAY_CAP, sar, estimateFee, mmss, timeAgo } from '../../lib/format';
import {
  shortId,
  statusOf,
  isOnline,
  isStationary,
  realSpeedKmh,
  toUnit,
  toUnits,
  fencePolygon,
  battLabel,
  rangeLabel,
  STATUS_META,
  type ChairStatus,
} from '../../lib/mapping';
import type { DeviceState, FleetEvent, Geofence, MapState, MapUnit, MapZone } from '../../lib/types';

// Leaflet needs `window`, so the map is browser-only. This page is a client
// component, which is what lets `ssr:false` be legal under Next 16.
const FleetMap = dynamic(() => import('../../components/FleetMap'), { ssr: false });

/* ========================================================================== */
/* tokens                                                                      */
/* ========================================================================== */

const GREEN = '#1f9d55';
const AMBER = '#f0b429';
const RED = '#ff563c';
const TRACK = 'color-mix(in srgb, var(--ink) 12%, transparent)';
const TERM_BG = '#0d0f15';
const TERM_FG = '#e9e9ef';
const TERM_HAIR = 'rgba(255,255,255,.1)';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const HOLD_MS = 1200;
// Mirror the firmware's thresholds (config.h) so the console's wording agrees
// with the interlocks the device actually enforces.
const TILT_WARN_DEG = 30;
const FALL_TILT_DEG = 50;
// Length of a maintenance-override grant (must be <= MAINT_OVERRIDE_MAX_MIN
// in the firmware's config.h, which clamps anything larger).
const OVERRIDE_MINUTES = 15;
// Palette cycled through when a new zone is created, so adjacent zones stay
// visually distinguishable on the map without the operator picking colours.
const ZONE_COLORS = ['#5b62d8', '#2a9d8f', '#e07a3f', '#8e5bd8', '#c2185b', '#0f8b8d'];

interface ZoneDraft {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  color: string;
  isNew: boolean;
}
// Operator relay grants are a policy value, not a sensor reading: an operator
// unlock opens the relay for 15 minutes unless the device refuses.
const OPERATOR_UNLOCK_S = 900;
// How long the emergency wheel brake stays released. Short on purpose: it is
// long enough to push a chair clear of a doorway or free a trapped rider, and
// short enough that a chair nobody is attending to brakes itself again. The
// device caps this at WHEEL_UNLOCK_MAX_S (300) and re-engages on its own, so
// this number can never leave a chair free-wheeling indefinitely.
// The wheel release used to be time-boxed here. The timer was removed at the
// operator's request in 1.3.4: it now latches on the device and only an explicit
// re-engage ends it, so there is no duration for the console to send. A reboot
// still comes back braked — that is firmware behaviour, not a timer.

/* ---- Local camera live view (demo rig, operator side only) ----------------
   Deliberately NOT modelled as a chair capability, unlike the wheel-unlock
   relay. The ESP32 knows nothing about this camera, nothing about it is stored
   in Supabase, and no firmware reports it: it is a Tapo C200 on the operator's
   own LAN, re-streamed as MJPEG by a Flask script on their laptop.

   So which chairs have one lives here in the console, and the URL lives in the
   operator's browser — changing either needs no deploy, no migration and no
   firmware. Add a chair by adding a line.

   The stream is reachable ONLY from the same network as that laptop. Opening
   the console from anywhere else still works; the camera panel simply cannot
   reach it, and says so rather than spinning. */
const CAMERA_CHAIRS: Record<string, string> = {
  'WCHAIR-004': 'Chair-side camera',
};
const CAMERA_URL_KEY = 'zm_camera_url';
const CAMERA_URL_DEFAULT = 'http://192.168.1.134:5000/video_feed';
// Online truth lives in lib/mapping.ts (isOnline: ts fresher than
// OFFLINE_AFTER_MS) — there is no separate staleness constant here.
const NMEA_MAX = 60;

/* ========================================================================== */
/* small pure helpers                                                          */
/* ========================================================================== */

// Shared styling for the breach-bar action buttons.
function breachBtn(
  background: string,
  color: string,
  disabled: boolean,
  outlined = false,
): React.CSSProperties {
  return {
    minHeight: 34,
    padding: '0 13px',
    border: outlined ? '1px solid rgba(255,255,255,.55)' : 0,
    borderRadius: 999,
    background,
    color,
    fontSize: 12.5,
    fontWeight: 800,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    whiteSpace: 'nowrap',
  };
}

function pctStr(v: number): string {
  return `${Math.max(0, Math.min(100, v)).toFixed(1)}%`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function hms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h, m, r].map((n) => String(n).padStart(2, '0')).join(':');
}

function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function stamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return sameDay ? `Today ${hh}:${mm}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${hh}:${mm}`;
}

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function num(v: number | null | undefined, digits: number, suffix = ''): string {
  return v == null || Number.isNaN(v) ? '—' : `${v.toFixed(digits)}${suffix}`;
}

function uptimeLabel(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  if (h < 48) return `${h}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// --- NMEA, ported from the prototype's nmeaSentence()/dm() ------------------
function nmeaSentence(body: string): string {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return `$${body}*${c.toString(16).toUpperCase().padStart(2, '0')}`;
}

function dm(v: number, isLat: boolean): string {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  return String(d).padStart(isLat ? 2 : 3, '0') + m.toFixed(3).padStart(6, '0');
}

/* ========================================================================== */
/* event vocabulary                                                            */
/* ========================================================================== */

type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

const CRITICAL_TYPES = new Set(['FALL', 'OVERTEMP', 'TAMPER', 'UNLOCK_FAILED']);
// A chair with its wheel brake released can roll on its own, so the release is
// a warning for as long as it lasts — not an INFO line that scrolls away.
const WARNING_TYPES = new Set([
  'TILT_WARN',
  'OVERSPEED',
  'GEOFENCE_EXIT',
  'SESSION_END_OFFLINE',
  'WHEEL_UNLOCK',
  // The siren going quiet by itself is NOT the tamper resolving. It stays a
  // warning so the row cannot be read as an all-clear.
  'TAMPER_SIREN_TIMEOUT',
]);
// A chair an operator has switched off is out of service until someone switches
// it back on, and nothing on the device will clear it — so the record of the cut
// has to stand out rather than scroll past as routine.
const POWER_CUT_TYPES = new Set(['POWER_CUT']);

function severityOf(type: string): Severity {
  if (CRITICAL_TYPES.has(type)) return 'CRITICAL';
  if (POWER_CUT_TYPES.has(type)) return 'CRITICAL';
  if (WARNING_TYPES.has(type)) return 'WARNING';
  return 'INFO';
}

const SEV_COLOR: Record<Severity, string> = { CRITICAL: RED, WARNING: AMBER, INFO: GREEN };
const SEV_LEVEL: Record<Severity, 'ERROR' | 'WARN' | 'INFO'> = {
  CRITICAL: 'ERROR',
  WARNING: 'WARN',
  INFO: 'INFO',
};

const EVENT_TITLE: Record<string, string> = {
  FALL: 'Fall detected',
  OVERTEMP: 'Over temperature',
  TAMPER: 'Tamper detected',
  OVERSPEED: 'Over speed',
  TILT_WARN: 'Tilt warning',
  GEOFENCE_EXIT: 'Left the allowed area',
  GEOFENCE_ENTER: 'Back inside the allowed area',
  SOS: 'SOS raised',
  SESSION_LOCKED: 'Session locked',
  EXPIRY_WARNING: 'Session about to expire',
  UNLOCK_FAILED: 'Unlock refused by the chair',
  SESSION_END_OFFLINE: 'Session ended while offline',
  WHEEL_UNLOCK: 'Wheel brake released',
  WHEEL_UNLOCK_EXPIRED: 'Wheel brake re-engaged (timed out)',
  WHEEL_UNLOCK_REFUSED: 'Wheel release refused',
  WHEEL_LOCK: 'Wheel brake re-engaged',
  TAMPER_SIREN_TIMEOUT: 'Tamper siren muted itself',
  POWER_CUT: 'Main power cut',
  POWER_RESTORED: 'Main power restored',
  POWER_CUT_REFUSED: 'Power switch refused',
};

const EVENT_BLURB: Record<string, string> = {
  FALL: 'The device detected an impact and cut the relay.',
  OVERTEMP: 'A temperature probe crossed the firmware cut-off.',
  TAMPER: 'Movement was detected while the chair was locked.',
  OVERSPEED: 'The chair exceeded its speed limit.',
  TILT_WARN: 'Tilt held above the firmware warning threshold.',
  GEOFENCE_EXIT: 'The chair crossed the perimeter and the device slowed it.',
  GEOFENCE_ENTER: 'The chair is back inside the perimeter.',
  SOS: 'An emergency stop was raised on this chair.',
  SESSION_LOCKED: 'The relay relocked and the session closed.',
  EXPIRY_WARNING: 'The device warned the rider that the session is ending.',
  UNLOCK_FAILED: 'The device refused an unlock because a safety check was active.',
  SESSION_END_OFFLINE: 'The session was closed after the uplink dropped.',
  WHEEL_UNLOCK: 'An operator freed the wheels so the chair could be pushed by hand.',
  WHEEL_UNLOCK_EXPIRED: 'The release timed out and the chair braked itself again.',
  WHEEL_UNLOCK_REFUSED: 'The chair has no emergency wheel-unlock relay fitted.',
  WHEEL_LOCK: 'An operator re-engaged the wheel brake before the hold ran out.',
  TAMPER_SIREN_TIMEOUT:
    'The siren stopped on its own after its time limit. The tamper is STILL latched and still needs acknowledging.',
  POWER_CUT: 'An operator removed main power. It latches — a reboot will not restore it.',
  POWER_RESTORED: 'An operator turned main power back on.',
  POWER_CUT_REFUSED: 'The chair has no emergency power relay fitted.',
};

function titleOf(type: string): string {
  const known = EVENT_TITLE[type];
  if (known) return known;
  const words = type.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The `detail` jsonb is written by the firmware, so render what is actually
// there rather than inventing a sentence for it.
function detailPairs(detail: Record<string, unknown> | null): string {
  if (!detail) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined || v === '') continue;
    const key = k.replace(/_/g, ' ');
    if (typeof v === 'number') parts.push(`${key} ${Number.isInteger(v) ? v : v.toFixed(2)}`);
    else if (typeof v === 'boolean') parts.push(`${key} ${v ? 'yes' : 'no'}`);
    else if (typeof v === 'string') parts.push(`${key} ${v}`);
    else parts.push(`${key} ${JSON.stringify(v)}`);
  }
  return parts.join(' · ');
}

function humanDetail(ev: FleetEvent): string {
  const blurb = EVENT_BLURB[ev.type] || '';
  const pairs = detailPairs(ev.detail);
  if (blurb && pairs) return `${blurb} ${pairs}`;
  if (blurb) return blurb;
  if (pairs) return pairs;
  if (ev.lat != null && ev.lng != null) return `Reported at ${ev.lat.toFixed(5)}, ${ev.lng.toFixed(5)}`;
  return 'No further detail was sent with this event.';
}

function logMessage(ev: FleetEvent): string {
  const pairs = detailPairs(ev.detail);
  return pairs ? `${ev.type.toLowerCase()} · ${pairs}` : ev.type.toLowerCase();
}

/* ========================================================================== */
/* icons — inline svg children, stroke="currentColor" (no icon library)        */
/* ========================================================================== */

const ICON = {
  map: (
    <>
      <path d="M9 3.5 3.5 6v14.5L9 18l6 2.5 5.5-2.5V3.5L15 6z" />
      <path d="M9 3.5V18M15 6v14.5" />
    </>
  ),
  bolt: <path d="M13 2 4.5 14H10l-1 8 9.5-12H13z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3.2 2" />
    </>
  ),
  chart: <path d="M3 12h3.5l2.5 6 4-14 2.5 8H21" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  back: <path d="M15 5l-7 7 7 7" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </>
  ),
  bell: (
    <>
      <path d="M12 3a5 5 0 0 1 5 5v5l2 3H5l2-3V8a5 5 0 0 1 5-5z" />
      <path d="M9.5 19.5a2.5 2.5 0 0 0 5 0" />
    </>
  ),
  tamper: (
    <>
      <rect x="4" y="10.5" width="16" height="11" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 7.4-2" />
    </>
  ),
  fall: (
    <>
      <circle cx="12" cy="4.6" r="2" />
      <path d="M4.5 19.5 9 14l-1.5-4.5 5 1.5 2 3.5 4 1" />
    </>
  ),
  offline: (
    <>
      <path d="M1.5 8.5a15 15 0 0 1 8.2-4.2M16.5 6.2a15 15 0 0 1 6 2.3M5 12a10 10 0 0 1 4.5-2.6M14.5 10.4a10 10 0 0 1 4.5 1.6M8.2 15.9a4.4 4.4 0 0 1 3.8-1.3" />
      <path d="M12 19.5h.01" />
      <path d="M3 3l18 18" />
    </>
  ),
} as const;

interface SvgProps {
  size?: number;
  width?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

function Svg({ size = 20, width = 1.8, children, style }: SvgProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: 'none', ...style }}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* ========================================================================== */
/* hold-to-confirm button                                                      */
/* ========================================================================== */

interface HoldButtonProps {
  onComplete: () => void;
  disabled?: boolean;
  fill?: string;
  justify?: React.CSSProperties['justifyContent'];
  gap?: number;
  style?: React.CSSProperties;
  ariaLabel?: string;
  children: (holding: boolean) => React.ReactNode;
}

// The gesture itself lives in useHold (ref-tracked, per HANDOFF). This shell
// only paints the progress sweep and forwards the pointer handlers.
function HoldButton({
  onComplete,
  disabled = false,
  fill = 'rgba(255,255,255,.3)',
  justify = 'center',
  gap = 12,
  style,
  ariaLabel,
  children,
}: HoldButtonProps) {
  const hold = useHold(HOLD_MS, onComplete);
  const holding = hold.pct > 0;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      {...(disabled ? {} : hold.handlers)}
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: justify,
        border: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        touchAction: 'none',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: disabled ? '0%' : hold.pctLabel,
          background: fill,
          pointerEvents: 'none',
        }}
      />
      <span
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: justify,
          gap: `${gap}px`,
          width: '100%',
          minWidth: 0,
        }}
      >
        {children(holding)}
      </span>
    </button>
  );
}

/* ========================================================================== */
/* layout primitives                                                           */
/* ========================================================================== */

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        borderRadius: 26,
        background: 'var(--card-bg)',
        border: '1px solid var(--hair)',
        color: 'var(--ink)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Kicker({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
      <span
        style={{
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: '.04em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
      {right ? <span style={{ marginLeft: 'auto', flex: 'none' }}>{right}</span> : null}
    </div>
  );
}

function Pill({ children, bg, fg }: { children: React.ReactNode; bg?: string; fg?: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '5px 11px',
        borderRadius: 999,
        background: bg || 'var(--tint-bg)',
        color: fg || 'var(--ink)',
        fontSize: 11.5,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function Bar({ label, value, width, color }: { label: string; value: string; width: string; color: string }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
        <span style={{ color: 'var(--muted)' }}>{label}</span>
        <span style={{ fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: TRACK, overflow: 'hidden' }}>
        <span
          style={{
            display: 'block',
            height: '100%',
            borderRadius: 999,
            width,
            background: color,
            transition: 'width .4s cubic-bezier(.32,.72,0,1)',
          }}
        />
      </div>
    </div>
  );
}

/* ========================================================================== */
/* diagnostics — derived from real device_state fields, never invented         */
/* ========================================================================== */

type DiagState = 'PASS' | 'WARN' | 'FAIL' | 'NO DATA';

interface DiagRow {
  name: string;
  state: DiagState;
  note: string;
}

const DIAG_COLOR: Record<DiagState, string> = {
  PASS: GREEN,
  WARN: AMBER,
  FAIL: RED,
  'NO DATA': 'var(--muted)',
};

function buildDiag(d: DeviceState | null, online: boolean): DiagRow[] {
  if (!d) return [];
  const rows: DiagRow[] = [];

  // Why is the chair interlocked? Attribute it to the subsystem that actually
  // tripped, so the operator is not left guessing (or misreading a healthy
  // sensor as the culprit).
  if (d.session_state === 'SAFE_FAULT') {
    const causes: string[] = [];
    if (d.tamper) causes.push('tamper latched');
    if ((d.tilt ?? 0) > FALL_TILT_DEG) causes.push(`fall (tilt ${(d.tilt ?? 0).toFixed(0)}°)`);
    if (d.temp_batt == null && d.temp_motor == null) causes.push('temp probe missing');
    if ((d.temp_batt ?? 0) > 55 || (d.temp_motor ?? 0) > 55) causes.push('over-temperature');
    rows.push({
      name: 'Safety interlock',
      state: 'FAIL',
      note: causes.length ? causes.join(' · ') : 'SAFE_FAULT — cause reported by device',
    });
  }

  // GNSS fix quality from the real satellite count and HDOP.
  if (d.sats == null && d.hdop == null) {
    rows.push({ name: 'GNSS fix quality', state: 'NO DATA', note: 'no fix reported' });
  } else {
    const sats = d.sats ?? 0;
    const hdop = d.hdop ?? 99;
    const state: DiagState = sats >= 6 && hdop <= 2 ? 'PASS' : sats >= 4 ? 'WARN' : 'FAIL';
    rows.push({ name: 'GNSS fix quality', state, note: `${sats} sats · hdop ${hdop.toFixed(1)}` });
  }

  // IMU health, judged ONLY on the IMU's own evidence: is it still delivering
  // samples, and is the attitude finite? It must never be failed just because
  // the chair is in SAFE_FAULT — the fault is usually another subsystem, and
  // blaming a working sensor sends the technician to the wrong part.
  const hasAttitude = d.pitch != null || d.roll != null || d.tilt != null;
  if (!hasAttitude) {
    rows.push({ name: 'IMU self-test (MPU6500)', state: 'NO DATA', note: 'no attitude reported' });
  } else {
    const tilt = d.tilt ?? 0;
    const ageMs = d.imu_age_ms;
    // The IMU runs at 50 Hz; anything older than 2 s means it stopped talking.
    const stale = ageMs != null && ageMs > 2000;
    const state: DiagState = stale ? 'FAIL' : tilt >= TILT_WARN_DEG ? 'WARN' : 'PASS';
    const note = stale
      ? `no sample for ${(ageMs / 1000).toFixed(1)} s`
      : `tilt ${tilt.toFixed(1)}°${ageMs != null ? ` · ${ageMs} ms` : ''}`;
    rows.push({ name: 'IMU self-test (MPU6500)', state, note });
  }

  // Temperature probes (DS18B20). These gate the over-temp interlock, so a
  // missing probe is a genuine failure — not merely "no data".
  const battTemp = d.temp_batt;
  const motorTemp = d.temp_motor;
  if (battTemp == null && motorTemp == null) {
    rows.push({ name: 'Temp probes (DS18B20)', state: 'FAIL', note: 'no probe responding' });
  } else {
    const t = battTemp ?? motorTemp ?? 0;
    const state: DiagState = t >= 55 ? 'FAIL' : t >= 45 ? 'WARN' : 'PASS';
    const which = battTemp != null && motorTemp != null
      ? `batt ${battTemp.toFixed(1)} °C · motor ${motorTemp.toFixed(1)} °C`
      : battTemp != null
        ? `batt ${battTemp.toFixed(1)} °C · motor probe missing`
        : `motor ${(motorTemp as number).toFixed(1)} °C · batt probe missing`;
    const partial: DiagState = battTemp == null || motorTemp == null ? 'WARN' : state;
    rows.push({
      name: 'Temp probes (DS18B20)',
      state: state === 'FAIL' ? 'FAIL' : partial,
      note: which,
    });
  }

  // Uplink strength. `online` is derived from telemetry freshness, not the
  // sticky device_state.online column.
  if (d.rssi == null) {
    rows.push({ name: 'Uplink RSSI', state: online ? 'WARN' : 'FAIL', note: online ? 'not reported' : 'offline' });
  } else {
    const state: DiagState = !online ? 'FAIL' : d.rssi > -80 ? 'PASS' : d.rssi > -95 ? 'WARN' : 'FAIL';
    rows.push({
      name: 'Uplink RSSI',
      state,
      note: online
        ? `${d.rssi} dBm${d.ssid ? ` · ${d.ssid}` : ''}`
        : 'offline',
    });
  }

  // Relay driver: the device reports the latch state and the main power rail.
  rows.push({
    name: 'Relay driver',
    state: !online ? 'NO DATA' : d.power ? 'PASS' : 'WARN',
    note: !online ? 'offline' : `${d.locked ? 'LOCKED' : 'UNLOCKED'} · power ${d.power ? 'on' : 'off'}`,
  });

  // Battery pack.
  if (d.batt_pct == null) {
    rows.push({ name: 'Battery pack', state: 'NO DATA', note: 'no reading' });
  } else {
    const p = d.batt_pct;
    const state: DiagState = p >= 25 ? 'PASS' : p >= 15 ? 'WARN' : 'FAIL';
    rows.push({ name: 'Battery pack', state, note: `${Math.round(p)}% · ${num(d.batt_v, 2, ' V')}` });
  }

  return rows;
}

/* ========================================================================== */
/* rentals                                                                     */
/* ========================================================================== */

interface RentalRow {
  id: string;
  wheelchair_id: string;
  state: string;
  start_at: string | null;
  end_at: string | null;
  duration_s: number | null;
  created_at: string | null;
}

const OPEN_STATES = new Set(['reserved', 'active', 'expiring', 'ending']);

function rentalSeconds(r: RentalRow, nowMs: number): number {
  if (r.start_at) {
    const start = Date.parse(r.start_at);
    if (!Number.isNaN(start)) {
      const end = r.end_at ? Date.parse(r.end_at) : nowMs;
      if (!Number.isNaN(end)) return Math.max(0, (end - start) / 1000);
    }
  }
  return r.duration_s ?? 0;
}

/* ========================================================================== */
/* incidents                                                                   */
/* ========================================================================== */

type IncidentKind = 'tamper' | 'fault' | 'offline';

interface Incident {
  key: string;
  chairId: string;
  kind: IncidentKind;
  title: string;
  value: string;
  detail: string;
  at: string;
}

function liveIncidents(states: DeviceState[], nowMs: number): Incident[] {
  const out: Incident[] = [];
  for (const d of states) {
    const online = isOnline(d, nowMs);

    // A chair that stops reporting is itself an operational incident — and its
    // last tamper/fault assertions are STALE, so they must not blare as live.
    if (!online) {
      out.push({
        key: `offline:${d.wheelchair_id}`,
        chairId: d.wheelchair_id,
        kind: 'offline',
        title: 'Uplink lost — chair offline',
        value: timeAgo(d.ts),
        detail:
          'No telemetry from the chair. Its state is unknown until it reconnects; sensor data is hidden and commands will not reach it.',
        at: d.ts,
      });
      continue;
    }

    if (d.tamper) {
      out.push({
        key: `tamper:${d.wheelchair_id}`,
        chairId: d.wheelchair_id,
        kind: 'tamper',
        title: 'Tamper latched',
        value: `x${d.tamper_count ?? 0}`,
        detail:
          'The device detected movement while the chair was locked and latched its tamper alarm. It stays latched until the chair is told to re-arm.',
        at: d.ts,
      });
    }
    if (d.session_state === 'SAFE_FAULT') {
      const hasOverride = (d.maint_override_s ?? 0) > 0;
      if (!hasOverride) {
        const isFall = (d.tilt ?? 0) > FALL_TILT_DEG;
        out.push({
          key: `fault:${d.wheelchair_id}`,
          chairId: d.wheelchair_id,
          kind: 'fault',
          title: isFall ? 'Fall detected — Relay cut' : 'Safety fault — Relay cut',
          value: isFall ? `tilt ${(d.tilt ?? 0).toFixed(0)}°` : 'SAFE_FAULT',
          detail: isFall
            ? `Impact detected! Wheelchair tilted at ${(d.tilt ?? 0).toFixed(1)}°. Emergency relay cut.`
            : 'The chair put itself into SAFE_FAULT and cut its relay.',
          at: d.ts,
        });
      }
    }
  }
  return out;
}

/* ========================================================================== */
/* page                                                                        */
/* ========================================================================== */

type OpTab = 'fleet' | 'unit' | 'rides' | 'events' | 'ota';
type FilterKey = 'all' | 'available' | 'rented' | 'fault' | 'offline' | 'low';
type LogLevel = 'ALL' | 'INFO' | 'WARN' | 'ERROR';

const TABS: { key: OpTab; label: string; short: string; icon: React.ReactNode }[] = [
  { key: 'fleet', label: 'Fleet map', short: 'Fleet', icon: ICON.map },
  { key: 'unit', label: 'Chair detail', short: 'Chair', icon: ICON.bolt },
  { key: 'rides', label: 'Rides & revenue', short: 'Rides', icon: ICON.clock },
  { key: 'events', label: 'Alerts & log', short: 'Alerts', icon: ICON.chart },
  { key: 'ota', label: 'OTA Firmware', short: 'OTA', icon: ICON.bolt },
];

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'available', label: 'Available' },
  { key: 'rented', label: 'In ride' },
  { key: 'fault', label: 'Attention' },
  { key: 'offline', label: 'Offline' },
  { key: 'low', label: 'Low battery' },
];

const LOG_LEVELS: LogLevel[] = ['ALL', 'INFO', 'WARN', 'ERROR'];

interface NmeaLine {
  key: string;
  line: string;
  kind: 'gga' | 'rmc';
}

interface Ack {
  cmd: string;
  ok: boolean;
  text: string;
  at: number;
}

export default function OpsPage() {
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const { deviceStates, events, loading, error } = useFleetState();
  // Identity is already proven by middleware.ts before this page renders; this
  // is here to name the operator on screen and to let them sign out.
  const { displayName, signOut } = useAuth();

  /* ---------------------------------------------------------------- state */
  const [tab, setTab] = useState<OpTab>('fleet');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [fleetSheetOpen, setFleetSheetOpen] = useState(false);
  const [sheetQuery, setSheetQuery] = useState('');
  const [recenter, setRecenter] = useState(0);

  const [pending, setPending] = useState<string | null>(null);
  const [ack, setAck] = useState<Ack | null>(null);
  const [estopEngaged, setEstopEngaged] = useState(false);

  // Maintenance mode (operator-only; see toggleService below).
  const [serviceBusy, setServiceBusy] = useState(false);
  const [serviceNote, setServiceNote] = useState('');

  // Greet the operator by name once per arrival, then get out of the way.
  const [welcome, setWelcome] = useState('');

  const [acked, setAcked] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [logQuery, setLogQuery] = useState('');
  const [logLevel, setLogLevel] = useState<LogLevel>('ALL');

  const [muted, setMuted] = useState(false);
  const [silenced, setSilenced] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem('zm_dismissed_incidents') : null;
      return raw ? new Set(JSON.parse(raw)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('zm_dismissed_incidents', JSON.stringify(Array.from(dismissed)));
    } catch {
      /* ignore */
    }
  }, [dismissed]);
  const [silencedBanners, setSilencedBanners] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem('zm_silenced_alarms') : null;
      return raw ? new Set(JSON.parse(raw)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('zm_silenced_alarms', JSON.stringify(Array.from(silencedBanners)));
    } catch {
      /* ignore */
    }
  }, [silencedBanners]);

  /* ---- local camera live view -------------------------------------------
     All three start at a value that is identical on the server and the client,
     then get corrected in an effect. Reading localStorage or window.location
     during the first render would make the server and browser disagree and
     produce a hydration mismatch. */
  const [cameraUrl, setCameraUrl] = useState(CAMERA_URL_DEFAULT);
  const [cameraInline, setCameraInline] = useState(false);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [pageIsHttps, setPageIsHttps] = useState(false);

  useEffect(() => {
    setPageIsHttps(window.location.protocol === 'https:');
    try {
      const saved = localStorage.getItem(CAMERA_URL_KEY);
      if (saved) setCameraUrl(saved);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CAMERA_URL_KEY, cameraUrl);
    } catch {
      /* ignore */
    }
  }, [cameraUrl]);

  // A plain-HTTP stream cannot be embedded in an HTTPS page: the browser
  // upgrades the request to https://, the Flask server has no TLS, and the
  // image fails. Worth KNOWING rather than discovering — this lets the panel
  // say so up front instead of showing a preview that can never load.
  const cameraNeedsNewWindow = pageIsHttps && cameraUrl.startsWith('http://');

  // Reset the failure flag whenever the target changes, so a corrected URL is
  // not still wearing the previous one's error.
  useEffect(() => {
    setCameraFailed(false);
  }, [cameraUrl]);

  const openCameraWindow = useCallback(() => {
    // A top-level navigation is NOT mixed content, so this works from the
    // HTTPS console even though an inline <img> would be blocked.
    window.open(cameraUrl, 'wchair-camera', 'width=920,height=640,noopener');
  }, [cameraUrl]);

  const [rentals, setRentals] = useState<RentalRow[]>([]);
  const [rentalsError, setRentalsError] = useState<string | null>(null);
  const [rentalsLoaded, setRentalsLoaded] = useState(false);

  const [nmea, setNmea] = useState<NmeaLine[]>([]);
  const [gpsFetching, setGpsFetching] = useState(false);

  const [now, setNow] = useState(() => serverNow());
  const [wide, setWide] = useState(false);

  // ---- OTA Firmware Release Management ----
  interface FirmwareReleaseRow {
    id: string;
    version: string;
    url: string;
    size: number;
    sha256?: string | null;
    notes?: string | null;
    created_at: string;
    /** Chair this image was built for. null = universal. */
    device_id?: string | null;
  }

  const [fwReleases, setFwReleases] = useState<FirmwareReleaseRow[]>([]);
  const [selectedFwId, setSelectedFwId] = useState<string | null>(null);
  const [fwVersionInput, setFwVersionInput] = useState('');
  const [fwNotesInput, setFwNotesInput] = useState('');
  const [fwUploading, setFwUploading] = useState(false);
  const [otaDeploying, setOtaDeploying] = useState(false);
  const [otaRolloutFleetWide, setOtaRolloutFleetWide] = useState(false);
  const [otaMaintenanceOverride, setOtaMaintenanceOverride] = useState(false);
  const [otaStatusMsg, setOtaStatusMsg] = useState<string | null>(null);
  const [otaErrorMsg, setOtaErrorMsg] = useState<string | null>(null);

  const fetchReleases = useCallback(async () => {
    const { data, error } = await supabase
      .from('firmware_releases')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error && data) {
      setFwReleases(data as FirmwareReleaseRow[]);
      if (data.length > 0 && !selectedFwId) {
        setSelectedFwId(data[0].id);
      }
    }
  }, [selectedFwId]);

  useEffect(() => {
    if (tab === 'ota') void fetchReleases();
  }, [tab, fetchReleases]);

  const handleFwUpload = useCallback(
    async (file: File) => {
      if (!file || !fwVersionInput.trim()) {
        setOtaErrorMsg('Enter a target release version string (e.g. 0.4.5) first.');
        return;
      }
      setFwUploading(true);
      setOtaErrorMsg(null);
      setOtaStatusMsg('Computing SHA-256 hash...');

      try {
        const buffer = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const sha256 = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');

        setOtaStatusMsg('Uploading binary to Supabase Storage...');
        const versionStr = fwVersionInput.trim();
        const filePath = `releases/${versionStr}/${file.name}`;
        const { error: uploadErr } = await supabase.storage
          .from('firmware')
          .upload(filePath, file, { upsert: true });

        if (uploadErr) throw uploadErr;

        const { data: publicUrlData } = supabase.storage
          .from('firmware')
          .getPublicUrl(filePath);

        const publicUrl = publicUrlData.publicUrl;

        setOtaStatusMsg('Registering release in database...');
        const { error: dbErr } = await supabase.from('firmware_releases').upsert(
          {
            version: versionStr,
            url: publicUrl,
            size: file.size,
            sha256,
            notes: fwNotesInput.trim() || null,
          },
          { onConflict: 'version' },
        );

        if (dbErr) throw dbErr;

        setOtaStatusMsg(`Firmware v${versionStr} successfully registered!`);
        setFwVersionInput('');
        setFwNotesInput('');
        void fetchReleases();
      } catch (err: unknown) {
        const e = err as { message?: string };
        setOtaErrorMsg(e?.message || String(err) || 'Failed to upload firmware binary.');
      } finally {
        setFwUploading(false);
      }
    },
    [fwVersionInput, fwNotesInput, fetchReleases],
  );

  const handlePushOTA = useCallback(async () => {
    if (!selectedId) {
      setOtaErrorMsg('Select a wheelchair from the fleet list first.');
      return;
    }
    const rel = fwReleases.find((r) => r.id === selectedFwId);
    if (!rel) {
      setOtaErrorMsg('Select a valid firmware release to deploy.');
      return;
    }

    const requested = otaRolloutFleetWide
      ? Array.from(new Set([selectedId, ...deviceStates.map((d) => d.wheelchair_id)]))
      : [selectedId];

    // A device-scoped release carries that chair's DEVICE_ID and DEVICE_KEY
    // compiled in. Sending it anywhere else renames the receiving chair and
    // breaks its HMAC — it goes offline and cannot be reached to fix remotely.
    // Refuse rather than warn: this is not recoverable over the air.
    const targetIds = rel.device_id ? requested.filter((id) => id === rel.device_id) : requested;
    const skipped = requested.filter((id) => !targetIds.includes(id));

    if (targetIds.length === 0) {
      setOtaErrorMsg(
        `Firmware v${rel.version} is built for ${rel.device_id} and cannot be installed on ${requested.join(', ')}. Build a release for that chair instead.`,
      );
      return;
    }

    setOtaDeploying(true);
    setOtaErrorMsg(null);
    setOtaStatusMsg(`Deploying firmware v${rel.version} to ${targetIds.join(', ')}...`);

    try {
      for (const tId of targetIds) {
        await supabase.from('wheelchairs').update({ target_version: rel.version }).eq('id', tId);

        // "Force Maintenance Override" has to actually grant the override.
        //
        // The flag on the OTA command alone is not enough: firmware up to
        // v1.2.4 reads it only to choose the STATUS LABEL ("override_waiting"
        // instead of "deferred") and then blocks on the safety fault anyway. A
        // chair with a dead temperature probe therefore waited on a condition
        // that could never clear, showing "override_waiting 0%" indefinitely.
        //
        // MAINT_OVERRIDE is what actually releases the sensor interlock, so
        // send it first and let the chair reach LOCKED before the OTA lands.
        // Newer firmware honours the flag directly and this is then harmless —
        // but it is what makes the button work on chairs already in the field,
        // which are exactly the ones that cannot be reached any other way.
        const chair = deviceStates.find((d) => d.wheelchair_id === tId);
        const needsOverride =
          otaMaintenanceOverride
          && (chair?.session_state === 'SAFE_FAULT' || chair?.tamper === true);

        if (needsOverride) {
          await supabase.from('commands').insert({
            wheelchair_id: tId,
            cmd: 'MAINT_OVERRIDE',
            args: { minutes: 90 },
            status: 'pending',
            req_id: `ota-pre-override-${tId.toLowerCase()}-${Date.now()}`,
          });
        }

        const reqId = `ota-${rel.version}-${tId.toLowerCase()}-${Date.now()}`;
        await supabase.from('commands').insert({
          wheelchair_id: tId,
          cmd: 'OTA',
          args: {
            url: rel.url,
            version: rel.version,
            size: rel.size,
            sha256: rel.sha256,
            maintenance_override: otaMaintenanceOverride,
            override: otaMaintenanceOverride,
          },
          status: 'pending',
          req_id: reqId,
        });
      }
      setOtaStatusMsg(
        `OTA firmware v${rel.version} command queued for ${targetIds.join(', ')}! Awaiting ESP32 download.`
        + (skipped.length
          ? ` Skipped ${skipped.join(', ')} — this build belongs to ${rel.device_id}.`
          : ''),
      );
    } catch (err: unknown) {
      const e = err as { message?: string };
      setOtaErrorMsg(e?.message || String(err) || 'Failed to queue OTA command.');
    } finally {
      setOtaDeploying(false);
    }
  }, [selectedId, fwReleases, selectedFwId, otaRolloutFleetWide, otaMaintenanceOverride, deviceStates]);

  const handleDeleteRelease = useCallback(
    async (id: string, version: string) => {
      if (!window.confirm(`Delete firmware release v${version}?`)) return;
      const { error } = await supabase.from('firmware_releases').delete().eq('id', id);
      if (!error) {
        void fetchReleases();
      }
    },
    [fetchReleases],
  );

  /* ---------------------------------------------------------------- refs  */
  const selectedIdRef = useRef<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const selectedRef = useRef<DeviceState | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const seenIncidentKeys = useRef<ReadonlySet<string>>(new Set<string>());
  const nmeaSeq = useRef(0);

  /* ------------------------------------------------------- viewport width */
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  /* ------------------------------------------------------ 1 Hz wall clock */
  useEffect(() => {
    const id = window.setInterval(() => setNow(serverNow()), 1000);
    return () => window.clearInterval(id);
  }, []);

  /* ------------------------------------------------------- derived: fleet */
  const sorted = useMemo(
    () => [...deviceStates].sort((a, b) => a.wheelchair_id.localeCompare(b.wheelchair_id)),
    [deviceStates]
  );

  const selected = useMemo(
    () => sorted.find((d) => d.wheelchair_id === selectedId) ?? null,
    [sorted, selectedId]
  );

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Pick a chair once the fleet arrives so the console is never blank.
  useEffect(() => {
    if (selectedId === null && sorted.length > 0) setSelectedId(sorted[0].wheelchair_id);
  }, [selectedId, sorted]);

  // Clear NMEA lines when switching chairs.
  useEffect(() => {
    setNmea([]);
  }, [selectedId]);

  // On-demand one-shot GPS data fetch — no continuous streaming.
  const fetchGpsOnce = useCallback(async () => {
    if (!selectedId || gpsFetching) return;
    setGpsFetching(true);
    setNmea([]);

    const { data, error } = await supabase
      .from('device_state')
      .select('gps_nmea_gga, gps_nmea_rmc, lat, lng, sats, speed, hdop, gps_fix, gps_simulated, gps_course, gps_altitude, gps_age_ms, gps_chars, gps_sentences, gps_checksum_failures, ts')
      .eq('wheelchair_id', selectedId)
      .maybeSingle();

    if (error || !data) {
      nmeaSeq.current += 1;
      setNmea([{ key: `err-${nmeaSeq.current}`, line: error?.message ?? 'No data returned from device_state.', kind: 'gga' }]);
      setGpsFetching(false);
      return;
    }

    const gga = data.gps_nmea_gga as string | null;
    const rmc = data.gps_nmea_rmc as string | null;
    const lat = data.lat as number | null;
    const lng = data.lng as number | null;
    // Left nullable on purpose: "0 satellites" and "unknown" are different
    // findings, and collapsing them hides a dead receiver behind a plausible
    // reading. The same applies to speed, which cannot be measured without a fix.
    const sats = data.sats as number | null;
    const speed = data.speed as number | null;
    const hdop = data.hdop as number | null;
    const gpsFix = data.gps_fix as boolean | null;
    const gpsSimulated = data.gps_simulated as boolean | null;
    const course = data.gps_course as number | null;
    const altitude = data.gps_altitude as number | null;
    const gpsAgeMs = data.gps_age_ms as number | null;
    const gpsChars = data.gps_chars as number | null;
    const gpsSentences = data.gps_sentences as number | null;
    const gpsChecksumFail = data.gps_checksum_failures as number | null;
    const ts = data.ts as string | null;

    const lines: NmeaLine[] = [];
    const push = (line: string, kind: 'gga' | 'rmc' = 'gga') => {
      nmeaSeq.current += 1;
      lines.push({ key: `l-${nmeaSeq.current}`, line, kind });
    };

    // ── Header ──
    push(`══════════ GPS SNAPSHOT · ${selectedId} ══════════`);
    push(`Captured at: ${ts ? new Date(ts).toLocaleString() : '—'}`);
    push('');

    // ── Raw NMEA sentences ──
    push('── RAW NMEA SENTENCES ──');
    if (gga) { push(gga); }
    if (rmc) { push(rmc, 'rmc'); }
    if (!gga && !rmc) { push('(none — the receiver sent nothing; see DIAGNOSIS)'); }
    push('');

    // ── Parse GGA fields ──
    if (gga) {
      push('── PARSED $GNGGA ──');
      const ggaParts = gga.split(',');
      // $GNGGA,time,lat,N/S,lng,E/W,quality,sats,hdop,alt,M,geoidal,M,age,refId*checksum
      if (ggaParts.length >= 15) {
        const time = ggaParts[1] || '—';
        const ggaLat = ggaParts[2] || '—';
        const ggaLatDir = ggaParts[3] || '';
        const ggaLng = ggaParts[4] || '—';
        const ggaLngDir = ggaParts[5] || '';
        const quality = ggaParts[6] || '—';
        const ggaSats = ggaParts[7] || '—';
        const ggaHdop = ggaParts[8] || '—';
        const ggaAlt = ggaParts[9] || '—';
        const altUnit = ggaParts[10] || 'M';
        const geoidal = ggaParts[11] || '—';

        const qualityMap: Record<string, string> = { '0': 'No fix', '1': 'GPS fix', '2': 'DGPS fix', '4': 'RTK fixed', '5': 'RTK float', '6': 'Estimated' };
        push(`  UTC Time     : ${time.slice(0,2)}:${time.slice(2,4)}:${time.slice(4,6)} UTC`);
        push(`  Latitude     : ${ggaLat} ${ggaLatDir}`);
        push(`  Longitude    : ${ggaLng} ${ggaLngDir}`);
        push(`  Fix Quality  : ${qualityMap[quality] ?? quality} (${quality})`);
        push(`  Satellites   : ${ggaSats}`);
        push(`  HDOP         : ${ggaHdop}`);
        push(`  Altitude     : ${ggaAlt} ${altUnit}`);
        push(`  Geoidal Sep  : ${geoidal} M`);
      }
      push('');
    }

    // ── Parse RMC fields ──
    if (rmc) {
      push('── PARSED $GNRMC ──', 'rmc');
      const rmcParts = rmc.split(',');
      // $GNRMC,time,status,lat,N/S,lng,E/W,speedKnots,course,date,magVar,magVarDir,mode*checksum
      if (rmcParts.length >= 12) {
        const time = rmcParts[1] || '—';
        const status = rmcParts[2] || '—';
        const rmcLat = rmcParts[3] || '—';
        const rmcLatDir = rmcParts[4] || '';
        const rmcLng = rmcParts[5] || '—';
        const rmcLngDir = rmcParts[6] || '';
        const speedKnots = rmcParts[7] || '—';
        const rmcCourse = rmcParts[8] || '—';
        const date = rmcParts[9] || '—';

        const statusLabel = status === 'A' ? 'Active (valid)' : status === 'V' ? 'Void (invalid)' : status;
        const knotsNum = parseFloat(speedKnots);
        const kmh = !isNaN(knotsNum) ? (knotsNum * 1.852).toFixed(1) : '—';

        push(`  UTC Time     : ${time.slice(0,2)}:${time.slice(2,4)}:${time.slice(4,6)} UTC`, 'rmc');
        push(`  Status       : ${statusLabel}`, 'rmc');
        push(`  Latitude     : ${rmcLat} ${rmcLatDir}`, 'rmc');
        push(`  Longitude    : ${rmcLng} ${rmcLngDir}`, 'rmc');
        push(`  Speed        : ${speedKnots} knots (${kmh} km/h)`, 'rmc');
        push(`  Course       : ${rmcCourse}°`, 'rmc');
        push(`  Date         : ${date.slice(0,2)}/${date.slice(2,4)}/20${date.slice(4,6)}`, 'rmc');
      }
      push('', 'rmc');
    }

    // ── Device-reported fields (from device_state columns) ──
    push('── DEVICE STATE FIELDS ──');
    push(`  Latitude     : ${lat != null ? lat.toFixed(6) : '—'}°`);
    push(`  Longitude    : ${lng != null ? lng.toFixed(6) : '—'}°`);
    push(`  Satellites   : ${sats != null ? sats : '—'}`);
    // Speed is only a measurement with a real fix; the indoor fallback has none.
    push(`  Speed        : ${
      gpsFix === true && gpsSimulated !== true && speed != null ? `${speed.toFixed(1)} km/h` : '—'
    }`);
    push(`  HDOP         : ${hdop ?? '—'}`);
    push(`  GPS Fix      : ${gpsFix === true ? '✅ YES' : gpsFix === false ? '❌ NO' : '—'}`);
    push(`  Simulated    : ${gpsSimulated === true ? '⚠ YES (indoor fallback)' : gpsSimulated === false ? 'No (real)' : '—'}`);
    push(`  Course       : ${course != null ? course.toFixed(1) + '°' : '—'}`);
    push(`  Altitude     : ${altitude != null ? altitude.toFixed(1) + ' m' : '—'}`);
    push(`  GPS Age      : ${gpsAgeMs != null ? gpsAgeMs + ' ms' : '—'}`);
    push('');

    // ── GPS Health ──
    push('── GPS UART HEALTH ──');
    push(`  Chars Rx     : ${gpsChars != null ? gpsChars.toLocaleString() : '—'}`);
    push(`  Sentences Rx : ${gpsSentences != null ? gpsSentences.toLocaleString() : '—'}`);
    push(`  Checksum Fail: ${gpsChecksumFail != null ? gpsChecksumFail : '—'}`);
    push('');

    // ── Diagnosis when the receiver sent nothing ────────────────────────────
    // There used to be a "REBUILT NMEA (from lat/lng)" block here that
    // manufactured $GNGGA/$GNRMC from whatever position the row held, with a
    // hard-coded fix quality of 1, HDOP 1.0, status A and invented checksums.
    // On a chair with no receiver — or one running the indoor fallback — that
    // printed a sentence asserting a real satellite fix at a position no
    // satellite ever supplied. A diagnostic panel that fabricates its own
    // evidence is worse than an empty one, so it is gone.
    //
    // What replaces it is the actual UART health, which distinguishes the
    // three failure modes an engineer needs to tell apart.
    if (!gga && !rmc) {
      push('── DIAGNOSIS ──');
      if (!gpsChars) {
        push('  No bytes received on the GPS UART.');
        push('  The receiver is absent or unpowered — check the wiring and the');
        push('  3V3/GND feed to the module. A live module streams once a second');
        push('  even with no satellites in view.');
      } else if (!gpsSentences) {
        push('  Bytes are arriving but no sentence passed its checksum.');
        push('  Usually a baud-rate mismatch or TX/RX swapped.');
      } else {
        push('  Sentences were received earlier but none is current.');
        push('  The link dropped after working — check the connector.');
      }
      push('');
    }

    push(`══════════ END · ${lines.length} lines ══════════`);

    setNmea(lines);
    setGpsFetching(false);
  }, [selectedId, gpsFetching]);

  const matches = useCallback((d: DeviceState, q: string, f: FilterKey): boolean => {
    if (f === 'low') {
      if ((d.batt_pct ?? 100) > 20) return false;
    } else if (f !== 'all' && statusOf(d, now) !== f) {
      return false;
    }
    if (q) {
      const hay = `${d.wheelchair_id} ${d.session_state} ${d.fw_version ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }, [now]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((d) => matches(d, q, filter));
  }, [sorted, query, filter, matches]);

  const sheetRows = useMemo(() => {
    const q = sheetQuery.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((d) => d.wheelchair_id.toLowerCase().includes(q));
  }, [sorted, sheetQuery]);

  const counts = useMemo(() => {
    let online = 0;
    let rented = 0;
    let available = 0;
    let attention = 0;
    for (const d of sorted) {
      if (isOnline(d, now)) online += 1;
      const s = statusOf(d, now);
      if (s === 'rented') rented += 1;
      else if (s === 'available') available += 1;
      else if (s === 'fault') attention += 1;
    }
    return { online, rented, available, attention, total: sorted.length };
  }, [sorted, now]);

  /* ---------------------------------------------------- emergency popup ---
     Fires on the TRANSITION into a fall, tamper or manual SOS — the things
     that mean someone may be hurt right now.
     Deliberately not on a bare SAFE_FAULT: a missing temperature probe holds
     that state indefinitely, and a dialog that is always up is one an operator
     learns to dismiss without reading. */
  const [alarmPopup, setAlarmPopup] = useState<{ id: string; cause: string; at: number } | null>(null);
  const seenEmergencies = useRef<Set<string>>(new Set<string>());

  useEffect(() => {
    const live = new Set<string>();
    for (const d of deviceStates) {
      if (!isOnline(d, now)) continue;
      const isFall = (d.tilt ?? 0) > FALL_TILT_DEG;
      const isTamper = d.tamper === true;
      if (!isFall && !isTamper) continue;
      live.add(d.wheelchair_id);
      if (!seenEmergencies.current.has(d.wheelchair_id)) {
        setAlarmPopup({
          id: d.wheelchair_id,
          cause: isFall ? `Fall detected — ${(d.tilt ?? 0).toFixed(0)}° tilt` : 'Tamper alarm latched',
          at: Date.now(),
        });
      }
    }
    // Drop chairs whose emergency ended, so a repeat incident alerts again.
    for (const id of Array.from(seenEmergencies.current)) {
      if (!live.has(id)) seenEmergencies.current.delete(id);
    }
    for (const id of Array.from(live)) seenEmergencies.current.add(id);
  }, [deviceStates, now]);

  /* Only offer images this chair can actually take.
     Every build carries its own DEVICE_ID and HMAC key, so there is one
     release row per chair per version. Listing all of them made four
     identical-looking "v1.2.2" entries and left the operator to guess which
     was theirs — the deploy guard caught the mismatch, but being asked to
     choose correctly between indistinguishable options is the actual bug.
     A null device_id means universal, so it stays offered. */
  const releasesForSelected = useMemo(
    () => fwReleases.filter((r) => !r.device_id || r.device_id === selectedId),
    [fwReleases, selectedId],
  );

  // Keep the selection valid when the operator switches chairs, otherwise a
  // release picked for the previous chair stays highlighted but is refused.
  useEffect(() => {
    if (selectedFwId && !releasesForSelected.some((r) => r.id === selectedFwId)) {
      setSelectedFwId(releasesForSelected[0]?.id ?? null);
    }
  }, [releasesForSelected, selectedFwId]);

  const activeCriticalFaults = useMemo(() => {
    return sorted.filter((d) => {
      if (!isOnline(d, now)) return false;
      if (silencedBanners.has(d.wheelchair_id)) return false;
      const isFall = (d.tilt ?? 0) > FALL_TILT_DEG;
      const isTamper = d.tamper === true;
      const isFault = d.session_state === 'SAFE_FAULT';
      return isFall || isTamper || isFault;
    });
  }, [sorted, now, silencedBanners]);

  /* --------------------------------------------------------- derived: map */
  // Every marker position goes through the smoother, so a chair that loses or
  // regains its satellite fix glides between provenances instead of jumping.
  // The operator is still told which provenance it is (chip below the map).
  // Resolved in an effect, not in render: the smoother holds per-chair blend
  // state, and a discarded/replayed render would advance it twice per tick.
  const smootherRef = useRef(new PositionSmoother());
  const [positions, setPositions] = useState<Map<string, ResolvedPosition>>(() => new Map());

  useEffect(() => {
    const out = new Map<string, ResolvedPosition>();
    for (const d of sorted) {
      const p = smootherRef.current.resolve(d, isOnline(d, now), now);
      if (p) out.set(d.wheelchair_id, p);
    }
    setPositions(out);
  }, [sorted, now]);

  const selectedPos = selected ? positions.get(selected.wheelchair_id) ?? null : null;

  const mapUnits = useMemo<MapUnit[]>(() => {
    // A chair with no resolved position is genuinely un-locatable (online but
    // never fixed this power cycle). Drawing it anywhere would be a guess, so
    // it is omitted from the map entirely and reported as "No position".
    const placed = (u: MapUnit): MapUnit | null => {
      const p = positions.get(u.id);
      return p ? { ...u, lat: p.lat, lng: p.lng } : null;
    };
    // HANDOFF caps the fleet map at ~70 markers in view.
    const base = toUnits(filtered, now)
      .map(placed)
      .filter((u): u is MapUnit => u !== null)
      .slice(0, 70);
    if (selected && !base.some((u) => u.id === selected.wheelchair_id)) {
      const u = toUnit(selected, now);
      const p = u ? placed(u) : null;
      if (p) base.push(p);
    }
    return base;
  }, [filtered, selected, now, positions]);

  const center = useMemo<[number, number]>(() => {
    if (selectedPos) return [selectedPos.lat, selectedPos.lng];
    const anyFix = sorted.find((d) => d.lat != null && d.lng != null);
    if (anyFix && anyFix.lat != null && anyFix.lng != null) return [anyFix.lat, anyFix.lng];
    return [21.4225, 39.8262];
  }, [selectedPos, sorted]);

  /* ------------------------------------------------- named geofence zones */
  const { zones, reload: reloadZones } = useGeofences();
  const [zoneEditId, setZoneEditId] = useState<string | null>(null);
  const [zoneDraft, setZoneDraft] = useState<ZoneDraft | null>(null);
  const [zoneBusy, setZoneBusy] = useState(false);
  const [zoneError, setZoneError] = useState<string | null>(null);

  const beginNewZone = useCallback(() => {
    // Start it at the map centre so it is visible immediately; the operator
    // then clicks the map to place it precisely.
    setZoneError(null);
    setZoneEditId(null);
    setZoneDraft({
      id: `draft-${Date.now()}`,
      name: '',
      lat: center[0],
      lng: center[1],
      radiusM: 300,
      color: ZONE_COLORS[zones.length % ZONE_COLORS.length],
      isNew: true,
    });
  }, [center, zones.length]);

  const beginEditZone = useCallback((z: Geofence) => {
    setZoneError(null);
    setZoneEditId(z.id);
    setZoneDraft({
      id: z.id,
      name: z.name,
      lat: z.center_lat,
      lng: z.center_lng,
      radiusM: z.radius_m,
      color: z.color,
      isNew: false,
    });
  }, []);

  const cancelZoneDraft = useCallback(() => {
    setZoneDraft(null);
    setZoneEditId(null);
    setZoneError(null);
  }, []);

  const saveZoneDraft = useCallback(async () => {
    if (!zoneDraft || zoneBusy) return;
    const name = zoneDraft.name.trim();
    if (!name) {
      setZoneError('Give the zone a name so it is recognisable on the rider map.');
      return;
    }
    setZoneBusy(true);
    setZoneError(null);
    const row = {
      name,
      center_lat: zoneDraft.lat,
      center_lng: zoneDraft.lng,
      radius_m: zoneDraft.radiusM,
      color: zoneDraft.color,
    };
    const { error } = zoneDraft.isNew
      ? await supabase.from('geofences').insert(row)
      : await supabase
          .from('geofences')
          .update({ ...row, updated_at: new Date().toISOString() })
          .eq('id', zoneDraft.id);
    setZoneBusy(false);
    if (error) {
      setZoneError(error.message);
      return;
    }
    setZoneDraft(null);
    setZoneEditId(null);
    await reloadZones();
  }, [zoneDraft, zoneBusy, reloadZones]);

  const deleteZone = useCallback(
    async (z: Geofence) => {
      if (zoneBusy) return;
      if (!window.confirm(`Delete the zone "${z.name}"? Riders will stop seeing it.`)) return;
      setZoneBusy(true);
      const { error } = await supabase.from('geofences').delete().eq('id', z.id);
      setZoneBusy(false);
      if (error) {
        setZoneError(error.message);
        return;
      }
      if (zoneEditId === z.id) cancelZoneDraft();
      await reloadZones();
    },
    [zoneBusy, zoneEditId, cancelZoneDraft, reloadZones],
  );

  const onMapPoint = useCallback((lat: number, lng: number) => {
    setZoneDraft((d) => (d ? { ...d, lat, lng } : d));
  }, []);

  const gf = selected?.geofence ?? null;
  // A breach is a LIVE condition. Without the freshness guard an offline chair
  // kept raising the red "Geofence breach" banner from whatever it last
  // reported — which could be days old and is not something we can still know.
  const breach =
    selected != null
    && isOnline(selected, now)
    && gf != null
    && Boolean(gf.on)
    && gf.in === 0;

  // Motion facts for the breach alert. Speed is null without a fix, so the
  // stationary judgement falls back to the IMU rather than reading absence
  // of GPS speed as "stopped".
  const breachSpeed = realSpeedKmh(selected);
  const breachStationary = isStationary(selected);

  // Which NAMED zone the chair has left, so the alert can say where rather
  // than just quoting a radius.
  const breachZone = useMemo(() => {
    if (!breach || !selectedPos) return null;
    return nearestZone(selectedPos.lat, selectedPos.lng, zones);
  }, [breach, selectedPos, zones]);

  // Named zones drawn on the map. While a zone is being edited its live
  // (unsaved) geometry is previewed in place of the stored one.
  const mapZones = useMemo<MapZone[]>(() => {
    const list = zones
      .filter((z) => z.active)
      .map<MapZone>((z) => ({
        id: z.id,
        name: z.name,
        lat: z.center_lat,
        lng: z.center_lng,
        radiusM: z.radius_m,
        color: z.color,
        editing: z.id === zoneEditId,
      }));
    if (zoneDraft) {
      const idx = list.findIndex((z) => z.id === zoneDraft.id);
      const preview: MapZone = {
        id: zoneDraft.id,
        name: zoneDraft.name || 'New zone',
        lat: zoneDraft.lat,
        lng: zoneDraft.lng,
        radiusM: zoneDraft.radiusM,
        color: zoneDraft.color,
        editing: true,
      };
      if (idx >= 0) list[idx] = preview;
      else list.push(preview);
    }
    return list;
  }, [zones, zoneEditId, zoneDraft]);

  const mapState = useMemo<MapState>(
    () => ({
      center,
      zoom: 16,
      units: mapUnits,
      fence: fencePolygon(selected),
      zones: mapZones,
      pickPoint: Boolean(zoneDraft),
      breach,
      activeId: selectedId,
      theme: theme === 'dark' ? 'dark' : 'light',
      markerStyle: 'arrow',
      follow: false,
      recenter,
    }),
    [center, mapUnits, selected, mapZones, zoneDraft, breach, selectedId, theme, recenter]
  );

  /* ------------------------------------------------------ derived: health */
  // "Online" is REAL: telemetry freshness (ts within OFFLINE_AFTER_MS), not
  // the sticky device_state.online column. A chair that stops reporting goes
  // offline here within seconds, and its stale sensor data is masked.
  const fresh = selected ? isOnline(selected, now) : false;
  const rssi = selected && fresh ? selected.rssi ?? null : null;
  // Only while the chair is actually reachable. A stale SSID from hours ago
  // would read as "currently on this network", which is exactly the wrong
  // conclusion when a chair has dropped off the air.
  const ssid = selected && fresh ? selected.ssid?.trim() || null : null;
  const barColor = (n: number): string =>
    rssi != null && rssi > -95 + n * 14 ? 'var(--ink)' : 'color-mix(in srgb, var(--ink) 20%, transparent)';

  const chairStatus: ChairStatus = selected ? statusOf(selected, now) : 'offline';
  const statusMeta = STATUS_META[chairStatus];

  /* ------------------------------------------------------------- commands */
  const loadRentals = useCallback(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    if (!url || url.includes('YOUR-PROJECT') || url.includes('placeholder-project')) {
      setRentalsError('Supabase is not configured, so rental history is unavailable.');
      setRentalsLoaded(true);
      return;
    }
    const { data, error: err } = await supabase
      .from('rentals')
      .select('id, wheelchair_id, state, start_at, end_at, duration_s, created_at')
      .order('created_at', { ascending: false })
      .limit(40);
    if (err) {
      setRentalsError(err.message);
      setRentals([]);
    } else {
      setRentalsError(null);
      setRentals((data as RentalRow[]) || []);
    }
    setRentalsLoaded(true);
  }, []);

  const run = useCallback(
    async (cmd: string, args: Record<string, unknown> = {}) => {
      const id = selectedIdRef.current;
      if (!id) {
        setAck({ cmd, ok: false, text: 'Select a chair before issuing a command.', at: Date.now() });
        return;
      }
      if (pendingRef.current) return;
      pendingRef.current = cmd;
      setPending(cmd);
      setAck(null);
      const res = await sendCommand(id, cmd, args);
      pendingRef.current = null;
      setPending(null);
      setAck({
        cmd,
        ok: res.ok,
        text: res.ok
          ? `${shortId(id)} acknowledged ${cmd}.`
          : res.message || 'The chair did not answer. Nothing was changed.',
        at: Date.now(),
      });
      // Only reflect a state change the device actually confirmed.
      if (res.ok && cmd === 'SOS') setEstopEngaged(true);
      if (res.ok && cmd === 'CLEAR_SOS') setEstopEngaged(false);
      if (res.ok && (cmd === 'UNLOCK' || cmd === 'END_SESSION')) void loadRentals();
    },
    [loadRentals]
  );

  /* --------------------------------------------------- maintenance mode ---
     Unlike every other control on this page this is NOT a device command: it
     is a fleet decision recorded in Postgres, so there is no ack to wait for.
     It takes effect for riders the moment the row changes, via the same
     Realtime subscription that feeds this console. */
  const toggleService = useCallback(
    async (outOfService: boolean, note: string) => {
      const id = selectedIdRef.current;
      if (!id) return;
      setServiceBusy(true);
      const res = await setServiceMode(id, outOfService, note);
      setServiceBusy(false);
      setAck({
        cmd: 'SERVICE_MODE',
        ok: res.ok,
        text: res.ok
          ? outOfService
            ? `${shortId(id)} withdrawn from service. Riders can no longer take it.`
            : `${shortId(id)} returned to service and is offerable again.`
          : res.message || 'Could not change the service state.',
        at: Date.now(),
      });
      if (res.ok) setServiceNote('');
    },
    []
  );

  // Name the operator on arrival, then clear it so the console is not
  // permanently carrying a greeting bar.
  useEffect(() => {
    if (!displayName) return;
    setWelcome(displayName);
    const t = setTimeout(() => setWelcome(''), 6000);
    return () => clearTimeout(t);
  }, [displayName]);

  // Push a zone to the selected chair as its enforced perimeter. The device
  // still only REPORTS a breach — it never locks itself for leaving one.
  // (Declared after `run`, which it dispatches through.)
  const applyZoneToChair = useCallback(
    (z: Geofence) => {
      if (!selectedId) {
        setZoneError('Select a chair first.');
        return;
      }
      setZoneError(null);
      void run('SET_GEOFENCE', { lat: z.center_lat, lng: z.center_lng, radius: z.radius_m });
    },
    [selectedId, run],
  );

  /* ------------------------------------------------------------- rentals  */
  useEffect(() => {
    if (tab !== 'rides') return;
    void loadRentals();
    const id = window.setInterval(() => void loadRentals(), 20_000);
    return () => window.clearInterval(id);
  }, [tab, loadRentals]);

  const openRental = useMemo(
    () => rentals.find((r) => r.wheelchair_id === selectedId && !r.end_at && OPEN_STATES.has(r.state)) ?? null,
    [rentals, selectedId]
  );

  const sessionActive = Boolean(selected && ['ACTIVE', 'EXPIRING', 'ENDING'].includes(selected.session_state));

  const elapsedSec = useMemo(() => {
    if (openRental?.start_at) {
      const start = Date.parse(openRental.start_at);
      if (!Number.isNaN(start)) return Math.max(0, (now - start) / 1000);
    }
    // Fall back to what the device itself reports: granted duration minus the
    // time it says is left.
    if (selected && selected.time_left != null && openRental?.duration_s != null) {
      return Math.max(0, openRental.duration_s - selected.time_left);
    }
    return 0;
  }, [openRental, selected, now]);

  const liveFee = estimateFee(elapsedSec);

  const revenue = useMemo(() => {
    const todays = rentals.filter((r) => isToday(r.end_at ?? r.start_at ?? r.created_at));
    const total = todays.reduce((n, r) => n + estimateFee(rentalSeconds(r, now)), 0);
    const avgMin =
      rentals.length === 0 ? 0 : rentals.reduce((n, r) => n + rentalSeconds(r, now), 0) / rentals.length / 60;
    const util = counts.total === 0 ? 0 : Math.round((counts.rented / counts.total) * 100);
    return { total, rides: todays.length, avgMin, util };
  }, [rentals, now, counts]);

  /* -------------------------------------------------------------- alerts  */
  const unacked = useMemo(() => events.filter((e) => !acked.has(String(e.id))).length, [events, acked]);

  const ackOne = useCallback((id: string) => {
    setAcked((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const ackAll = useCallback(() => {
    setAcked(new Set(events.map((e) => String(e.id))));
  }, [events]);

  const logRows = useMemo(() => {
    const q = logQuery.trim().toLowerCase();
    return events
      .filter((e) => {
        const level = SEV_LEVEL[severityOf(e.type)];
        if (logLevel !== 'ALL' && level !== logLevel) return false;
        if (q && !`${e.wheelchair_id} ${e.type} ${logMessage(e)}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .slice(0, 120);
  }, [events, logQuery, logLevel]);

  /* ------------------------------------------------------------ incidents */
  const incidents = useMemo(() => liveIncidents(deviceStates, now), [deviceStates, now]);
  const liveKeys = useMemo(() => new Set(incidents.map((i) => i.key)), [incidents]);
  const visibleIncidents = useMemo(() => incidents.filter((i) => !dismissed.has(i.key)), [incidents, dismissed]);

  // A dismissed incident should come back if the condition re-fires later, so
  // prune keys once the device stops asserting them (only after deviceStates has loaded).
  useEffect(() => {
    if (deviceStates.length === 0) return;
    const prune = (prev: ReadonlySet<string>): ReadonlySet<string> => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((k) => {
        if (liveKeys.has(k)) next.add(k);
        else changed = true;
      });
      return changed ? next : prev;
    };
    setDismissed(prune);
    setSilenced(prune);
  }, [liveKeys, deviceStates]);

  /* ------------------------------------------------------- alarm audio    */
  // Browsers block autoplay: the AudioContext is only created once the
  // operator has actually interacted with the page.
  useEffect(() => {
    const arm = () => {
      if (audioRef.current) return;
      const w = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return;
      try {
        const ctx = new Ctor();
        void ctx.resume();
        audioRef.current = ctx;
      } catch {
        audioRef.current = null;
      }
    };
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };
  }, []);

  useEffect(() => {
    return () => {
      const ctx = audioRef.current;
      audioRef.current = null;
      if (ctx) void ctx.close().catch(() => {});
    };
  }, []);

  // Beep once per NEW critical incident.
  useEffect(() => {
    const prev = seenIncidentKeys.current;
    const arrived: string[] = [];
    liveKeys.forEach((k) => {
      if (!prev.has(k)) arrived.push(k);
    });
    seenIncidentKeys.current = new Set(liveKeys);
    if (arrived.length === 0 || muted) return;
    const audible = arrived.some((k) => !silenced.has(k) && !dismissed.has(k));
    if (!audible) return;
    const ctx = audioRef.current;
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.setValueAtTime(0, t + 0.18);
      gain.gain.setValueAtTime(0.05, t + 0.3);
      gain.gain.setValueAtTime(0, t + 0.48);
      osc.start(t);
      osc.stop(t + 0.55);
    } catch {
      /* audio unavailable — the visual stack is the primary signal */
    }
  }, [liveKeys, muted, silenced, dismissed]);

  /* ------------------------------------------------------------ NMEA feed */
  // Synthesised from the REAL lat/lng/speed/sats/hdop of the selected chair,
  // and only while the chair tab is on screen (HANDOFF: never stream NMEA
  // when nobody is looking at it).
  useEffect(() => {
    if (tab !== 'unit' || !selectedId) {
      setNmea([]);
      return;
    }
    setNmea([]);
    const emit = () => {
      const d = selectedRef.current;
      if (!d || d.lat == null || d.lng == null) return;
      // A disconnected chair has no GPS stream — synthesising sentences from
      // its stale coordinates would be simulation, which this console never does.
      if (!isOnline(d)) return;
      // Nor does a chair without a REAL satellite fix. Without this the
      // terminal was encoding the device's indoor fallback wander as NMEA,
      // which reads as raw receiver output but is not.
      if (d.gps_fix !== true || d.gps_simulated === true) return;
      const when = new Date();
      const hhmmss =
        [when.getUTCHours(), when.getUTCMinutes(), when.getUTCSeconds()]
          .map((n) => String(n).padStart(2, '0'))
          .join('') + '.00';
      const ddmmyy = [when.getUTCDate(), when.getUTCMonth() + 1, when.getUTCFullYear() % 100]
        .map((n) => String(n).padStart(2, '0'))
        .join('');
      const ns = d.lat >= 0 ? 'N' : 'S';
      const ew = d.lng >= 0 ? 'E' : 'W';
      const sats = d.sats ?? 0;
      const hdop = (d.hdop ?? 0).toFixed(1);
      const knots = ((d.speed ?? 0) / 1.852).toFixed(1);
      const course = (d.yaw ?? 0).toFixed(1);
      const gga = nmeaSentence(
        `GNGGA,${hhmmss},${dm(d.lat, true)},${ns},${dm(d.lng, false)},${ew},${sats > 0 ? 1 : 0},${String(sats).padStart(2, '0')},${hdop},,M,,M,,`
      );
      const rmc = nmeaSentence(
        `GNRMC,${hhmmss},${sats > 0 ? 'A' : 'V'},${dm(d.lat, true)},${ns},${dm(d.lng, false)},${ew},${knots},${course},${ddmmyy},,,A`
      );
      nmeaSeq.current += 1;
      const seq = nmeaSeq.current;
      setNmea((prev) =>
        [
          { key: `r${seq}`, line: rmc, kind: 'rmc' as const },
          { key: `g${seq}`, line: gga, kind: 'gga' as const },
        ]
          .concat(prev)
          .slice(0, NMEA_MAX)
      );
    };
    emit();
    const id = window.setInterval(emit, 1000);
    return () => window.clearInterval(id);
  }, [tab, selectedId]);

  /* ------------------------------------------------------------- actions  */
  const pickChair = useCallback((id: string) => {
    setSelectedId(id);
    setRecenter(Date.now());
  }, []);

  const openChairTab = useCallback(
    (id: string) => {
      pickChair(id);
      setTab('unit');
    },
    [pickChair]
  );

  const dismissIncident = useCallback((key: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const silenceIncident = useCallback((key: string) => {
    setSilenced((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const dismissAllIncidents = useCallback(() => {
    setDismissed(new Set(liveKeys));
  }, [liveKeys]);

  /* ------------------------------------------------------------ layout    */
  const grid2 = wide ? '1.45fr 1fr' : '1fr';
  const grid3 = wide ? '1fr 1fr 1fr' : '1fr';
  const mapH = wide ? 520 : 330;
  const listH = wide ? 470 : 340;
  const stackTop = (wide ? 84 : 152) + (breach ? 44 : 0);

  const diag = useMemo(() => buildDiag(selected, fresh), [selected, fresh]);

  // Offer the override only when something is actually blocking the chair, and
  // only for faults an override may legitimately address. A measured hazard is
  // still refused by the device itself — this just avoids dangling a button
  // that can never work.
  const overrideActiveS = selected?.maint_override_s ?? 0;
  const hasBlockingFault = Boolean(
    selected
    && fresh
    && selected.session_state === 'SAFE_FAULT'
    && diag.some((r) => r.state === 'FAIL'),
  );

  const battPct = selected?.batt_pct ?? null;
  const battColor = battPct == null ? 'var(--muted)' : battPct < 25 ? RED : battPct < 55 ? AMBER : GREEN;
  const battOffset = (326.7 * (1 - (battPct ?? 0) / 100)).toFixed(1);

  const tempMotor = selected?.temp_motor ?? null;
  const tempColor = tempMotor == null ? 'var(--ink)' : tempMotor >= 55 ? RED : tempMotor >= 45 ? AMBER : 'var(--ink)';

  const pitch = selected?.pitch ?? 0;
  const roll = selected?.roll ?? 0;
  const tilt = selected?.tilt ?? 0;

  const otaProgress = clamp(selected?.ota_progress ?? 0, 0, 100);
  const otaStatus = selected?.ota_status ?? null;
  const otaBusy =
    Boolean(otaStatus && !['idle', 'none', 'done', 'success', 'failed', 'error'].includes(otaStatus.toLowerCase())) ||
    (otaProgress > 0 && otaProgress < 100);
  const fwVersion = selected?.fw_version ?? null;
  const targetVersion = selected?.target_version ?? null;
  const otaUpToDate = !targetVersion || targetVersion === fwVersion;

  const busy = pending !== null;

  /* ======================================================================= */
  /* render                                                                  */
  /* ======================================================================= */

  return (
    <div style={{ minHeight: '100vh', background: 'var(--app-bg)', color: 'var(--ink)', overflowX: 'hidden' }}>
      {/* ------------------------------------------------------------ header */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'var(--nav-bg)',
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
          borderBottom: '1px solid var(--hair)',
        }}
      >
        <div
          style={{
            maxWidth: 1320,
            margin: '0 auto',
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              fontFamily: 'var(--font-heading)',
              fontSize: 17,
              letterSpacing: '-.01em',
            }}
          >
            <span>
              <span style={{ fontWeight: 500 }}>zetta</span>
              <span style={{ fontWeight: 800 }}>might</span>
            </span>
            <span style={{ fontWeight: 800, color: 'var(--accent)' }}>ops</span>
          </span>

          {tab !== 'fleet' ? (
            <button
              type="button"
              onClick={() => setTab('fleet')}
              aria-label="Back to the fleet map"
              style={{
                flex: 'none',
                width: 42,
                height: 42,
                border: '1px solid var(--hair)',
                borderRadius: 999,
                background: 'transparent',
                color: 'var(--ink)',
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
              }}
            >
              <Svg size={20} width={2.2}>
                {ICON.back}
              </Svg>
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              setSheetQuery('');
              setFleetSheetOpen(true);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              minHeight: 42,
              padding: '0 14px',
              border: '1px solid var(--hair)',
              borderRadius: 999,
              background: 'transparent',
              color: 'var(--ink)',
              fontSize: 13.5,
              fontWeight: 700,
              cursor: 'pointer',
              maxWidth: '44%',
            }}
          >
            <span
              style={{ width: 8, height: 8, borderRadius: 999, background: statusMeta.dot, flex: 'none' }}
              aria-hidden="true"
            />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {selected ? selected.wheelchair_id : 'No chair'}
            </span>
            <Svg size={15} width={2.2}>
              {ICON.chevronDown}
            </Svg>
          </button>

          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
            }}
          >
            {/* Network name, to the LEFT of the signal bars. Strength alone
                cannot answer "is it on the right WiFi?" — a strong bar on the
                wrong SSID looks the same as a strong bar on the right one.
                Rendered only when the chair actually reported one: firmware
                older than 1.3.5 never sent it, and inventing a name would be
                worse than showing nothing. */}
            {ssid ? (
              <span
                className="deskonly"
                title={`Joined to “${ssid}”`}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--muted)',
                  maxWidth: 120,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {ssid}
              </span>
            ) : null}
            <span
              style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 16 }}
              title={rssi == null ? 'No uplink' : `${rssi} dBm${ssid ? ` on “${ssid}”` : ''}`}
            >
              <span style={{ width: 3, height: 5, borderRadius: 2, background: barColor(1) }} />
              <span style={{ width: 3, height: 8, borderRadius: 2, background: barColor(2) }} />
              <span style={{ width: 3, height: 12, borderRadius: 2, background: barColor(3) }} />
              <span style={{ width: 3, height: 16, borderRadius: 2, background: barColor(4) }} />
            </span>
            <span className="deskonly" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
              {rssi == null ? '— dBm' : `${rssi} dBm`}
            </span>

            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '8px 13px',
                borderRadius: 999,
                background: fresh ? 'var(--tint-bg)' : 'color-mix(in srgb, var(--ink) 7%, transparent)',
                color: fresh ? 'var(--accent)' : 'var(--muted)',
                fontSize: 12.5,
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: 'currentColor',
                  animation: fresh ? 'beat 1.6s ease-in-out infinite' : 'none',
                }}
              />
              {fresh ? 'live' : 'stale'}
            </span>

            <button
              type="button"
              onClick={toggle}
              aria-label="Switch theme"
              style={{
                width: 42,
                height: 42,
                border: '1px solid var(--hair)',
                borderRadius: 999,
                background: 'transparent',
                color: 'var(--ink)',
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
              }}
            >
              <Svg size={18} width={1.9}>
                {ICON.sun}
              </Svg>
            </button>

            {displayName ? (
              <button
                type="button"
                onClick={() => {
                  void signOut().then(() => router.replace('/'));
                }}
                title={`Signed in as ${displayName} — sign out`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 42,
                  padding: '0 13px',
                  border: '1px solid var(--hair)',
                  borderRadius: 999,
                  background: 'transparent',
                  color: 'var(--ink)',
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    flex: 'none',
                    display: 'grid',
                    placeItems: 'center',
                    background: 'var(--accent)',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                  aria-hidden="true"
                >
                  {displayName.charAt(0).toUpperCase()}
                </span>
                <span className="deskonly" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span>{displayName}</span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}>(sign out)</span>
                </span>
              </button>
            ) : null}

            <HoldButton
              onComplete={() => void run(estopEngaged ? 'CLEAR_SOS' : 'SOS')}
              disabled={!selected || busy}
              fill="rgba(255,255,255,.32)"
              ariaLabel={estopEngaged ? 'Hold to clear the emergency stop' : 'Hold for emergency stop'}
              style={{
                minHeight: 42,
                padding: '0 16px',
                borderRadius: 999,
                background: estopEngaged ? 'var(--accent)' : 'var(--tint-bg)',
                color: estopEngaged ? '#fff' : 'var(--accent)',
                fontSize: 13,
                fontWeight: 800,
                whiteSpace: 'nowrap',
              }}
            >
              {(holding) => (
                <span style={{ whiteSpace: 'nowrap' }}>
                  {holding ? 'Hold…' : estopEngaged ? 'Stop active — hold to clear' : 'Hold for emergency stop'}
                </span>
              )}
            </HoldButton>
          </div>
        </div>

        {/* ---- Emergency popup ------------------------------------------
            Two distinct actions on purpose. "Silence" stops the siren and
            nothing else; the chair stays cut out. "Clear" releases every
            latch, which is what actually lets the chair move again — so it
            reads as the heavier action, because it is. */}
        {alarmPopup ? (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Emergency alarm"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1000,
              background: 'rgba(0,0,0,.6)',
              backdropFilter: 'blur(3px)',
              display: 'grid',
              placeItems: 'center',
              padding: 20,
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: 460,
                borderRadius: 24,
                background: 'var(--app-bg)',
                border: `2px solid ${RED}`,
                boxShadow: '0 24px 60px rgba(0,0,0,.5)',
                overflow: 'hidden',
              }}
            >
              <div style={{ background: RED, color: '#fff', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  style={{ width: 12, height: 12, borderRadius: 999, background: '#fff', flex: 'none', animation: 'beat .8s ease-in-out infinite' }}
                  aria-hidden="true"
                />
                <span style={{ fontSize: 17, fontWeight: 800 }}>Emergency · {alarmPopup.id}</span>
              </div>

              <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <span style={{ fontSize: 19, fontWeight: 800, color: 'var(--ink)' }}>{alarmPopup.cause}</span>

                {(() => {
                  const d = deviceStates.find((x) => x.wheelchair_id === alarmPopup.id);
                  const spd = realSpeedKmh(d);
                  const muted = d?.alarm_silenced === true;
                  return (
                    <>
                      <span style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55 }}>
                        The chair has cut its own motion relay and is sounding its siren.
                        {d?.lat != null && d?.lng != null
                          ? ` Last position ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}.`
                          : ' No position available.'}
                        {spd != null ? ` Moving at ${spd.toFixed(1)} km/h.` : ''}
                      </span>
                      {muted ? (
                        <span style={{ fontSize: 13, fontWeight: 700, color: AMBER }}>
                          Siren muted — the chair is still cut out.
                        </span>
                      ) : null}
                    </>
                  );
                })()}

                <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => {
                      setSelectedId(alarmPopup.id);
                      void run('SILENCE_ALARM');
                    }}
                    disabled={busy}
                    style={{
                      flex: '1 1 130px',
                      minHeight: 50,
                      borderRadius: 999,
                      border: '1px solid var(--hair)',
                      background: 'transparent',
                      color: 'var(--ink)',
                      fontSize: 14.5,
                      fontWeight: 800,
                      cursor: busy ? 'progress' : 'pointer',
                    }}
                  >
                    {pending === 'SILENCE_ALARM' ? 'Silencing…' : '🔇 Silence siren'}
                  </button>
                  <button
                    onClick={() => {
                      setSelectedId(alarmPopup.id);
                      void run('CLEAR_SOS');
                    }}
                    disabled={busy}
                    style={{
                      flex: '1 1 130px',
                      minHeight: 50,
                      borderRadius: 999,
                      border: 0,
                      background: RED,
                      color: '#fff',
                      fontSize: 14.5,
                      fontWeight: 800,
                      cursor: busy ? 'progress' : 'pointer',
                    }}
                  >
                    {pending === 'CLEAR_SOS' ? 'Clearing…' : 'Clear alarm'}
                  </button>
                </div>

                {/* Freeing the wheels during an emergency is the point of the
                    relay: after a fall the chair has cut its own motion relay,
                    so it can neither drive nor be pushed until the brake is
                    released. Offered only on a chair that reports the hardware,
                    and only while the brake is actually engaged. */}
                {(() => {
                  const d = deviceStates.find((x) => x.wheelchair_id === alarmPopup.id);
                  if (d?.has_emg_unlock !== true) return null;
                  if (d.emg_unlock === true) {
                    return (
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: AMBER, lineHeight: 1.5 }}>
                        Wheels are free — the chair can be pushed clear. Lock it again from the
                        chair panel when you are done.
                      </span>
                    );
                  }
                  return (
                    <HoldButton
                      onComplete={() => {
                        setSelectedId(alarmPopup.id);
                        void run('EMERGENCY_UNLOCK');
                      }}
                      disabled={busy}
                      fill="rgba(255,86,60,.30)"
                      ariaLabel="Hold to release the wheel brake so the chair can be pushed"
                      style={{
                        minHeight: 48,
                        borderRadius: 999,
                        border: `1px solid ${RED}`,
                        background: 'rgba(255,86,60,.10)',
                        color: RED,
                        fontSize: 13.5,
                        fontWeight: 800,
                      }}
                    >
                      {(holding) => (
                        <span style={{ whiteSpace: 'nowrap' }}>
                          {pending === 'EMERGENCY_UNLOCK'
                            ? 'Releasing…'
                            : holding
                              ? 'Hold…'
                              : '🔓 Hold to free the wheels'}
                        </span>
                      )}
                    </HoldButton>
                  );
                })()}

                <button
                  onClick={() => {
                    setSelectedId(alarmPopup.id);
                    setTab('fleet');
                    setAlarmPopup(null);
                  }}
                  style={{
                    minHeight: 42,
                    border: 0,
                    background: 'transparent',
                    color: 'var(--muted)',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Close and open this chair
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5, textAlign: 'center' }}>
                  Silencing stops the sound only. Clearing releases the motion cut — do that
                  once the chair is upright and the rider is safe.
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {/* emergency critical alert banner */}
        {activeCriticalFaults.length > 0 ? (
          <div
            style={{
              background: '#dc2626',
              color: '#fff',
              padding: '12px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              boxShadow: '0 4px 20px rgba(220, 38, 38, 0.4)',
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: '#fff',
                flex: 'none',
                animation: 'beat 0.8s ease-in-out infinite',
              }}
            />
            <span style={{ fontWeight: 800, fontSize: 14, flex: 'none' }}>
              🚨 CRITICAL ALARM ({activeCriticalFaults.length}):
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, flex: '1 1 240px', minWidth: 0 }}>
              {activeCriticalFaults.map((chair) => {
                const isFall = (chair.tilt ?? 0) > FALL_TILT_DEG;
                const isTamper = chair.tamper === true;
                const label = isFall
                  ? `FALL DETECTED (${(chair.tilt ?? 0).toFixed(0)}° tilt)`
                  : isTamper
                    ? 'TAMPER ALARM LATCHED'
                    : 'SAFETY INTERLOCK CUT';
                return `${chair.wheelchair_id}: ${label}`;
              }).join(' | ')}
            </span>
            <div style={{ display: 'flex', gap: 8, flex: 'none', flexWrap: 'wrap' }}>
              {activeCriticalFaults.map((chair) => (
                <button
                  key={chair.wheelchair_id}
                  type="button"
                  onClick={() => {
                    setSelectedId(chair.wheelchair_id);
                    setSilencedBanners((prev) => {
                      const next = new Set(prev);
                      next.add(chair.wheelchair_id);
                      return next;
                    });
                    void run('CLEAR_SOS');
                    void supabase.from('device_state').update({ session_state: 'LOCKED' }).eq('wheelchair_id', chair.wheelchair_id);
                  }}
                  disabled={busy}
                  style={{
                    minHeight: 36,
                    padding: '0 14px',
                    borderRadius: 999,
                    border: '1px solid #fff',
                    background: '#fff',
                    color: '#dc2626',
                    fontSize: 12.5,
                    fontWeight: 800,
                    cursor: busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  Silence & Clear {shortId(chair.wheelchair_id)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* geofence breach bar */}
        {breach ? (
          <div
            style={{
              background: 'var(--accent)',
              color: '#fff',
              padding: '10px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 999,
                background: '#fff',
                flex: 'none',
                animation: 'blink 1s steps(1) infinite',
              }}
            />
            <span style={{ fontWeight: 800, fontSize: 13, flex: 'none' }}>Left the zone</span>
            <span
              style={{
                fontSize: 12.5,
                opacity: 0.94,
                minWidth: 0,
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                alignItems: 'baseline',
              }}
            >
              <span style={{ fontWeight: 700 }}>{selected ? selected.wheelchair_id : 'A chair'}</span>
              {/* Speed matters most here: it decides whether locking is even
                  safe. The chair is NOT stopped automatically — a moving
                  wheelchair that locks could throw its rider. */}
              {/* Speed only when it is a real measurement. Indoors there is
                  no GPS speed, so movement is reported from the IMU instead of
                  quietly showing a reassuring 0.0. */}
              <span style={{ fontFamily: MONO }}>
                {breachSpeed !== null ? `${breachSpeed.toFixed(1)} km/h` : 'speed unknown'}
                {breachStationary === null
                  ? ' — motion unknown'
                  : breachStationary
                    ? ' — stopped'
                    : ' — moving'}
              </span>
              <span style={{ fontFamily: MONO }}>
                {selectedPos ? `${selectedPos.lat.toFixed(5)}, ${selectedPos.lng.toFixed(5)}` : 'position unknown'}
              </span>
              <span style={{ opacity: 0.85 }}>
                {breachZone
                  ? `${Math.round(breachZone.metresOutside)} m outside “${breachZone.zone.name}”`
                  : `${num(gf?.dist ?? null, 0, ' m')} from a ${num(gf?.r ?? null, 0, ' m')} perimeter`}
              </span>
            </span>

            <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => void run('PING')}
                disabled={busy}
                title="Sound the chair's buzzer to get the rider's attention"
                style={breachBtn('#fff', 'var(--accent)', busy)}
              >
                Siren
              </button>
              {/* Deliberately NOT automatic: the operator decides, and the
                  wording tells them when it is unsafe. */}
              <button
                type="button"
                onClick={() => void run('LOCK')}
                disabled={busy}
                title={
                  breachStationary === false
                    ? 'The chair is still moving — locking now is unsafe'
                    : breachStationary === null
                      ? 'The chair cannot confirm it has stopped — locking may be unsafe'
                      : 'Lock the chair where it stands'
                }
                style={breachBtn(
                  breachStationary === true ? '#fff' : 'rgba(255,255,255,.32)',
                  breachStationary === true ? 'var(--accent)' : '#fff',
                  busy,
                )}
              >
                {breachStationary === false
                  ? 'Lock (moving!)'
                  : breachStationary === null
                    ? 'Lock (unconfirmed)'
                    : 'Lock'}
              </button>
              <button
                type="button"
                onClick={() => void run('UNLOCK', { duration_s: OPERATOR_UNLOCK_S })}
                disabled={busy}
                title="Keep the chair drivable so the rider can return"
                style={breachBtn('transparent', '#fff', busy, true)}
              >
                Unlock
              </button>
              <button
                type="button"
                onClick={() => openChairTab(selected?.wheelchair_id ?? '')}
                disabled={!selected}
                style={breachBtn('transparent', '#fff', !selected, true)}
              >
                Open chair
              </button>
            </span>
          </div>
        ) : null}

        {/* desktop tab strip */}
        <div
          className="noscroll deskflex"
          style={{ maxWidth: 1320, margin: '0 auto', padding: '0 16px 12px', gap: 8, overflowX: 'auto' }}
        >
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className="seg"
              data-on={tab === t.key ? '1' : '0'}
              onClick={() => setTab(t.key)}
              style={{
                flex: 'none',
                minHeight: 40,
                padding: '0 16px',
                border: '1px solid var(--hair)',
                borderRadius: 999,
                background: 'transparent',
                color: 'var(--ink)',
                fontSize: 13.5,
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>{t.label}</span>
              {t.key === 'events' && unacked > 0 ? (
                <span
                  style={{
                    minWidth: 20,
                    height: 20,
                    padding: '0 6px',
                    borderRadius: 999,
                    background: 'var(--accent)',
                    color: '#fff',
                    fontSize: 11,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {unacked}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </header>

      {welcome ? (
        <div
          role="status"
          style={{
            maxWidth: 1320,
            margin: '10px auto 0',
            padding: '11px 16px',
            borderRadius: 14,
            border: '1px solid var(--hair)',
            background: 'var(--tint-bg)',
            color: 'var(--ink)',
            fontSize: 13.5,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span aria-hidden="true">👋</span>
          <span>Welcome back, {welcome}</span>
        </div>
      ) : null}

      {/* -------------------------------------------------------------- main */}
      <main
        style={{
          maxWidth: 1320,
          margin: '0 auto',
          padding: '14px 14px 40px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {error ? (
          <Card style={{ padding: '14px 18px', borderColor: RED, fontSize: 13.5 }}>
            <strong style={{ color: RED }}>Live telemetry is unavailable.</strong>{' '}
            <span style={{ color: 'var(--muted)' }}>{error}</span>
          </Card>
        ) : null}
        {loading && sorted.length === 0 && !error ? (
          <Card style={{ padding: '14px 18px', fontSize: 13.5, color: 'var(--muted)' }}>Connecting to the fleet…</Card>
        ) : null}

        {/* =================================================== FLEET tab === */}
        {tab === 'fleet' ? (
          <div className="rise" style={{ display: 'grid', gap: 14, gridTemplateColumns: grid2 }}>
            <Card style={{ overflow: 'hidden', padding: 0 }}>
              <div style={{ height: mapH, position: 'relative' }}>
                <FleetMap state={mapState} onPickUnit={pickChair} onPickPoint={onMapPoint} />
                <div
                  style={{
                    position: 'absolute',
                    left: 14,
                    top: 14,
                    zIndex: 500,
                    display: 'flex',
                    gap: 8,
                    flexWrap: 'wrap',
                    pointerEvents: 'none',
                  }}
                >
                  <span
                    style={{
                      padding: '7px 13px',
                      borderRadius: 999,
                      background: 'var(--float-bg)',
                      color: 'var(--ink)',
                      fontSize: 12,
                      fontWeight: 700,
                      boxShadow: '0 4px 14px rgba(10,12,20,.25)',
                    }}
                  >
                    {mapUnits.length} {mapUnits.length === 1 ? 'chair' : 'chairs'} shown
                  </span>
                  {/* Position provenance — the operator must always know
                      whether a pin is a confirmed fix or an estimate, because
                      dispatching to one is a different decision from the other.
                      (The rider is deliberately never shown this.) */}
                  {selected && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 7,
                        padding: '7px 13px',
                        borderRadius: 999,
                        background: 'var(--float-bg)',
                        color: 'var(--ink)',
                        fontSize: 12,
                        fontWeight: 700,
                        boxShadow: '0 4px 14px rgba(10,12,20,.25)',
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: selectedPos ? SOURCE_COLOR[selectedPos.source] : SOURCE_COLOR.unknown,
                          animation:
                            selectedPos && selectedPos.source === 'gps'
                              ? 'none'
                              : 'beat 1.6s ease-in-out infinite',
                        }}
                      />
                      {selectedPos ? SOURCE_LABEL[selectedPos.source] : SOURCE_LABEL.unknown}
                      <span style={{ fontWeight: 500, opacity: 0.66 }}>
                        {!selectedPos
                          ? 'waiting for first fix'
                          : `±${Math.round(selectedPos.accuracyM)} m${
                              selectedPos.source !== 'gps' && selectedPos.fixAgeMs != null
                                ? ` · fix ${timeAgo(new Date(now - selectedPos.fixAgeMs).toISOString())}`
                                : ''
                            }`}
                      </span>
                    </span>
                  )}
                  <span
                    style={{
                      padding: '7px 13px',
                      borderRadius: 999,
                      background: breach ? 'var(--accent)' : 'var(--float-bg)',
                      color: breach ? '#fff' : 'var(--ink)',
                      fontSize: 12,
                      fontWeight: 700,
                      boxShadow: '0 4px 14px rgba(10,12,20,.25)',
                    }}
                  >
                    {!fresh
                      ? 'Perimeter unknown'
                      : gf == null || !gf.on
                        ? 'No perimeter set'
                        : breach
                          ? 'Perimeter breach'
                          : 'Perimeter normal'}
                  </span>
                </div>
              </div>

              {/* telemetry cells — masked when the selected chair is offline:
                  stale numbers rendered as live data would be a lie. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)' }}>
                {[
                  // Offline chairs still show their last known fix here (that
                  // is the whole point of storing it) — but tagged, never
                  // dressed up as a live reading.
                  { k: 'Lat', v: selectedPos ? `${selectedPos.lat.toFixed(5)}°` : '—' },
                  { k: 'Lng', v: selectedPos ? `${selectedPos.lng.toFixed(5)}°` : '—' },
                  // Speed is a measurement: shown only with a real fix.
                  { k: 'Spd', v: fresh ? num(realSpeedKmh(selected), 1, ' km/h') : '—' },
                  { k: 'Sats', v: fresh && selected?.sats != null ? String(selected.sats) : '—' },
                  { k: 'Hdop', v: fresh ? num(selected?.hdop ?? null, 1) : '—' },
                  { k: 'Course', v: fresh ? num(selected?.yaw ?? null, 0, '°') : '—' },
                ].map((c) => (
                  <div
                    key={c.k}
                    style={{
                      padding: '12px 14px',
                      borderTop: '1px solid var(--hair)',
                      borderRight: '1px solid var(--hair)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10.5,
                        letterSpacing: '.06em',
                        textTransform: 'uppercase',
                        color: 'var(--muted)',
                      }}
                    >
                      {c.k}
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 15, marginTop: 3 }}>{c.v}</div>
                  </div>
                ))}
              </div>

              {/* stats strip */}
              <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : 'repeat(2,1fr)' }}>
                {[
                  { k: 'Online', v: `${counts.online}/${counts.total}` },
                  { k: 'In ride', v: String(counts.rented) },
                  { k: 'Available', v: String(counts.available) },
                  { k: 'Attention', v: String(counts.attention) },
                ].map((s) => (
                  <div
                    key={s.k}
                    style={{
                      padding: '14px 12px',
                      borderTop: '1px solid var(--hair)',
                      borderRight: '1px solid var(--hair)',
                    }}
                  >
                    <div
                      style={{
                        fontFamily: 'var(--font-heading)',
                        fontWeight: 800,
                        fontSize: 22,
                        letterSpacing: '-.02em',
                      }}
                    >
                      {s.v}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{s.k}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* fleet list */}
            <Card style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '14px 14px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search a chair id, session or firmware…"
                  aria-label="Search the fleet"
                  style={{
                    minHeight: 46,
                    borderRadius: 16,
                    border: '1px solid var(--hair)',
                    background: 'transparent',
                    color: 'var(--ink)',
                    padding: '0 16px',
                    fontSize: 15,
                  }}
                />
                <div className="noscroll" style={{ display: 'flex', gap: 7, overflowX: 'auto' }}>
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className="chip"
                      data-on={filter === f.key ? '1' : '0'}
                      onClick={() => setFilter(f.key)}
                      style={{
                        flex: 'none',
                        minHeight: 36,
                        padding: '0 13px',
                        border: '1px solid var(--hair)',
                        borderRadius: 999,
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="noscroll" style={{ overflowY: 'auto', maxHeight: listH, borderTop: '1px solid var(--hair)' }}>
                {filtered.length === 0 ? (
                  <div style={{ padding: '28px 18px', fontSize: 13.5, color: 'var(--muted)' }}>
                    {sorted.length === 0
                      ? 'No chairs are reporting telemetry yet.'
                      : 'No chair matches this search and filter.'}
                  </div>
                ) : (
                  filtered.map((d) => {
                    const st = statusOf(d, now);
                    const meta = STATUS_META[st];
                    const active = d.wheelchair_id === selectedId;
                    return (
                      <button
                        key={d.wheelchair_id}
                        type="button"
                        className="row"
                        onClick={() => pickChair(d.wheelchair_id)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '13px 14px',
                          border: 0,
                          borderBottom: '1px solid var(--hair)',
                          background: active ? 'var(--tint-bg)' : 'transparent',
                          color: 'var(--ink)',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span style={{ width: 10, height: 10, borderRadius: 999, background: meta.dot, flex: 'none' }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontWeight: 700, fontSize: 15 }}>{d.wheelchair_id}</span>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 12.5,
                              color: 'var(--muted)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {d.lat != null && d.lng != null ? `${d.lat.toFixed(3)}, ${d.lng.toFixed(3)}` : 'no fix'} ·{' '}
                            {d.rssi != null ? `${d.rssi} dBm` : '— dBm'} · {timeAgo(d.ts)}
                            {d.tamper ? ' · TAMPER' : ''}
                            {d.over_speed ? ' · OVERSPEED' : ''}
                          </span>
                        </span>
                        <span
                          style={{
                            flex: 'none',
                            padding: '5px 10px',
                            borderRadius: 999,
                            background: meta.tagBg,
                            color: meta.tagFg,
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          {meta.label}
                        </span>
                        <span style={{ flex: 'none', fontWeight: 800, fontSize: 14, width: 46, textAlign: 'right' }}>
                          {battLabel(d.batt_pct)}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </Card>

            {/* ---------------------------------------- geofence zones ----
                Named areas drawn by the operator. Circles, because that is
                what the device's SET_GEOFENCE command can actually enforce.
                Crossing a boundary never locks a chair — see the breach
                banner, which hands the decision to a human. */}
            <Card style={{ gridColumn: wide ? '1 / -1' : 'auto', padding: 0, overflow: 'hidden' }}>
              <div
                style={{
                  padding: '14px 16px',
                  borderBottom: '1px solid var(--hair)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <Svg size={17} width={1.9} style={{ flex: 'none', color: 'var(--muted)' }}>
                  <path d="M12 21s-7-5.6-7-11a7 7 0 1 1 14 0c0 5.4-7 11-7 11z" />
                  <circle cx="12" cy="10" r="2.4" />
                </Svg>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 800,
                    letterSpacing: '.04em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                  }}
                >
                  Geofence zones
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {zones.filter((z) => z.active).length} active · shown to riders
                </span>
                {!zoneDraft && (
                  <button
                    onClick={beginNewZone}
                    style={{
                      marginLeft: 'auto',
                      minHeight: 36,
                      padding: '0 14px',
                      borderRadius: 999,
                      border: 0,
                      background: 'var(--ink)',
                      color: 'var(--app-bg)',
                      fontSize: 12.5,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    + New zone
                  </button>
                )}
              </div>

              {/* draft editor */}
              {zoneDraft && (
                <div
                  style={{
                    padding: 16,
                    borderBottom: '1px solid var(--hair)',
                    background: 'color-mix(in srgb, var(--ink) 4%, transparent)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent)' }}>
                    Click the map to place the centre
                  </span>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <input
                      value={zoneDraft.name}
                      onChange={(e) => setZoneDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                      placeholder="Zone name, e.g. Haram courtyard"
                      aria-label="Zone name"
                      style={{
                        flex: '1 1 220px',
                        minHeight: 44,
                        borderRadius: 14,
                        border: '1px solid var(--hair)',
                        background: 'var(--card-bg)',
                        color: 'var(--ink)',
                        padding: '0 14px',
                        fontSize: 14.5,
                      }}
                    />
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {ZONE_COLORS.map((c) => (
                        <button
                          key={c}
                          aria-label={`Colour ${c}`}
                          onClick={() => setZoneDraft((d) => (d ? { ...d, color: c } : d))}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 999,
                            background: c,
                            border: zoneDraft.color === c ? '3px solid var(--ink)' : '1px solid var(--hair)',
                            cursor: 'pointer',
                          }}
                        />
                      ))}
                    </div>
                  </div>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>
                      Radius · {Math.round(zoneDraft.radiusM)} m
                    </span>
                    <input
                      type="range"
                      min={25}
                      max={2000}
                      step={25}
                      value={zoneDraft.radiusM}
                      onChange={(e) =>
                        setZoneDraft((d) => (d ? { ...d, radiusM: Number(e.target.value) } : d))
                      }
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </label>

                  <span style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--muted)' }}>
                    centre {zoneDraft.lat.toFixed(5)}, {zoneDraft.lng.toFixed(5)}
                  </span>

                  {zoneError && (
                    <span style={{ fontSize: 12.5, color: RED, fontWeight: 700 }}>{zoneError}</span>
                  )}

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => void saveZoneDraft()}
                      disabled={zoneBusy}
                      style={{
                        flex: 1,
                        minHeight: 44,
                        borderRadius: 14,
                        border: 0,
                        background: 'var(--accent)',
                        color: '#fff',
                        fontSize: 14,
                        fontWeight: 800,
                        cursor: zoneBusy ? 'progress' : 'pointer',
                      }}
                    >
                      {zoneBusy ? 'Saving…' : zoneDraft.isNew ? 'Create zone' : 'Save changes'}
                    </button>
                    <button
                      onClick={cancelZoneDraft}
                      disabled={zoneBusy}
                      style={{
                        minHeight: 44,
                        padding: '0 18px',
                        borderRadius: 14,
                        border: '1px solid var(--hair)',
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 14,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* zone list */}
              {zones.length === 0 && !zoneDraft ? (
                <div style={{ padding: 20, fontSize: 13.5, color: 'var(--muted)' }}>
                  No zones yet. Create one to show a service area on the rider map.
                </div>
              ) : (
                zones.map((z) => (
                  <div
                    key={z.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '13px 16px',
                      borderBottom: '1px solid var(--hair)',
                      background: z.id === zoneEditId ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent',
                    }}
                  >
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 999,
                        background: z.color,
                        flex: 'none',
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: 'block',
                          fontWeight: 700,
                          fontSize: 14.5,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {z.name}
                      </span>
                      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', fontFamily: MONO }}>
                        {z.center_lat.toFixed(4)}, {z.center_lng.toFixed(4)} · r {Math.round(z.radius_m)} m
                      </span>
                    </span>
                    <button
                      onClick={() => applyZoneToChair(z)}
                      disabled={!selectedId || busy}
                      title={selectedId ? `Apply to ${selectedId}` : 'Select a chair first'}
                      style={{
                        flex: 'none',
                        minHeight: 34,
                        padding: '0 12px',
                        borderRadius: 999,
                        border: '1px solid var(--hair)',
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 11.5,
                        fontWeight: 700,
                        cursor: !selectedId || busy ? 'not-allowed' : 'pointer',
                        opacity: !selectedId || busy ? 0.5 : 1,
                      }}
                    >
                      Apply to chair
                    </button>
                    <button
                      onClick={() => beginEditZone(z)}
                      style={{
                        flex: 'none',
                        minHeight: 34,
                        padding: '0 12px',
                        borderRadius: 999,
                        border: '1px solid var(--hair)',
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 11.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void deleteZone(z)}
                      aria-label={`Delete ${z.name}`}
                      style={{
                        flex: 'none',
                        width: 34,
                        height: 34,
                        borderRadius: 999,
                        border: '1px solid var(--hair)',
                        background: 'transparent',
                        color: 'var(--muted)',
                        display: 'grid',
                        placeItems: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <Svg size={15} width={1.9}>
                        <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                      </Svg>
                    </button>
                  </div>
                ))
              )}
            </Card>
          </div>
        ) : null}

        {/* =================================================== CHAIR tab === */}
        {tab === 'unit' ? (
          !selected ? (
            <Card style={{ padding: 22, fontSize: 14, color: 'var(--muted)' }}>
              Select a chair from the fleet list to see its sensors.
            </Card>
          ) : !fresh ? (
            /* Disconnected chair: show NO sensor data at all — the last values
               are stale, and rendering them as if live would be a lie. The tab
               recovers automatically the moment fresh telemetry arrives. */
            <Card
              style={{ padding: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}
            >
              <span
                style={{
                  width: 64, height: 64, borderRadius: 20, display: 'grid', placeItems: 'center',
                  background: 'color-mix(in srgb, var(--ink) 7%, transparent)',
                }}
              >
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M1.5 8.5a15 15 0 0 1 8.2-4.2M12 12.5a7.5 7.5 0 0 1 4.6 1.6M8.2 15.9a4.4 4.4 0 0 1 3.8-1.3" />
                  <path d="M12 19.5h.01" />
                  <path d="M3 3l18 18" />
                </svg>
              </span>
              <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, letterSpacing: '-.02em' }}>
                {shortId(selected.wheelchair_id)} is offline
              </span>
              <span style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 420, lineHeight: 1.5 }}>
                No live telemetry — last report {timeAgo(selected.ts)}. Sensor data is hidden
                until the chair reconnects; it will reappear here automatically.
              </span>
              <span
                style={{
                  marginTop: 4, padding: '6px 14px', borderRadius: 999, fontSize: 12, fontWeight: 800,
                  background: STATUS_META.offline.tagBg, color: STATUS_META.offline.tagFg,
                }}
              >
                OFFLINE
              </span>
            </Card>
          ) : (
            <div className="rise" style={{ display: 'grid', gap: 14, gridTemplateColumns: grid3 }}>
              {/* ------------------------------------------- battery card */}
              <Card style={{ padding: 18 }}>
                <Kicker right={<Pill>{selected.power ? 'Discharging' : 'Power off'}</Pill>}>Battery</Kicker>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                  <div style={{ position: 'relative', width: 118, height: 118, flex: 'none' }}>
                    <svg viewBox="0 0 120 120" width="118" height="118" style={{ transform: 'rotate(-90deg)' }}>
                      <circle cx="60" cy="60" r="52" fill="none" stroke={TRACK} strokeWidth="11" />
                      <circle
                        cx="60"
                        cy="60"
                        r="52"
                        fill="none"
                        stroke={battColor}
                        strokeWidth="11"
                        strokeLinecap="round"
                        strokeDasharray="326.7"
                        strokeDashoffset={battOffset}
                        style={{ transition: 'stroke-dashoffset .7s cubic-bezier(.32,.72,0,1)' }}
                      />
                    </svg>
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--font-heading)',
                          fontWeight: 800,
                          fontSize: 28,
                          letterSpacing: '-.02em',
                        }}
                      >
                        {battPct == null ? '—' : `${Math.round(battPct)}%`}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{num(selected.batt_v, 2, ' V')}</span>
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 9, fontSize: 13.5 }}>
                    {[
                      { k: 'Range', v: rangeLabel(selected.batt_pct), c: 'var(--ink)' },
                      { k: 'Temp', v: num(tempMotor, 1, ' °C'), c: tempColor },
                      { k: 'Uptime', v: uptimeLabel(selected.uptime), c: 'var(--ink)' },
                      { k: 'Last seen', v: timeAgo(selected.ts), c: fresh ? 'var(--ink)' : AMBER },
                    ].map((r) => (
                      <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ color: 'var(--muted)' }}>{r.k}</span>
                        <span style={{ fontWeight: 700, color: r.c }}>{r.v}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: TRACK, marginTop: 16, overflow: 'hidden' }}>
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      borderRadius: 999,
                      width: tempMotor == null ? '0%' : pctStr(((tempMotor - 10) / 60) * 100),
                      background: 'linear-gradient(90deg,#1f9d55,#f0b429,#ff563c)',
                      transition: 'width .7s cubic-bezier(.32,.72,0,1)',
                    }}
                  />
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    color: 'var(--muted)',
                    marginTop: 5,
                  }}
                >
                  <span>10 °C</span>
                  <span>warn 45 °C</span>
                  <span>cut-off 55 °C</span>
                </div>
              </Card>

              {/* ---------------------------------------- tilt & safety card */}
              <Card style={{ padding: 18 }}>
                <Kicker
                  right={
                    <Pill bg={tilt >= 26 ? 'var(--accent)' : undefined} fg={tilt >= 26 ? '#fff' : undefined}>
                      {selected.tilt == null ? 'No IMU data' : tilt >= 26 ? 'Hazard' : 'Stable'}
                    </Pill>
                  }
                >
                  Tilt &amp; safety · MPU6500
                </Kicker>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                  <div
                    style={{
                      width: 108,
                      height: 108,
                      flex: 'none',
                      borderRadius: 20,
                      background: 'var(--tint-bg)',
                      display: 'grid',
                      placeItems: 'center',
                      perspective: '340px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: 66,
                        height: 66,
                        borderRadius: 14,
                        border: '2px solid var(--ink)',
                        background: 'rgba(255,86,60,.14)',
                        transform: `perspective(340px) rotateX(${clamp(pitch, -60, 60).toFixed(1)}deg) rotateY(${clamp(roll, -60, 60).toFixed(1)}deg)`,
                        transition: 'transform .35s linear',
                        display: 'grid',
                        placeItems: 'center',
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }} />
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 11 }}>
                    <Bar
                      label="Pitch"
                      value={num(selected.pitch, 1, '°')}
                      width={pctStr((Math.abs(pitch) / 32) * 100)}
                      color="var(--ink)"
                    />
                    <Bar
                      label="Roll"
                      value={num(selected.roll, 1, '°')}
                      width={pctStr((Math.abs(roll) / 32) * 100)}
                      color="var(--ink)"
                    />
                    <Bar
                      label="Tilt"
                      value={num(selected.tilt, 1, '°')}
                      width={pctStr((Math.abs(tilt) / 45) * 100)}
                      color={tilt >= 26 ? RED : 'var(--ink)'}
                    />
                  </div>
                </div>

                {/* ---- Level calibration ------------------------------------
                    The MPU6500 carries a few degrees of factory bias, so raw
                    pitch/roll are never 0/0 even on a flat floor. This tells
                    the chair "the pose you are in right now is level" and the
                    device stores that reference in NVS, so it survives reboots
                    and OTA. The device refuses while it is moving — whatever
                    is captured becomes the permanent definition of flat. */}
                <div
                  style={{
                    marginTop: 12,
                    padding: '11px 12px',
                    borderRadius: 16,
                    border: '1px solid var(--hair)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      flex: 'none',
                      background: selected.imu_calibrated === true ? GREEN : AMBER,
                    }}
                    aria-hidden="true"
                  />
                  <span style={{ flex: 1, minWidth: 130, fontSize: 12.5, fontWeight: 700 }}>
                    {selected.imu_calibrated === true ? 'Level calibrated' : 'Not calibrated'}
                    <span style={{ display: 'block', fontWeight: 500, color: 'var(--muted)' }}>
                      {selected.imu_calibrated === true
                        ? 'Pitch and roll are referenced to a stored level.'
                        : 'Angles are relative to the pose it booted in — a few degrees of lean is expected.'}
                    </span>
                  </span>
                  <button
                    onClick={() => void run('CALIBRATE_IMU')}
                    disabled={busy || !fresh}
                    title={!fresh ? 'The chair must be online to calibrate' : 'Park level and hold still'}
                    style={{
                      flex: 'none',
                      minHeight: 38,
                      padding: '0 15px',
                      borderRadius: 999,
                      border: '1px solid var(--hair)',
                      background: 'transparent',
                      color: 'var(--ink)',
                      fontSize: 12.5,
                      fontWeight: 800,
                      cursor: busy || !fresh ? 'not-allowed' : 'pointer',
                      opacity: busy || !fresh ? 0.55 : 1,
                    }}
                  >
                    {pending === 'CALIBRATE_IMU' ? 'Calibrating…' : 'Set level'}
                  </button>
                </div>

                {/* ---- Emergency wheel unlock -------------------------------
                    A SECOND relay, separate from the motion lock. The motion
                    lock decides whether the chair may drive itself; this cuts
                    power to the electromagnetic wheel brake so the wheels
                    free-wheel and the chair can be pushed by hand.

                    Rendered only when the CHAIR says it has the relay fitted
                    (has_emg_unlock), not when its id happens to be 004 — so a
                    second chair getting the hardware is a firmware flag and
                    this panel needs no edit.

                    Deliberately available during a fault: a chair that has cut
                    its own motion relay after a fall is exactly the chair
                    somebody needs to move. What keeps it safe is that the
                    release is time-boxed on the device, re-engages itself, and
                    never survives a reboot. */}
                {selected.has_emg_unlock === true ? (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '12px 13px',
                      borderRadius: 16,
                      border: `1px solid ${selected.emg_unlock === true ? RED : 'var(--hair)'}`,
                      background: selected.emg_unlock === true ? 'rgba(255,86,60,.10)' : 'transparent',
                      display: 'grid',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          flex: 'none',
                          background: selected.emg_unlock === true ? RED : GREEN,
                          animation: selected.emg_unlock === true ? 'beat .8s ease-in-out infinite' : undefined,
                        }}
                        aria-hidden="true"
                      />
                      <span style={{ flex: 1, minWidth: 150, fontSize: 12.5, fontWeight: 700 }}>
                        {selected.emg_unlock === true ? 'Wheels are FREE' : 'Wheel brake engaged'}
                        <span style={{ display: 'block', fontWeight: 500, color: 'var(--muted)', lineHeight: 1.45 }}>
                          {selected.emg_unlock === true
                            ? 'The chair can roll freely and can be pushed. There is no timer — it stays released until it is locked again here. A reboot does re-engage it.'
                            : 'Emergency release fitted. Frees the wheels so the chair can be pushed by hand — separate from the drive lock.'}
                        </span>
                      </span>
                    </div>

                    {/* Moving + brake release is the one genuinely dangerous
                        combination, so say so rather than quietly allowing it.
                        It is still not blocked: the operator is the one looking
                        at the chair. */}
                    {selected.emg_unlock !== true && selected.in_motion === true ? (
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: AMBER, lineHeight: 1.45 }}>
                        The chair is moving. Releasing the brake now lets it coast — stop it first unless
                        you are freeing a trapped rider.
                      </span>
                    ) : null}

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {selected.emg_unlock === true ? (
                        <button
                          type="button"
                          onClick={() => void run('EMERGENCY_LOCK')}
                          disabled={busy || !fresh}
                          title={!fresh ? 'The chair must be online' : 'Re-engage the wheel brake now'}
                          style={{
                            flex: '1 1 170px',
                            minHeight: 42,
                            borderRadius: 999,
                            border: 0,
                            background: RED,
                            color: '#fff',
                            fontSize: 12.5,
                            fontWeight: 800,
                            cursor: busy || !fresh ? 'not-allowed' : 'pointer',
                            opacity: busy || !fresh ? 0.55 : 1,
                          }}
                        >
                          {pending === 'EMERGENCY_LOCK' ? 'Re-engaging…' : 'Re-engage brake now'}
                        </button>
                      ) : (
                        <>
                          {/* Hold, not click. Freeing the wheels of a chair
                              that may be on a slope is not a control anyone
                              should be able to trigger by mis-tapping. */}
                          <HoldButton
                            onComplete={() => void run('EMERGENCY_UNLOCK')}
                            disabled={busy || !fresh}
                            fill="rgba(255,86,60,.30)"
                            ariaLabel="Hold to release the wheel brake"
                            style={{
                              flex: '1 1 200px',
                              minHeight: 42,
                              borderRadius: 999,
                              border: `1px solid ${RED}`,
                              background: 'rgba(255,86,60,.10)',
                              color: RED,
                              fontSize: 12.5,
                              fontWeight: 800,
                            }}
                          >
                            {(holding) => (
                              <span style={{ whiteSpace: 'nowrap' }}>
                                {pending === 'EMERGENCY_UNLOCK'
                                  ? 'Releasing…'
                                  : holding
                                    ? 'Hold…'
                                    : 'Hold to free wheels'}
                              </span>
                            )}
                          </HoldButton>
                          {!fresh ? (
                            <span
                              style={{
                                flex: '1 1 100%',
                                fontSize: 11.5,
                                fontWeight: 600,
                                color: 'var(--muted)',
                              }}
                            >
                              The chair is offline, so it cannot be told to release. This needs the
                              mechanical release on the chair itself.
                            </span>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                ) : null}

                {/* ---- Emergency main-power cut (GPIO 39) --------------------
                    A THIRD relay, sitting directly below the wheel-unlock
                    control because operators reach for them in the same moment.
                    Three independent things, deliberately not merged:
                      * motion lock  — may the chair DRIVE?
                      * wheel brake  — can the chair be PUSHED?
                      * this         — does the chair have POWER at all?

                    Unlike the brake release this one LATCHES. It has no
                    countdown because nothing restores it on a timer: a power cut
                    is the safe state, and silently handing a chair its power
                    back would undo a deliberate decision. It also survives a
                    device reboot, so the panel says so — an operator must not
                    assume a restart cleared it.

                    Rendered only when the CHAIR reports the relay. */}
                {selected.has_pwr_relay === true ? (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '12px 13px',
                      borderRadius: 16,
                      border: `1px solid ${selected.pwr_cut === true ? RED : 'var(--hair)'}`,
                      background: selected.pwr_cut === true ? 'rgba(255,86,60,.10)' : 'transparent',
                      display: 'grid',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          flex: 'none',
                          background: selected.pwr_cut === true ? RED : GREEN,
                          animation: selected.pwr_cut === true ? 'beat .8s ease-in-out infinite' : undefined,
                        }}
                        aria-hidden="true"
                      />
                      <span style={{ flex: 1, minWidth: 150, fontSize: 12.5, fontWeight: 700 }}>
                        {selected.pwr_cut === true ? 'MAIN POWER CUT' : 'Main power on'}
                        <span style={{ display: 'block', fontWeight: 500, color: 'var(--muted)', lineHeight: 1.45 }}>
                          {selected.pwr_cut === true
                            ? 'Held off by an operator. This does not time out and survives a reboot — it stays off until it is turned back on here.'
                            : 'Emergency cut fitted. Removes power from the chair entirely — separate from the drive lock and the wheel brake.'}
                        </span>
                      </span>
                    </div>

                    {selected.pwr_cut !== true && selected.in_motion === true ? (
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: AMBER, lineHeight: 1.45 }}>
                        The chair is moving. Cutting power now removes drive and steering assist and it
                        will coast — expect it to keep rolling for a short distance.
                      </span>
                    ) : null}

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {selected.pwr_cut === true ? (
                        /* Restoring power to a chair somebody deliberately cut
                           deserves the same deliberate gesture as cutting it. */
                        <HoldButton
                          onComplete={() => void run('EMERGENCY_POWER_ON')}
                          disabled={busy || !fresh}
                          fill="rgba(31,157,85,.30)"
                          ariaLabel="Hold to restore main power"
                          style={{
                            flex: '1 1 200px',
                            minHeight: 42,
                            borderRadius: 999,
                            border: `1px solid ${GREEN}`,
                            background: 'rgba(31,157,85,.10)',
                            color: GREEN,
                            fontSize: 12.5,
                            fontWeight: 800,
                          }}
                        >
                          {(holding) => (
                            <span style={{ whiteSpace: 'nowrap' }}>
                              {pending === 'EMERGENCY_POWER_ON'
                                ? 'Restoring…'
                                : holding
                                  ? 'Hold…'
                                  : 'Hold to power ON'}
                            </span>
                          )}
                        </HoldButton>
                      ) : (
                        <HoldButton
                          onComplete={() => void run('EMERGENCY_POWER_OFF')}
                          disabled={busy || !fresh}
                          fill="rgba(255,86,60,.30)"
                          ariaLabel="Hold to cut main power"
                          style={{
                            flex: '1 1 200px',
                            minHeight: 42,
                            borderRadius: 999,
                            border: `1px solid ${RED}`,
                            background: 'rgba(255,86,60,.10)',
                            color: RED,
                            fontSize: 12.5,
                            fontWeight: 800,
                          }}
                        >
                          {(holding) => (
                            <span style={{ whiteSpace: 'nowrap' }}>
                              {pending === 'EMERGENCY_POWER_OFF'
                                ? 'Cutting…'
                                : holding
                                  ? 'Hold…'
                                  : '⏻ Hold to power OFF'}
                            </span>
                          )}
                        </HoldButton>
                      )}
                      {!fresh ? (
                        <span
                          style={{
                            flex: '1 1 100%',
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: 'var(--muted)',
                          }}
                        >
                          The chair is offline, so it cannot be told to switch. Note a latched cut is
                          still in force on the chair even while it is unreachable.
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* ---- Local camera live view --------------------------------
                    Demo rig, not part of the product: a Tapo C200 on the
                    operator's LAN, re-streamed as MJPEG by a script on their
                    laptop. Shown only for chairs listed in CAMERA_CHAIRS, and
                    the panel is explicit that this is a local feed rather than
                    anything the chair or the cloud knows about — an operator
                    should never mistake it for fleet telemetry. */}
                {CAMERA_CHAIRS[selected.wheelchair_id] ? (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '12px 13px',
                      borderRadius: 16,
                      border: '1px solid var(--hair)',
                      display: 'grid',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>
                        {CAMERA_CHAIRS[selected.wheelchair_id]}
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 800,
                          letterSpacing: 0.3,
                          padding: '2px 7px',
                          borderRadius: 999,
                          background: 'var(--tint-bg)',
                          color: 'var(--accent)',
                        }}
                      >
                        LOCAL NETWORK
                      </span>
                    </div>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>
                      Streamed from a laptop on the same WiFi, not through the cloud. Nothing here
                      comes from the chair, and it is not recorded.
                    </span>

                    <input
                      value={cameraUrl}
                      onChange={(e) => setCameraUrl(e.target.value)}
                      spellCheck={false}
                      aria-label="Camera stream address"
                      placeholder={CAMERA_URL_DEFAULT}
                      style={{
                        minHeight: 36,
                        padding: '0 10px',
                        borderRadius: 10,
                        border: '1px solid var(--hair)',
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 11.5,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      }}
                    />

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={openCameraWindow}
                        disabled={!cameraUrl.trim()}
                        style={{
                          flex: '1 1 150px',
                          minHeight: 40,
                          borderRadius: 999,
                          border: 0,
                          background: 'var(--accent)',
                          color: '#fff',
                          fontSize: 12.5,
                          fontWeight: 800,
                          cursor: cameraUrl.trim() ? 'pointer' : 'not-allowed',
                          opacity: cameraUrl.trim() ? 1 : 0.55,
                        }}
                      >
                        📹 Open live view
                      </button>
                      {/* Offered only when it can actually succeed. On an HTTPS
                          console with an HTTP stream the browser blocks the
                          embed, so a "show inline" button there would be a
                          button that never works. */}
                      {!cameraNeedsNewWindow ? (
                        <button
                          type="button"
                          onClick={() => setCameraInline((v) => !v)}
                          style={{
                            flex: '1 1 120px',
                            minHeight: 40,
                            borderRadius: 999,
                            border: '1px solid var(--hair)',
                            background: 'transparent',
                            color: 'var(--ink)',
                            fontSize: 12.5,
                            fontWeight: 800,
                            cursor: 'pointer',
                          }}
                        >
                          {cameraInline ? 'Hide preview' : 'Show inline'}
                        </button>
                      ) : null}
                    </div>

                    {cameraNeedsNewWindow ? (
                      <span style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.45 }}>
                        The console is on HTTPS and this stream is plain HTTP, so the browser will
                        not embed it in the page. Open live view works — it opens in its own window,
                        which is not subject to that restriction.
                      </span>
                    ) : null}

                    {/* The <img> is mounted only while the preview is open. An
                        MJPEG response never ends, so leaving it mounted would
                        hold a connection to the laptop open for the whole
                        session. */}
                    {cameraInline && !cameraNeedsNewWindow ? (
                      cameraFailed ? (
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: AMBER, lineHeight: 1.45 }}>
                          No stream at that address. Check the script is running and that this
                          machine is on the same WiFi as the laptop.
                        </span>
                      ) : (
                        <img
                          src={cameraUrl}
                          alt="Live camera feed"
                          onError={() => setCameraFailed(true)}
                          style={{
                            width: '100%',
                            borderRadius: 12,
                            border: '1px solid var(--hair)',
                            background: '#000',
                            display: 'block',
                          }}
                        />
                      )
                    ) : null}
                  </div>
                ) : null}
                {/* The "battery reading is not measured" banner was removed at the
                    operator's request. batt_valid is still reported by the device
                    and still false while the divider into GPIO 2 is unwired — the
                    percentage on screen remains the firmware's fallback rather
                    than a measurement, it is simply no longer labelled as one. */}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 14 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '11px 12px',
                      borderRadius: 16,
                      border: '1px solid var(--hair)',
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 999,
                        flex: 'none',
                        background: selected.tamper ? RED : 'var(--muted)',
                      }}
                    />
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Tamper {selected.tamper ? `ALARM x${selected.tamper_count ?? 0}` : 'armed'}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '11px 12px',
                      borderRadius: 16,
                      border: '1px solid var(--hair)',
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    {/* A fall is a TILT event. SAFE_FAULT on its own can mean
                        over-temp, a missing probe or a manual SOS — reading it
                        as "impact" mislabels unrelated faults. */}
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 999,
                        flex: 'none',
                        background: (selected.tilt ?? 0) > FALL_TILT_DEG ? RED : 'var(--muted)',
                      }}
                    />
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Fall {(selected.tilt ?? 0) > FALL_TILT_DEG
                        ? `DETECTED ${(selected.tilt ?? 0).toFixed(0)}°`
                        : 'clear'}
                    </span>
                  </div>
                </div>
                {selected.tamper ? (
                  <button
                    type="button"
                    onClick={() => void run('CLEAR_TAMPER')}
                    disabled={busy}
                    style={{
                      width: '100%',
                      marginTop: 10,
                      minHeight: 46,
                      border: 0,
                      borderRadius: 16,
                      background: 'var(--accent)',
                      color: '#fff',
                      fontSize: 13.5,
                      fontWeight: 800,
                      cursor: busy ? 'not-allowed' : 'pointer',
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {pending === 'CLEAR_TAMPER' ? 'Waiting for the chair…' : 'Silence alarm & re-arm'}
                  </button>
                ) : null}
              </Card>

              {/* ------------------------------------------ remote actions */}
              <Card style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Kicker>Remote actions · {selected.wheelchair_id}</Kicker>

                <HoldButton
                  onComplete={() =>
                    void run(
                      selected.locked ? 'UNLOCK' : 'LOCK',
                      selected.locked ? { duration_s: OPERATOR_UNLOCK_S } : {}
                    )
                  }
                  disabled={busy || !fresh}
                  fill="rgba(255,86,60,.45)"
                  justify="flex-start"
                  style={{
                    minHeight: 64,
                    borderRadius: 20,
                    padding: '0 16px',
                    background: selected.locked ? 'var(--ink)' : 'transparent',
                    color: selected.locked ? 'var(--app-bg)' : 'var(--ink)',
                    border: selected.locked ? 0 : '1px solid var(--hair)',
                    textAlign: 'left',
                  }}
                >
                  {(holding) => (
                    <>
                      <Svg size={22} width={1.9}>
                        <rect x="4" y="10.5" width="16" height="11" rx="2.5" />
                        <path d={selected.locked ? 'M8 10.5V8a4 4 0 0 1 8 0v2.5' : 'M8 10.5V8a4 4 0 0 1 7.4-2'} />
                      </Svg>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 800, fontSize: 16 }}>
                          {holding
                            ? 'Hold…'
                            : pending === 'UNLOCK' || pending === 'LOCK'
                              ? 'Waiting for the chair…'
                              : selected.locked
                                ? 'Hold to unlock the relay'
                                : 'Hold to lock the relay'}
                        </span>
                        <span style={{ display: 'block', fontSize: 12.5, opacity: 0.78 }}>
                          {!fresh
                            ? 'The chair is offline — commands will not reach it'
                            : selected.locked
                              ? `Opens the relay for ${Math.round(OPERATOR_UNLOCK_S / 60)} min if the device agrees`
                              : 'The chair is free to drive'}
                        </span>
                      </span>
                    </>
                  )}
                </HoldButton>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
                  <button
                    type="button"
                    onClick={() => void run('PING')}
                    disabled={busy}
                    style={{
                      minHeight: 56,
                      border: '1px solid var(--hair)',
                      borderRadius: 18,
                      background: 'transparent',
                      color: 'var(--ink)',
                      fontSize: 13.5,
                      fontWeight: 700,
                      cursor: busy ? 'not-allowed' : 'pointer',
                      opacity: busy ? 0.6 : 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      padding: '0 14px',
                      textAlign: 'left',
                    }}
                  >
                    <Svg size={19}>{ICON.bell}</Svg>
                    <span>{pending === 'PING' ? 'Sounding…' : 'Siren'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void run('PING')}
                    disabled={busy}
                    style={{
                      minHeight: 56,
                      border: '1px solid var(--hair)',
                      borderRadius: 18,
                      background: 'transparent',
                      color: 'var(--ink)',
                      fontSize: 13.5,
                      fontWeight: 700,
                      cursor: busy ? 'not-allowed' : 'pointer',
                      opacity: busy ? 0.6 : 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      padding: '0 14px',
                      textAlign: 'left',
                    }}
                  >
                    <Svg size={19}>{ICON.chart}</Svg>
                    <span>Run diagnostics</span>
                  </button>
                </div>

                <div style={{ display: 'grid', gap: 7, paddingTop: 4 }}>
                  {diag.map((d) => (
                    <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                      <span
                        style={{ width: 9, height: 9, borderRadius: 999, flex: 'none', background: DIAG_COLOR[d.state] }}
                      />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {d.name}
                      </span>
                      <span
                        style={{
                          flex: 'none',
                          fontSize: 11.5,
                          color: 'var(--muted)',
                          whiteSpace: 'nowrap',
                          maxWidth: '38%',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {d.note}
                      </span>
                      <span style={{ flex: 'none', fontWeight: 700, color: DIAG_COLOR[d.state] }}>
                        {d.state.toLowerCase()}
                      </span>
                    </div>
                  ))}
                </div>

                {/* ---- Operator override -------------------------------------
                    A failed probe otherwise strands the chair forever: the
                    interlock only releases when the sensor reports healthy
                    again. This grants a TIME-LIMITED degraded-mode override.

                    It is a request, not a bypass — the DEVICE decides, and it
                    refuses while it can measure a real hazard (over-temp, or a
                    chair still tipped past its fall angle). Every grant,
                    refusal and expiry is written to the event log. */}
                {overrideActiveS > 0 ? (
                  <div
                    style={{
                      marginTop: 4,
                      padding: '12px 14px',
                      borderRadius: 16,
                      border: `1px solid ${AMBER}`,
                      background: 'rgba(240,180,41,.10)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                    }}
                  >
                    <span
                      style={{
                        width: 9, height: 9, borderRadius: 999, flex: 'none',
                        background: AMBER, animation: 'beat 1.4s ease-in-out infinite',
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700 }}>
                      Running in degraded mode
                      <span style={{ display: 'block', fontWeight: 500, color: 'var(--muted)' }}>
                        Sensor interlock overridden · {mmss(overrideActiveS)} left
                      </span>
                    </span>
                    <button
                      onClick={() => void run('CANCEL_MAINT_OVERRIDE')}
                      disabled={busy}
                      style={{
                        flex: 'none',
                        minHeight: 36,
                        padding: '0 14px',
                        borderRadius: 999,
                        border: '1px solid var(--hair)',
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: busy ? 'progress' : 'pointer',
                      }}
                    >
                      End now
                    </button>
                  </div>
                ) : hasBlockingFault ? (
                  <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <HoldButton
                      onComplete={() => void run('MAINT_OVERRIDE', { minutes: OVERRIDE_MINUTES })}
                      disabled={busy || !fresh}
                      fill="rgba(240,180,41,.55)"
                      justify="flex-start"
                      style={{
                        minHeight: 60,
                        borderRadius: 18,
                        padding: '0 16px',
                        background: 'var(--ink)',
                        color: 'var(--app-bg)',
                        textAlign: 'left',
                      }}
                    >
                      {(holding) => (
                        <>
                          <Svg size={20} width={1.9} style={{ position: 'relative', flex: 'none' }}>
                            <path d="M12 3l8 3v6c0 5-3.4 8.2-8 9.5C7.4 20.2 4 17 4 12V6z" />
                            <path d="M9.4 12.2l1.9 1.9 3.5-3.7" />
                          </Svg>
                          <span style={{ position: 'relative', textAlign: 'left' }}>
                            <span style={{ display: 'block', fontWeight: 800, fontSize: 15 }}>
                              {holding ? 'Keep holding…' : 'Hold to override the fault'}
                            </span>
                            <span style={{ display: 'block', fontSize: 12.5, opacity: 0.78 }}>
                              {OVERRIDE_MINUTES} min degraded mode · logged · device may refuse
                            </span>
                          </span>
                        </>
                      )}
                    </HoldButton>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>
                      Use when a probe has failed and the chair must be recovered. The chair
                      still refuses if it measures a real hazard.
                    </span>
                    <button
                      type="button"
                      onClick={() => void run('MAINT_OVERRIDE', { minutes: 60 })}
                      disabled={busy || !fresh}
                      style={{
                        minHeight: 48,
                        borderRadius: 16,
                        border: '1px solid #f59e0b',
                        background: 'rgba(245, 158, 11, 0.15)',
                        color: '#fbbf24',
                        fontSize: 13,
                        fontWeight: 800,
                        cursor: busy || !fresh ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        width: '100%',
                      }}
                    >
                      <Svg size={18} width={2}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></Svg>
                      <span>⚡ Force Available (Bench Diagnostic Mode · 60 min)</span>
                    </button>
                  </div>
                ) : null}

                {/* ---- Maintenance mode --------------------------------------
                    Not a device command and not an ack-or-fail action: this is
                    a fleet decision stored in Postgres. Withdrawing a chair
                    takes it off every rider surface the instant the row
                    changes — riders are subscribed to the same table — and it
                    holds whether or not the chair is currently reporting.
                    Reversible, so a plain button rather than hold-to-confirm. */}
                {selected?.out_of_service ? (
                  <div
                    style={{
                      marginTop: 4,
                      padding: '12px 14px',
                      borderRadius: 16,
                      border: '1px solid var(--hair)',
                      background: 'color-mix(in srgb, var(--ink) 5%, transparent)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{ width: 9, height: 9, borderRadius: 999, flex: 'none', background: AMBER }}
                      aria-hidden="true"
                    />
                    <span style={{ flex: 1, minWidth: 140, fontSize: 12.5, fontWeight: 700 }}>
                      Out of service
                      <span style={{ display: 'block', fontWeight: 500, color: 'var(--muted)' }}>
                        {selected.service_note
                          ? selected.service_note
                          : 'Hidden from riders — cannot be rented.'}
                        {selected.service_since ? ` · since ${timeAgo(selected.service_since)}` : ''}
                      </span>
                    </span>
                    <button
                      onClick={() => void toggleService(false, '')}
                      disabled={serviceBusy}
                      style={{
                        flex: 'none',
                        minHeight: 36,
                        padding: '0 14px',
                        borderRadius: 999,
                        border: 0,
                        background: GREEN,
                        color: '#fff',
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: serviceBusy ? 'progress' : 'pointer',
                      }}
                    >
                      {serviceBusy ? 'Saving…' : 'Make available'}
                    </button>
                  </div>
                ) : (
                  <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      value={serviceNote}
                      onChange={(e) => setServiceNote(e.target.value)}
                      placeholder="Reason (optional) — e.g. flat tyre"
                      maxLength={120}
                      style={{
                        flex: 1,
                        minWidth: 160,
                        minHeight: 40,
                        borderRadius: 12,
                        border: '1px solid var(--hair)',
                        background: 'var(--card-bg)',
                        color: 'var(--ink)',
                        padding: '0 12px',
                        fontSize: 12.5,
                      }}
                    />
                    <button
                      onClick={() => void toggleService(true, serviceNote)}
                      disabled={serviceBusy || !selected}
                      style={{
                        flex: 'none',
                        minHeight: 40,
                        padding: '0 16px',
                        borderRadius: 999,
                        border: '1px solid var(--hair)',
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 12.5,
                        fontWeight: 800,
                        cursor: serviceBusy || !selected ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {serviceBusy ? 'Saving…' : 'Take out of service'}
                    </button>
                  </div>
                )}

                {ack ? (
                  <div
                    style={{
                      marginTop: 2,
                      padding: '10px 12px',
                      borderRadius: 14,
                      background: ack.ok ? 'rgba(31,157,85,.12)' : 'var(--tint-bg)',
                      color: ack.ok ? GREEN : RED,
                      fontSize: 12.5,
                      fontWeight: 700,
                      lineHeight: 1.45,
                    }}
                  >
                    {ack.text}
                  </div>
                ) : null}
              </Card>

              {/* --------------------------------------------- firmware card */}
              <Card style={{ padding: 18 }}>
                <Kicker right={<Pill>{fwVersion ? `v${fwVersion}` : 'version unknown'}</Pill>}>Firmware</Kicker>
                <div style={{ height: 8, borderRadius: 999, background: TRACK, overflow: 'hidden' }}>
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      borderRadius: 999,
                      background: 'var(--accent)',
                      width: `${otaProgress}%`,
                      transition: 'width .4s ease',
                    }}
                  />
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    margin: '8px 0 4px',
                    fontSize: 12.5,
                    color: 'var(--muted)',
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {otaStatus || (otaUpToDate ? 'No pending update' : `Target ${targetVersion}`)}
                  </span>
                  <span style={{ flex: 'none', fontWeight: 700, color: 'var(--ink)' }}>{Math.round(otaProgress)}%</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
                  Running {fwVersion ?? '—'} · target {targetVersion ?? '—'}
                </div>
                {selected.ota_last_error ? (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: '9px 12px',
                      borderRadius: 14,
                      background: 'var(--tint-bg)',
                      color: RED,
                      fontSize: 12.5,
                      fontWeight: 700,
                      lineHeight: 1.45,
                    }}
                  >
                    Last OTA error: {selected.ota_last_error}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => void run('OTA', targetVersion ? { version: targetVersion } : {})}
                  disabled={otaBusy || otaUpToDate || busy || !fresh}
                  style={{
                    width: '100%',
                    minHeight: 52,
                    border: 0,
                    borderRadius: 999,
                    background:
                      otaBusy || otaUpToDate || busy ? 'color-mix(in srgb, var(--ink) 10%, transparent)' : 'var(--accent)',
                    color: otaBusy || otaUpToDate || busy ? 'var(--muted)' : '#fff',
                    fontSize: 15,
                    fontWeight: 800,
                    cursor: otaBusy || otaUpToDate || busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  {otaBusy ? 'Update in progress…' : otaUpToDate ? 'Up to date' : `Push ${targetVersion}`}
                </button>
              </Card>

              {/* ------------------------------------------- raw GPS terminal */}
              <div
                style={{
                  borderRadius: 26,
                  background: TERM_BG,
                  color: TERM_FG,
                  border: '1px solid rgba(255,255,255,.12)',
                  overflow: 'hidden',
                  gridColumn: wide ? 'span 3' : 'auto',
                }}
              >
                <div
                  style={{
                    padding: '14px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    borderBottom: `1px solid ${TERM_HAIR}`,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: nmea.length > 0 ? GREEN : 'rgba(255,255,255,.25)',
                    }}
                  />
                  <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase' }}>
                    Raw GPS · on-demand snapshot
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, opacity: 0.6, whiteSpace: 'nowrap' }}>
                    {nmea.length} lines
                  </span>
                </div>
                <div
                  className="noscroll"
                  style={{
                    height: nmea.length > 0 ? 420 : 120,
                    overflow: 'auto',
                    padding: '12px 16px',
                    fontFamily: MONO,
                    fontSize: 11,
                    lineHeight: 1.75,
                    display: 'flex',
                    flexDirection: 'column',
                    transition: 'height .3s ease',
                  }}
                >
                  {nmea.length === 0 ? (
                    <div style={{ opacity: 0.6, textAlign: 'center', paddingTop: 40 }}>
                      Press the button below to fetch GPS data from the device.
                    </div>
                  ) : (
                    nmea.map((n) => (
                      <div
                        key={n.key}
                        style={{ whiteSpace: 'nowrap', color: n.kind === 'gga' ? 'rgba(233,233,239,.92)' : '#8fb7ff' }}
                      >
                        {n.line}
                      </div>
                    ))
                  )}
                </div>
                <div style={{ padding: '10px 16px 14px', borderTop: `1px solid ${TERM_HAIR}` }}>
                  <button
                    type="button"
                    onClick={() => void fetchGpsOnce()}
                    disabled={gpsFetching || !selectedId}
                    style={{
                      width: '100%',
                      minHeight: 44,
                      border: 0,
                      borderRadius: 999,
                      background: gpsFetching ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.15)',
                      color: TERM_FG,
                      fontSize: 13,
                      fontWeight: 800,
                      cursor: gpsFetching || !selectedId ? 'not-allowed' : 'pointer',
                      opacity: gpsFetching ? 0.6 : 1,
                      transition: 'background .2s',
                    }}
                  >
                    {gpsFetching ? '⏳ Fetching GPS data…' : '📡 Get GPS Data'}
                  </button>
                </div>
              </div>
            </div>
          )
        ) : null}

        {/* =================================================== RIDES tab === */}
        {tab === 'rides' ? (
          <div className="rise" style={{ display: 'grid', gap: 14, gridTemplateColumns: grid2 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* session card */}
              <div
                style={{
                  borderRadius: 26,
                  border: '1px solid var(--hair)',
                  padding: 18,
                  background: sessionActive ? 'var(--accent)' : 'var(--card-bg)',
                  color: sessionActive ? '#fff' : 'var(--ink)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      letterSpacing: '.04em',
                      textTransform: 'uppercase',
                      opacity: 0.8,
                    }}
                  >
                    {sessionActive ? 'Live rental session' : 'No active session'}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 12.5, opacity: 0.8 }}>
                    {selected ? selected.wheelchair_id : '—'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
                  <span>
                    <span
                      style={{
                        display: 'block',
                        fontFamily: 'var(--font-heading)',
                        fontWeight: 800,
                        fontSize: 46,
                        lineHeight: 1,
                        letterSpacing: '-.03em',
                      }}
                    >
                      {hms(elapsedSec)}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, opacity: 0.75, marginTop: 3 }}>elapsed</span>
                  </span>
                  <span style={{ marginLeft: 'auto', textAlign: 'right' }}>
                    <span
                      style={{
                        display: 'block',
                        fontFamily: 'var(--font-heading)',
                        fontWeight: 800,
                        fontSize: 30,
                        lineHeight: 1,
                      }}
                    >
                      {sar(sessionActive ? liveFee : 0)}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, opacity: 0.75, marginTop: 3 }}>
                      estimate · the invoice is issued server-side
                    </span>
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 16,
                    flexWrap: 'wrap',
                    margin: '14px 0 12px',
                    fontSize: 12.5,
                    opacity: 0.85,
                  }}
                >
                  <span>Unlock {sar(UNLOCK_FEE)}</span>
                  <span>{sar(PER_MIN)}/min</span>
                  <span>Cap {sar(DAY_CAP)}</span>
                </div>
                {selected && selected.time_left != null && sessionActive ? (
                  <div style={{ fontSize: 12.5, opacity: 0.85, marginBottom: 12 }}>
                    The chair reports {mmss(selected.time_left)} left on this grant.
                  </div>
                ) : null}
                <HoldButton
                  onComplete={() =>
                    void run(
                      sessionActive ? 'END_SESSION' : 'UNLOCK',
                      sessionActive ? {} : { duration_s: OPERATOR_UNLOCK_S }
                    )
                  }
                  disabled={!selected || busy || !fresh}
                  fill="rgba(255,86,60,.5)"
                  style={{
                    width: '100%',
                    minHeight: 58,
                    borderRadius: 18,
                    background: sessionActive ? '#fff' : 'var(--ink)',
                    color: sessionActive ? 'var(--accent)' : 'var(--app-bg)',
                    fontSize: 15.5,
                    fontWeight: 800,
                  }}
                >
                  {(holding) => (
                    <span>
                      {holding
                        ? 'Hold…'
                        : pending === 'END_SESSION' || pending === 'UNLOCK'
                          ? 'Waiting for the chair…'
                          : sessionActive
                            ? 'Hold to end rental'
                            : 'Hold to start rental'}
                    </span>
                  )}
                </HoldButton>
              </div>

              {/* ride history */}
              <Card style={{ overflow: 'hidden' }}>
                <div
                  style={{
                    padding: '16px 18px',
                    borderBottom: '1px solid var(--hair)',
                    fontSize: 12,
                    fontWeight: 800,
                    letterSpacing: '.04em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                  }}
                >
                  Ride history
                </div>
                {rentalsError ? (
                  <div style={{ padding: 18, fontSize: 13.5, color: RED }}>{rentalsError}</div>
                ) : !rentalsLoaded ? (
                  <div style={{ padding: 18, fontSize: 13.5, color: 'var(--muted)' }}>Loading rentals…</div>
                ) : rentals.length === 0 ? (
                  <div style={{ padding: 18, fontSize: 13.5, color: 'var(--muted)' }}>
                    No rentals have been recorded yet.
                  </div>
                ) : (
                  rentals.slice(0, 8).map((r) => {
                    const secs = rentalSeconds(r, now);
                    return (
                      <div
                        key={r.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '14px 18px',
                          borderBottom: '1px solid var(--hair)',
                        }}
                      >
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontWeight: 700, fontSize: 15 }}>{r.wheelchair_id}</span>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 12.5,
                              color: 'var(--muted)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {stamp(r.start_at ?? r.created_at)} · {mmss(secs)} · {r.state}
                          </span>
                        </span>
                        <span style={{ flex: 'none', fontWeight: 800, fontSize: 15 }}>
                          {r.end_at ? sar(estimateFee(secs)) : '—'}
                        </span>
                      </div>
                    );
                  })
                )}
              </Card>
            </div>

            {/* revenue stats */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[
                {
                  k: 'Revenue today',
                  v: sar(revenue.total),
                  sub: sessionActive ? `${sar(liveFee)} accruing now` : 'estimated from rental durations',
                },
                { k: 'Rides today', v: String(revenue.rides), sub: `avg ${revenue.avgMin.toFixed(0)} min per ride` },
                {
                  k: 'Utilisation now',
                  v: `${revenue.util}%`,
                  sub: `${counts.rented} of ${counts.total} chairs in a ride`,
                },
                {
                  k: 'Chairs needing attention',
                  v: String(counts.attention),
                  sub: `${counts.total - counts.online} offline`,
                },
              ].map((r) => (
                <Card key={r.k} style={{ padding: 18 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.k}</div>
                  <div
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontWeight: 800,
                      fontSize: 30,
                      letterSpacing: '-.02em',
                      marginTop: 2,
                    }}
                  >
                    {r.v}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.sub}</div>
                </Card>
              ))}
            </div>
          </div>
        ) : null}

        {/* ================================================== ALERTS tab === */}
        {tab === 'events' ? (
          <div className="rise" style={{ display: 'grid', gap: 14, gridTemplateColumns: grid2 }}>
            <Card style={{ overflow: 'hidden' }}>
              <div
                style={{
                  padding: '14px 18px',
                  borderBottom: '1px solid var(--hair)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 800,
                    letterSpacing: '.04em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                  }}
                >
                  Alerts
                </span>
                <button
                  type="button"
                  onClick={ackAll}
                  disabled={unacked === 0}
                  style={{
                    marginLeft: 'auto',
                    minHeight: 36,
                    padding: '0 14px',
                    border: '1px solid var(--hair)',
                    borderRadius: 999,
                    background: 'transparent',
                    color: 'var(--ink)',
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: unacked === 0 ? 'not-allowed' : 'pointer',
                    opacity: unacked === 0 ? 0.5 : 1,
                  }}
                >
                  Acknowledge all
                </button>
              </div>
              <div className="noscroll" style={{ maxHeight: 520, overflowY: 'auto' }}>
                {events.length === 0 ? (
                  <div style={{ padding: '28px 18px', fontSize: 13.5, color: 'var(--muted)' }}>
                    No events have been reported by the fleet.
                  </div>
                ) : (
                  events.map((ev) => {
                    const key = String(ev.id);
                    const sev = severityOf(ev.type);
                    const isAcked = acked.has(key);
                    return (
                      <div
                        key={key}
                        style={{
                          display: 'flex',
                          gap: 12,
                          padding: '15px 18px',
                          borderBottom: '1px solid var(--hair)',
                          opacity: isAcked ? 0.5 : 1,
                        }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 999,
                            background: SEV_COLOR[sev],
                            flex: 'none',
                            marginTop: 5,
                          }}
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                            <span style={{ fontWeight: 800, fontSize: 15 }}>{titleOf(ev.type)}</span>
                            <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 11.5, color: 'var(--muted)' }}>
                              {timeAgo(ev.ts)}
                            </span>
                          </span>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 13.5,
                              lineHeight: 1.5,
                              color: 'var(--muted)',
                              marginTop: 3,
                              wordBreak: 'break-word',
                            }}
                          >
                            {humanDetail(ev)}
                          </span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              onClick={() => openChairTab(ev.wheelchair_id)}
                              style={{
                                padding: '5px 10px',
                                borderRadius: 999,
                                border: 0,
                                background: 'var(--tint-bg)',
                                color: 'var(--ink)',
                                fontSize: 11.5,
                                fontWeight: 700,
                                cursor: 'pointer',
                              }}
                            >
                              {ev.wheelchair_id}
                            </button>
                            <span
                              style={{
                                padding: '5px 10px',
                                borderRadius: 999,
                                border: '1px solid var(--hair)',
                                fontSize: 11.5,
                                fontWeight: 700,
                                color: SEV_COLOR[sev],
                              }}
                            >
                              {sev.toLowerCase()}
                            </span>
                            <button
                              type="button"
                              onClick={() => ackOne(key)}
                              disabled={isAcked}
                              style={{
                                marginLeft: 'auto',
                                minHeight: 34,
                                padding: '0 12px',
                                border: '1px solid var(--hair)',
                                borderRadius: 999,
                                background: 'transparent',
                                color: 'var(--ink)',
                                fontSize: 12,
                                fontWeight: 700,
                                cursor: isAcked ? 'default' : 'pointer',
                              }}
                            >
                              {isAcked ? 'Acknowledged' : 'Acknowledge'}
                            </button>
                          </span>
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </Card>

            {/* event log terminal */}
            <div
              style={{
                borderRadius: 26,
                background: TERM_BG,
                color: TERM_FG,
                border: '1px solid rgba(255,255,255,.12)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '14px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  borderBottom: `1px solid ${TERM_HAIR}`,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase' }}>
                  Event log
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, opacity: 0.6, whiteSpace: 'nowrap' }}>
                  {logRows.length} / {events.length} lines
                </span>
              </div>
              <div
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  gap: 7,
                  alignItems: 'center',
                  borderBottom: `1px solid ${TERM_HAIR}`,
                  flexWrap: 'wrap',
                }}
              >
                <input
                  value={logQuery}
                  onChange={(e) => setLogQuery(e.target.value)}
                  placeholder="filter…"
                  aria-label="Filter the event log"
                  style={{
                    flex: 1,
                    minWidth: 110,
                    minHeight: 38,
                    borderRadius: 12,
                    border: '1px solid rgba(255,255,255,.2)',
                    background: 'rgba(255,255,255,.06)',
                    color: '#fff',
                    padding: '0 12px',
                    fontSize: 13,
                  }}
                />
                {LOG_LEVELS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLogLevel(l)}
                    style={{
                      flex: 'none',
                      minHeight: 38,
                      padding: '0 11px',
                      border: '1px solid rgba(255,255,255,.2)',
                      borderRadius: 12,
                      background: logLevel === l ? RED : 'transparent',
                      color: logLevel === l ? '#fff' : TERM_FG,
                      fontSize: 11.5,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    {l === 'ERROR' ? 'ERR' : l}
                  </button>
                ))}
              </div>
              <div
                className="noscroll"
                style={{
                  flex: 1,
                  maxHeight: 470,
                  minHeight: 200,
                  overflow: 'auto',
                  padding: '12px 16px',
                  fontFamily: MONO,
                  fontSize: 11,
                  lineHeight: 1.8,
                  display: 'flex',
                  flexDirection: 'column-reverse',
                }}
              >
                {logRows.length === 0 ? (
                  <div style={{ opacity: 0.6 }}>No log lines match this filter.</div>
                ) : (
                  logRows.map((ev) => {
                    const level = SEV_LEVEL[severityOf(ev.type)];
                    const color = level === 'ERROR' ? '#ff7a5e' : level === 'WARN' ? '#ffb347' : '#8fb7ff';
                    return (
                      <div key={String(ev.id)} style={{ display: 'flex', gap: 10, minWidth: 'max-content' }}>
                        <span style={{ opacity: 0.5, flex: 'none' }}>{clockOf(ev.ts)}</span>
                        <span style={{ color, flex: 'none', width: 40 }}>{level.toLowerCase()}</span>
                        <span
                          style={{
                            opacity: 0.6,
                            flex: 'none',
                            width: 100,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {ev.wheelchair_id}
                        </span>
                        <span style={{ minWidth: 0 }}>{logMessage(ev)}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* ===================================================== OTA tab === */}
        {tab === 'ota' ? (
          <div className="rise" style={{ display: 'grid', gap: 14, gridTemplateColumns: grid2 }}>
            {/* ---- Register & Upload New Release (.bin) ---- */}
            <Card style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Kicker right={<Pill>{fwUploading ? 'Uploading…' : 'Supabase Storage'}</Pill>}>
                Register Release (.bin)
              </Kicker>

              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 5 }}>
                    Target Release Version
                  </label>
                  <input
                    type="text"
                    value={fwVersionInput}
                    onChange={(e) => setFwVersionInput(e.target.value)}
                    placeholder="e.g. 0.4.5"
                    style={{
                      width: '100%',
                      minHeight: 42,
                      borderRadius: 14,
                      border: '1px solid var(--hair)',
                      background: 'var(--card-bg)',
                      color: 'var(--ink)',
                      padding: '0 14px',
                      fontSize: 13.5,
                      fontFamily: MONO,
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 5 }}>
                    Upload Binary File (.bin)
                  </label>
                  <input
                    type="file"
                    accept=".bin"
                    disabled={fwUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleFwUpload(f);
                    }}
                    style={{
                      width: '100%',
                      fontSize: 13,
                      color: 'var(--ink)',
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 5 }}>
                    Release Notes / Changelog
                  </label>
                  <textarea
                    value={fwNotesInput}
                    onChange={(e) => setFwNotesInput(e.target.value)}
                    placeholder="Release features, bug fixes, or hardware updates..."
                    rows={3}
                    style={{
                      width: '100%',
                      borderRadius: 14,
                      border: '1px solid var(--hair)',
                      background: 'var(--card-bg)',
                      color: 'var(--ink)',
                      padding: '10px 14px',
                      fontSize: 13,
                    }}
                  />
                </div>

                {otaStatusMsg ? (
                  <div style={{ padding: '10px 14px', borderRadius: 14, background: 'rgba(31,157,85,.12)', color: GREEN, fontSize: 12.5, fontWeight: 700 }}>
                    {otaStatusMsg}
                  </div>
                ) : null}
                {otaErrorMsg ? (
                  <div style={{ padding: '10px 14px', borderRadius: 14, background: 'rgba(255,86,60,.12)', color: RED, fontSize: 12.5, fontWeight: 700 }}>
                    {otaErrorMsg}
                  </div>
                ) : null}
              </div>
            </Card>

            {/* ---- Trigger & Deploy OTA Updates ---- */}
            <Card style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Kicker right={<Pill>{selected ? selected.wheelchair_id : 'Select Chair'}</Pill>}>
                Deploy OTA Firmware Update
              </Kicker>

              {fwReleases.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  No firmware releases registered in database yet. Upload a .bin release to begin.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                      Select Registered Release
                      {selectedId ? (
                        <span style={{ fontWeight: 500, textTransform: 'none' }}>
                          {' '}· installable on {selectedId}
                        </span>
                      ) : null}
                    </label>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {releasesForSelected.length === 0 ? (
                        <span style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                          No release has been built for {selectedId ?? 'this chair'} yet. Every image
                          carries its own DEVICE_ID and key, so a build for another chair cannot be
                          installed here.
                        </span>
                      ) : null}
                      {releasesForSelected.map((r) => (
                        <div
                          key={r.id}
                          onClick={() => setSelectedFwId(r.id)}
                          style={{
                            padding: '12px 14px',
                            borderRadius: 14,
                            border: `1px solid ${selectedFwId === r.id ? 'var(--accent)' : 'var(--hair)'}`,
                            background: selectedFwId === r.id ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            cursor: 'pointer',
                          }}
                        >
                          <div>
                            <span style={{ fontWeight: 800, fontSize: 14, fontFamily: MONO }}>v{r.version}</span>
                            <span
                              style={{
                                marginLeft: 8,
                                padding: '2px 7px',
                                borderRadius: 999,
                                fontSize: 10.5,
                                fontWeight: 800,
                                background: r.device_id ? 'var(--tint-bg)' : 'color-mix(in srgb, var(--ink) 8%, transparent)',
                                color: r.device_id ? 'var(--accent)' : 'var(--muted)',
                              }}
                            >
                              {r.device_id ?? 'universal'}
                            </span>
                            <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--muted)' }}>
                              ({(r.size / 1024 / 1024).toFixed(2)} MB)
                            </span>
                            {r.notes ? (
                              <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                                {r.notes}
                              </span>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteRelease(r.id, r.version);
                            }}
                            style={{
                              border: 0,
                              background: 'transparent',
                              color: RED,
                              fontSize: 12,
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Target Wheelchair Progress Status */}
                  {selected ? (
                    <div style={{ padding: 14, borderRadius: 16, border: '1px solid var(--hair)', background: 'var(--tint-bg)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700 }}>
                        <span>Target: {selected.wheelchair_id}</span>
                        <span>Current: v{selected.fw_version ?? '0.4.5'}</span>
                      </div>
                      <div style={{ height: 8, borderRadius: 999, background: TRACK, overflow: 'hidden' }}>
                        <span
                          style={{
                            display: 'block',
                            height: '100%',
                            borderRadius: 999,
                            background: 'var(--accent)',
                            width: `${selected.ota_progress ?? 0}%`,
                            transition: 'width .4s ease',
                          }}
                        />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)' }}>
                        <span>Status: {selected.ota_status || 'idle'}</span>
                        <span>{selected.ota_progress ?? 0}%</span>
                      </div>
                    </div>
                  ) : null}

                  {/* Rollout Options */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={otaRolloutFleetWide}
                        onChange={(e) => setOtaRolloutFleetWide(e.target.checked)}
                      />
                      <span>Deploy Staged Rollout to Entire Fleet</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={otaMaintenanceOverride}
                        onChange={(e) => setOtaMaintenanceOverride(e.target.checked)}
                      />
                      <span>Force Maintenance Override & Immediate Download</span>
                    </label>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handlePushOTA()}
                    disabled={otaDeploying || !selectedId || !selectedFwId}
                    style={{
                      minHeight: 50,
                      borderRadius: 16,
                      border: 0,
                      background: 'var(--accent)',
                      color: '#fff',
                      fontSize: 14,
                      fontWeight: 800,
                      cursor: otaDeploying || !selectedId || !selectedFwId ? 'not-allowed' : 'pointer',
                      opacity: otaDeploying || !selectedId || !selectedFwId ? 0.5 : 1,
                    }}
                  >
                    {otaDeploying
                      ? 'Queuing OTA Command…'
                      : `⚡ Deploy OTA Update to ${otaRolloutFleetWide ? 'All Fleet' : selectedId || 'Selected Chair'}`}
                  </button>
                </div>
              )}
            </Card>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => router.push('/')}
          style={{
            alignSelf: 'flex-start',
            minHeight: 44,
            padding: '0 18px',
            border: '1px solid var(--hair)',
            borderRadius: 999,
            background: 'transparent',
            color: 'var(--muted)',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
        <div className="mobonly" style={{ height: 'calc(64px + env(safe-area-inset-bottom))' }} />
      </main>

      {/* ------------------------------------------------ mobile bottom nav */}
      <nav
        className="mobonly"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 720,
          background: 'var(--nav-bg)',
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
          borderTop: '1px solid var(--hair)',
          display: 'grid',
          gridTemplateColumns: 'repeat(4,1fr)',
          padding: '8px 4px calc(10px + env(safe-area-inset-bottom))',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="nb"
            data-on={tab === t.key ? '1' : '0'}
            onClick={() => setTab(t.key)}
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              minHeight: 58,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <Svg size={24} width={1.7}>
              {t.icon}
            </Svg>
            <span style={{ fontSize: 11, fontWeight: 700 }}>{t.short}</span>
            {t.key === 'events' && unacked > 0 ? (
              <span
                style={{
                  position: 'absolute',
                  top: 6,
                  right: '24%',
                  minWidth: 18,
                  height: 18,
                  padding: '0 5px',
                  borderRadius: 999,
                  background: 'var(--accent)',
                  color: '#fff',
                  fontSize: 10.5,
                  fontWeight: 700,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                {unacked}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {/* ------------------------------------------------- incident stack */}
      {visibleIncidents.length > 0 ? (
        <div
          style={{
            position: 'fixed',
            zIndex: 820,
            right: 12,
            left: 12,
            top: `calc(${stackTop}px + env(safe-area-inset-top))`,
            bottom: 'calc(86px + env(safe-area-inset-bottom))',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            pointerEvents: 'none',
            maxWidth: 400,
            marginLeft: 'auto',
          }}
        >
          <div style={{ pointerEvents: 'auto', flex: 'none', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <span
              style={{
                marginRight: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                minHeight: 36,
                padding: '0 13px',
                borderRadius: 999,
                background: '#c8281a',
                color: '#fff',
                fontSize: 12.5,
                fontWeight: 800,
                boxShadow: '0 6px 18px rgba(10,12,20,.28)',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: '#fff',
                  animation: 'beat 1.1s ease-in-out infinite',
                }}
              />
              {visibleIncidents.length} {visibleIncidents.length === 1 ? 'alarm' : 'alarms'}
            </span>
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              style={{
                minHeight: 36,
                padding: '0 14px',
                border: '1px solid var(--hair)',
                borderRadius: 999,
                background: 'var(--float-bg)',
                color: 'var(--ink)',
                fontSize: 12.5,
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 6px 18px rgba(10,12,20,.22)',
                whiteSpace: 'nowrap',
              }}
            >
              {muted ? 'Sound off' : 'Sound on'}
            </button>
            <button
              type="button"
              onClick={dismissAllIncidents}
              style={{
                minHeight: 36,
                padding: '0 14px',
                border: '1px solid var(--hair)',
                borderRadius: 999,
                background: 'var(--float-bg)',
                color: 'var(--ink)',
                fontSize: 12.5,
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 6px 18px rgba(10,12,20,.22)',
                whiteSpace: 'nowrap',
              }}
            >
              Dismiss all
            </button>
          </div>

          <div
            className="noscroll"
            style={{
              pointerEvents: 'auto',
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {visibleIncidents.map((inc) => {
              const isSilenced = silenced.has(inc.key);
              return (
                <div
                  key={inc.key}
                  className="pop"
                  style={{
                    borderRadius: 18,
                    background: '#c8281a',
                    color: '#fff',
                    padding: '13px 14px',
                    boxShadow: '0 12px 34px rgba(10,12,20,.4)',
                    border: '1px solid rgba(255,255,255,.16)',
                    flex: 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        width: 34,
                        height: 34,
                        flex: 'none',
                        borderRadius: 11,
                        background: 'rgba(255,255,255,.18)',
                        display: 'grid',
                        placeItems: 'center',
                        animation: isSilenced ? 'none' : 'beat 1.1s ease-in-out infinite',
                      }}
                    >
                      <Svg size={19} width={1.9}>
                        {inc.kind === 'tamper' ? ICON.tamper : inc.kind === 'fault' ? ICON.fall : ICON.offline}
                      </Svg>
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 800, fontSize: 14.5 }}>{inc.title}</span>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12,
                          opacity: 0.88,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {inc.chairId} · {clockOf(inc.at)}
                      </span>
                    </span>
                    <span style={{ flex: 'none', fontFamily: MONO, fontSize: 15, fontWeight: 700 }}>{inc.value}</span>
                  </div>
                  <p style={{ margin: '8px 0 10px', fontSize: 12.5, lineHeight: 1.45, opacity: 0.92 }}>{inc.detail}</p>
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => openChairTab(inc.chairId)}
                      style={{
                        flex: 1,
                        minWidth: 88,
                        minHeight: 38,
                        border: 0,
                        borderRadius: 999,
                        background: '#fff',
                        color: '#c8281a',
                        fontSize: 12.5,
                        fontWeight: 800,
                        cursor: 'pointer',
                      }}
                    >
                      Open chair
                    </button>
                    <button
                      type="button"
                      onClick={() => silenceIncident(inc.key)}
                      disabled={isSilenced}
                      style={{
                        flex: 'none',
                        minHeight: 38,
                        padding: '0 13px',
                        border: '1px solid rgba(255,255,255,.42)',
                        borderRadius: 999,
                        background: 'transparent',
                        color: '#fff',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: isSilenced ? 'default' : 'pointer',
                        opacity: isSilenced ? 0.7 : 1,
                      }}
                    >
                      {isSilenced ? 'Muted' : 'Silence'}
                    </button>
                    <button
                      type="button"
                      onClick={() => dismissIncident(inc.key)}
                      style={{
                        flex: 'none',
                        minHeight: 38,
                        padding: '0 13px',
                        border: '1px solid rgba(255,255,255,.42)',
                        borderRadius: 999,
                        background: 'transparent',
                        color: '#fff',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------- fleet picker sheet */}
      {fleetSheetOpen ? (
        <div
          className="fade"
          onClick={() => setFleetSheetOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 740,
            background: 'rgba(10,12,20,.55)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
        >
          <div
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 600,
              maxHeight: '84vh',
              background: 'var(--card-bg)',
              color: 'var(--ink)',
              borderRadius: '30px 30px 0 0',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '20px 20px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, letterSpacing: '-.02em' }}
              >
                Select a chair
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--muted)' }}>
                {sheetRows.length} of {sorted.length}
              </span>
            </div>
            <div style={{ padding: '0 20px 12px' }}>
              <input
                value={sheetQuery}
                onChange={(e) => setSheetQuery(e.target.value)}
                placeholder="Search a chair id…"
                aria-label="Search chairs"
                autoFocus
                style={{
                  width: '100%',
                  minHeight: 48,
                  borderRadius: 16,
                  border: '1px solid var(--hair)',
                  background: 'transparent',
                  color: 'var(--ink)',
                  padding: '0 16px',
                  fontSize: 15,
                }}
              />
            </div>
            <div className="noscroll" style={{ overflowY: 'auto', borderTop: '1px solid var(--hair)' }}>
              {sheetRows.length === 0 ? (
                <div style={{ padding: '28px 20px', fontSize: 13.5, color: 'var(--muted)' }}>
                  No chair matches that search.
                </div>
              ) : (
                sheetRows.map((d) => {
                  const meta = STATUS_META[statusOf(d, now)];
                  return (
                    <button
                      key={d.wheelchair_id}
                      type="button"
                      className="row"
                      onClick={() => {
                        pickChair(d.wheelchair_id);
                        setFleetSheetOpen(false);
                      }}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '14px 20px',
                        border: 0,
                        borderBottom: '1px solid var(--hair)',
                        background: d.wheelchair_id === selectedId ? 'var(--tint-bg)' : 'transparent',
                        color: 'var(--ink)',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: meta.dot, flex: 'none' }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 700, fontSize: 15.5 }}>{d.wheelchair_id}</span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 12.5,
                            color: 'var(--muted)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {meta.label} · {d.session_state} · {timeAgo(d.ts)}
                        </span>
                      </span>
                      <span style={{ flex: 'none', fontWeight: 800, fontSize: 14 }}>{battLabel(d.batt_pct)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
