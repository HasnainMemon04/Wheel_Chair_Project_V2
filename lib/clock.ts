'use client';

import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Server-clock reference.
//
// Online/offline is decided by comparing device_state.ts (written by the
// SERVER) against "now". If "now" is the browser's wall clock, any skew
// between the two machines corrupts the answer — a PC running two minutes
// behind makes 1-second-old telemetry look like it arrived in the future, and
// a PC running fast makes a live chair look stale.
//
// So we measure the offset once on load (and periodically after), and every
// freshness comparison uses serverNow() instead of Date.now().
// ---------------------------------------------------------------------------

let skewMs = 0;
let measured = false;

/** Browser time corrected onto the database server's clock. */
export function serverNow(): number {
  return Date.now() + skewMs;
}

/** How far the browser clock is behind (+) or ahead (-) of the server, in ms. */
export function clockSkewMs(): number {
  return skewMs;
}

export function clockSynced(): boolean {
  return measured;
}

/**
 * Measure the browser↔server offset. The server observes the request roughly
 * at the midpoint of the round trip, so we compare its timestamp against that
 * midpoint rather than against either end.
 */
export async function measureClockSkew(): Promise<void> {
  try {
    const t0 = Date.now();
    const { data, error } = await supabase.rpc('server_now');
    const t1 = Date.now();
    if (error || !data) return;

    const serverMs = Date.parse(String(data));
    if (!Number.isFinite(serverMs)) return;

    const browserMidpoint = t0 + (t1 - t0) / 2;
    skewMs = serverMs - browserMidpoint;
    measured = true;
  } catch {
    // Leave skew at 0 — isOnline() also tolerates future timestamps, so an
    // unmeasured clock degrades gracefully instead of flapping.
  }
}
