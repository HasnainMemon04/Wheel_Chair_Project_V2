'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import { measureClockSkew } from './clock';
import type { DeviceState, FleetEvent } from './types';

/** Operator-owned service record for a chair, from public.wheelchairs. */
interface ServiceRecord {
  out_of_service: boolean;
  service_note: string | null;
  service_since: string | null;
}

/**
 * Pull a chair out of service, or put it back. Operator-only — RLS rejects the
 * write for anyone whose profile role is not 'operator', so this cannot be
 * driven from a rider's console.
 */
export async function setServiceMode(
  wheelchairId: string,
  outOfService: boolean,
  note?: string,
): Promise<{ ok: boolean; message?: string }> {
  const { error } = await supabase
    .from('wheelchairs')
    .update({
      out_of_service: outOfService,
      service_note: outOfService ? (note?.trim() || null) : null,
      service_since: outOfService ? new Date().toISOString() : null,
    })
    .eq('id', wheelchairId);

  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// Live fleet state over the SAME Supabase `device_state` + `events` tables the
// ESP32 writes. Realtime subscription + refetch-on-(re)subscribe so a network
// blip can't leave the UI showing stale rows.
export function useFleetState() {
  const [rawStates, setRawStates] = useState<DeviceState[]>([]);
  const [service, setService] = useState<Record<string, ServiceRecord>>({});
  const [events, setEvents] = useState<FleetEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState<number>(Date.now());

  useEffect(() => {
    const tickTimer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(tickTimer);
  }, []);

  useEffect(() => {
    let active = true;

    const readService = (row: Record<string, unknown>): ServiceRecord => ({
      out_of_service: row.out_of_service === true,
      service_note: (row.service_note as string | null) ?? null,
      service_since: (row.service_since as string | null) ?? null,
    });

    const fetchFleet = async (initial: boolean) => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
      if (!url || url.includes('YOUR-PROJECT') || url.includes('placeholder-project')) {
        setLoading(false);
        setError('Supabase is not configured. Copy .env.example to .env.local and set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.');
        return;
      }
      try {
        if (initial) setLoading(true);
        // An empty result here means "not signed in" — RLS restricts every
        // fleet table to authenticated roles. That is the correct answer, not
        // a failure to route around: the fix is to sign in, and the login
        // screen is already what an unauthenticated visitor sees.
        const { data: states, error: sErr } = await supabase.from('device_state').select('*');
        if (sErr) throw sErr;

        const { data: chairs, error: cErr } = await supabase
          .from('wheelchairs').select('id, out_of_service, service_note, service_since');
        if (cErr) throw cErr;

        const { data: evs, error: eErr } = await supabase
          .from('events').select('*').order('ts', { ascending: false }).limit(40);
        if (eErr) throw eErr;
        if (active) {
          setRawStates((states as DeviceState[]) || []);
          setService(Object.fromEntries(
            ((chairs as Record<string, unknown>[]) || []).map((c) => [c.id as string, readService(c)]),
          ));
          setEvents((evs as FleetEvent[]) || []);
          setError(null);
        }
      } catch (err: unknown) {
        const e = err as { message?: string };
        if (active) setError(e?.message || String(err));
      } finally {
        if (active) setLoading(false);
      }
    };

    // Freshness math compares server-written timestamps against "now", so the
    // browser↔server clock offset must be known before that answer is
    // trustworthy. Measure it first, then keep it corrected every 5 minutes.
    void measureClockSkew().finally(() => { if (active) fetchFleet(true); });
    const skewTimer = setInterval(() => { void measureClockSkew(); }, 300_000);

    const channel = supabase
      .channel('fleet-v2')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'device_state' }, (payload) => {
        if (!active) return;
        const row = payload.new as DeviceState;
        const old = payload.old as { wheelchair_id: string };
        setRawStates((prev) => {
          if (payload.eventType === 'DELETE') return prev.filter((d) => d.wheelchair_id !== old.wheelchair_id);
          const i = prev.findIndex((d) => d.wheelchair_id === row.wheelchair_id);
          if (i !== -1) { const next = [...prev]; next[i] = row; return next; }
          return [...prev, row];
        });
      })
      // Maintenance mode has to land on the rider's map the moment the
      // operator flips it, so the chairs table is a first-class live source
      // rather than something refetched on the next page load.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wheelchairs' }, (payload) => {
        if (!active) return;
        const row = payload.new as Record<string, unknown> | null;
        const old = payload.old as { id?: string } | null;
        setService((prev) => {
          if (payload.eventType === 'DELETE') {
            if (!old?.id) return prev;
            const next = { ...prev };
            delete next[old.id];
            return next;
          }
          if (!row || typeof row.id !== 'string') return prev;
          return { ...prev, [row.id]: readService(row) };
        });
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, (payload) => {
        if (!active) return;
        setEvents((prev) => [payload.new as FleetEvent, ...prev].slice(0, 60));
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') fetchFleet(false);
      });

    return () => { active = false; clearInterval(skewTimer); supabase.removeChannel(channel); };
  }, []);

  // Merge here rather than at the point of arrival: the two realtime streams
  // are independent, so whichever lands second must still produce a correct
  // row. Deriving the join keeps that order-independent.
  const deviceStates = useMemo<DeviceState[]>(
    () => rawStates.map((d) => {
      const s = service[d.wheelchair_id];
      if (!s) return d;
      return {
        ...d,
        out_of_service: s.out_of_service,
        service_note: s.service_note,
        service_since: s.service_since,
      };
    }),
    [rawStates, service, nowTick],
  );

  return { deviceStates, events, loading, error };
}
