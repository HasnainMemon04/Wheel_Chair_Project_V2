'use client';

import type { DeviceState } from './types';

// ---------------------------------------------------------------------------
// Position resolution.
//
// A chair's position has three possible provenances, and the two audiences
// need different things from them:
//
//   'gps'        live satellite fix.
//   'estimated'  no fix (typically indoors). The DEVICE anchors at its last
//                real fix and wanders within a few metres; we smooth the
//                hand-over so the marker never teleports.
//   'last-known' no fix and no live telemetry at all — the chair is offline,
//                so we fall back to the last real fix stored in Supabase.
//
// The RIDER is never shown any of this: they just see their chair where it
// plausibly is, moving naturally. The OPERATOR is always shown the truth,
// because dispatching someone to an estimated position is a different
// decision from dispatching to a confirmed one.
// ---------------------------------------------------------------------------

export type PositionSource = 'gps' | 'estimated' | 'last-known' | 'unknown';

export interface ResolvedPosition {
  lat: number;
  lng: number;
  source: PositionSource;
  /** Rough radius of uncertainty in metres, for the operator's accuracy ring. */
  accuracyM: number;
  /** Age of the last real satellite fix, in ms (null if never fixed). */
  fixAgeMs: number | null;
}

const METERS_PER_DEG_LAT = 111320;

export function metersToLatLng(
  lat: number,
  northM: number,
  eastM: number,
): [number, number] {
  const dLat = northM / METERS_PER_DEG_LAT;
  const dLng = eastM / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return [dLat, dLng];
}

function hasCoords(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return (
    typeof lat === 'number' && typeof lng === 'number'
    && Number.isFinite(lat) && Number.isFinite(lng)
    && !(lat === 0 && lng === 0)
  );
}

/**
 * What the database currently says about this chair's position, before any
 * client-side smoothing. `online` comes from the caller so freshness stays in
 * one place (lib/mapping).
 */
/**
 * Has this device achieved a REAL satellite fix since it last booted?
 *
 * Derived rather than stored: the boot instant is (telemetry ts - uptime), so
 * a stored fix older than that belongs to a previous power cycle. A chair may
 * have been carried anywhere while it was off, which is exactly why a stale
 * fix must not be presented as its position.
 */
export function hasFixedThisSession(d: DeviceState): boolean {
  if (!d.last_fix_at) return false;
  if (d.gps_fix === true && d.gps_simulated !== true) return true;
  if (d.uptime == null) return false;
  const bootAtMs = Date.parse(d.ts) - d.uptime * 1000;
  if (!Number.isFinite(bootAtMs)) return false;
  // Small tolerance for the ingest/clock jitter around the boot boundary.
  return Date.parse(d.last_fix_at) >= bootAtMs - 5000;
}

export function rawPosition(d: DeviceState, online: boolean, nowMs: number): ResolvedPosition | null {
  const fixAgeMs = d.last_fix_at ? Math.max(0, nowMs - Date.parse(d.last_fix_at)) : null;

  // Live but never fixed in this power cycle: we genuinely do not know where
  // this chair is. Anything we drew would be a guess anchored to a previous
  // session, so show NOTHING until the receiver delivers its first real fix.
  if (online && !hasFixedThisSession(d)) return null;

  // Offline: nothing live to trust — use the last real fix we ever stored.
  if (!online) {
    if (hasCoords(d.last_fix_lat, d.last_fix_lng)) {
      return {
        lat: d.last_fix_lat as number,
        lng: d.last_fix_lng as number,
        source: 'last-known',
        accuracyM: 25,
        fixAgeMs,
      };
    }
    if (hasCoords(d.lat, d.lng)) {
      return { lat: d.lat as number, lng: d.lng as number, source: 'last-known', accuracyM: 40, fixAgeMs };
    }
    return null;
  }

  // Live and holding a real fix.
  if (d.gps_fix === true && d.gps_simulated !== true && hasCoords(d.lat, d.lng)) {
    const hdop = d.hdop ?? 1.5;
    return {
      lat: d.lat as number,
      lng: d.lng as number,
      source: 'gps',
      accuracyM: Math.max(3, Math.min(30, hdop * 4)),
      fixAgeMs: 0,
    };
  }

  // Live but no fix: the device is already publishing a bounded wander around
  // its own last anchor, so prefer that — it is continuous and physically
  // plausible. Fall back to the stored fix if the device sent nothing usable.
  if (hasCoords(d.lat, d.lng)) {
    return { lat: d.lat as number, lng: d.lng as number, source: 'estimated', accuracyM: 12, fixAgeMs };
  }
  if (hasCoords(d.last_fix_lat, d.last_fix_lng)) {
    return {
      lat: d.last_fix_lat as number,
      lng: d.last_fix_lng as number,
      source: 'estimated',
      accuracyM: 20,
      fixAgeMs,
    };
  }
  return null;
}

// --- smoothing ------------------------------------------------------------

interface Track {
  lat: number;
  lng: number;
  source: PositionSource;
  /** Set while easing from one provenance to another. */
  blendFrom: { lat: number; lng: number } | null;
  blendStart: number;
}

const BLEND_MS = 2200; // hand-over easing; long enough to read as movement

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Stateful smoother. Keeps one track per chair so a change of provenance
 * (fix acquired / fix lost) glides instead of snapping — the rider should
 * never see the marker jump when the chair walks through a door.
 *
 * Deliberately a plain class, not a hook: the operator console and the rider
 * app each own one instance and drive it from their existing 1 Hz tick.
 */
export class PositionSmoother {
  private tracks = new Map<string, Track>();

  resolve(d: DeviceState, online: boolean, nowMs: number): ResolvedPosition | null {
    const raw = rawPosition(d, online, nowMs);
    if (!raw) {
      this.tracks.delete(d.wheelchair_id);
      return null;
    }

    const prev = this.tracks.get(d.wheelchair_id);

    // First sighting: adopt the position as-is.
    if (!prev) {
      this.tracks.set(d.wheelchair_id, {
        lat: raw.lat,
        lng: raw.lng,
        source: raw.source,
        blendFrom: null,
        blendStart: 0,
      });
      return raw;
    }

    // Provenance changed (e.g. estimated -> gps when the chair steps outside).
    // Ease from wherever the marker currently is to the new truth.
    if (prev.source !== raw.source) {
      prev.blendFrom = { lat: prev.lat, lng: prev.lng };
      prev.blendStart = nowMs;
      prev.source = raw.source;
    }

    let lat = raw.lat;
    let lng = raw.lng;

    if (prev.blendFrom) {
      const t = (nowMs - prev.blendStart) / BLEND_MS;
      if (t >= 1) {
        prev.blendFrom = null;
      } else {
        const k = easeInOut(Math.max(0, t));
        lat = prev.blendFrom.lat + (raw.lat - prev.blendFrom.lat) * k;
        lng = prev.blendFrom.lng + (raw.lng - prev.blendFrom.lng) * k;
      }
    }

    prev.lat = lat;
    prev.lng = lng;
    return { ...raw, lat, lng };
  }

  forget(chairId: string): void {
    this.tracks.delete(chairId);
  }
}

export const SOURCE_LABEL: Record<PositionSource, string> = {
  gps: 'GPS fix',
  estimated: 'Estimated',
  'last-known': 'Last known',
  unknown: 'No position',
};

export const SOURCE_COLOR: Record<PositionSource, string> = {
  gps: '#1f9d55',
  estimated: '#f0b429',
  'last-known': '#9b99a6',
  unknown: '#9b99a6',
};
