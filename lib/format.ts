import { serverNow } from './clock';

// Rates from HANDOFF.md: SAR 15 unlock + SAR 1.50/min, capped SAR 150/day.
export const UNLOCK_FEE = 15;
export const PER_MIN = 1.5;
export const DAY_CAP = 150;

export function sar(n: number): string {
  return `SAR ${n.toFixed(2)}`;
}

export function estimateFee(seconds: number): number {
  const mins = Math.ceil(Math.max(0, seconds) / 60);
  return Math.min(DAY_CAP, UNLOCK_FEE + mins * PER_MIN);
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function fmtDist(meters: number): string {
  if (meters < 950) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function walkMins(meters: number): string {
  const m = Math.max(1, Math.round(meters / 80)); // ~80 m/min walking
  return `${m} min`;
}

// Haversine distance in metres.
export function distanceM(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function timeAgo(iso: string): string {
  // serverNow(), not Date.now(): `iso` is a server-written timestamp, so a
  // skewed browser clock would otherwise report a bogus age.
  const s = Math.max(0, Math.floor((serverNow() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
