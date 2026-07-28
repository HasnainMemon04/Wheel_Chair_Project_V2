'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { distanceM } from './format';
import type { DeviceState, Geofence } from './types';

// Named geofence zones, live. A zone drawn in the operator console appears in
// the rider app immediately via Realtime.
export function useGeofences() {
  const [zones, setZones] = useState<Geofence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('geofences')
      .select('*')
      .order('created_at', { ascending: true });
    if (err) {
      setError(err.message);
      return;
    }
    setZones((data as Geofence[]) ?? []);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;

    void (async () => {
      await reload();
      if (active) setLoading(false);
    })();

    const channel = supabase
      .channel('geofences-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'geofences' }, () => {
        if (active) void reload();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && active) void reload();
      });

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [reload]);

  return { zones, loading, error, reload };
}

/** Zones a chair is currently inside (a chair can sit in overlapping zones). */
export function zonesContaining(
  d: Pick<DeviceState, 'lat' | 'lng'>,
  zones: Geofence[],
): Geofence[] {
  if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return [];
  const at: [number, number] = [d.lat, d.lng];
  return zones.filter(
    (z) => z.active && distanceM(at, [z.center_lat, z.center_lng]) <= z.radius_m,
  );
}

/** Nearest active zone plus how far outside it the point is (0 when inside). */
export function nearestZone(
  lat: number,
  lng: number,
  zones: Geofence[],
): { zone: Geofence; metresOutside: number } | null {
  let best: { zone: Geofence; metresOutside: number } | null = null;
  for (const z of zones) {
    if (!z.active) continue;
    const d = distanceM([lat, lng], [z.center_lat, z.center_lng]);
    const outside = Math.max(0, d - z.radius_m);
    if (!best || outside < best.metresOutside) best = { zone: z, metresOutside: outside };
  }
  return best;
}
